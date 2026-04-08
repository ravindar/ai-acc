import {
  AdapterBusyError,
  AdapterConfigurationError,
  AdapterInterruptedError,
  type AdapterToolDefinition,
  type AdapterToolResult,
  type AgentAdapter,
  type AgentEvent,
  type SendInputResult,
} from "@acc/adapter-sdk";
import { getContextWindow } from "@acc/pricing";
import type { AgentSessionRecord, AgentState, ContextItemRecord, ProviderId, WorkspaceRecord } from "@acc/shared-types";

import type { CoordinationService } from "./coordination-state.js";
import type { EventService } from "./events/service.js";
import type { Repositories } from "./repositories.js";

// Fallback context window limits when pricing lookup fails (chars = tokens × ~4)
const PROVIDER_CONTEXT_CHARS: Record<string, number> = {
  claude: 200_000 * 4,   // 200k tokens
  codex: 32_000 * 4,     // 32k tokens
  mock: 100_000 * 4,
};

function getContextCharLimit(provider: string, model: string): number {
  const fromPricing = getContextWindow(model, 0);
  if (fromPricing > 0) return fromPricing * 4;
  return PROVIDER_CONTEXT_CHARS[provider] ?? 32_000 * 4;
}

function truncateContextItems(
  items: Array<{ id: string; type: ContextItemRecord["type"]; value: string }>,
  charLimit: number,
): Array<{ id: string; type: ContextItemRecord["type"]; value: string }> {
  const totalChars = items.reduce((sum, i) => sum + i.value.length, 0);
  const limit = Math.floor(charLimit * 0.8);
  if (totalChars <= limit) return items;

  // Priority: items with these id suffixes are dropped first (index 0 = lowest priority)
  const DROP_ORDER = [
    ":workspace-memory",
    ":shared-context-kv",
    ":coordination-brief",
    ":coordination-agent-brief",
    ":private-memory",
    ":unread-messages",
    ":shared-context",
  ];

  let remaining = [...items];
  for (const suffix of DROP_ORDER) {
    if (remaining.reduce((s, i) => s + i.value.length, 0) <= limit) break;
    remaining = remaining.filter((i) => !i.id.endsWith(suffix));
  }

  return remaining;
}

type LoggerLike = Pick<Console, "error" | "info" | "warn">;

type RuntimeHandle = {
  agentId: string;
  workspaceId: string;
  provider: ProviderId;
  sessionId: string;
  adapter: AgentAdapter;
  unsubscribe: () => Promise<void>;
  lastKnownState: AgentState;
};

type HttpError = Error & {
  statusCode: number;
  code?: string;
};

const RECOVERABLE_RUNTIME_STATES = new Set<AgentState>([
  "STARTING",
  "READY",
  "RUNNING",
  // WAITING_INPUT is intentionally excluded: the LLM has already finished generating and the run
  // is simply parked waiting for the next user message. There is no live provider stream to tear
  // down, and the agent should stay in WAITING_INPUT after a restart so the team ask card is
  // preserved until the user responds.
  "IDLE",
]);

function createHttpError(message: string, statusCode: number, code?: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function systemPromptFromMetadata(agent: AgentSessionRecord): string | undefined {
  return typeof agent.metadata.systemPrompt === "string" ? agent.metadata.systemPrompt : undefined;
}

function roleFromMetadata(agent: AgentSessionRecord): string | undefined {
  return typeof agent.metadata.role === "string" ? agent.metadata.role : undefined;
}

function cwdFromMetadata(agent: AgentSessionRecord): string | undefined {
  return typeof agent.metadata.cwd === "string" ? agent.metadata.cwd : undefined;
}

function buildSystemPrompt(agent: AgentSessionRecord, workspace: WorkspaceRecord | null): string | undefined {
  const sections: string[] = [];
  const explicitPrompt = systemPromptFromMetadata(agent);
  const role = roleFromMetadata(agent);

  if (explicitPrompt?.trim()) {
    sections.push(explicitPrompt.trim());
  }

  if (role?.trim()) {
    sections.push(`Role: ${role.trim()}`);
  }

  if (workspace?.projectRoot.trim()) {
    sections.push(`Project root: ${workspace.projectRoot.trim()}`);
  }

  sections.push(
    [
      "Execution policy:",
      "- Use the available tools for reading files, searching, diffs, writing, patches, and command execution whenever those actions are needed.",
      "- If a write or shell command needs operator approval, request it through the tool call and wait for the approval result instead of asking the operator to run the command manually.",
      "- Ask the operator only for product decisions, missing requirements, clarifications, or approvals that the tool loop cannot resolve on its own.",
      "- If you need command access, prefer the command tool path over plain-text instructions like 'please run this for me'.",
      "- If you need a shell command executed on your behalf or need a tool/credential/permission you do not have, emit a structured finding with type \"command_request\" or \"access_request\" in your response metadata rather than asking the operator in plain text. Example metadata: {\"findingType\": \"command_request\", \"commandDescription\": \"npm install\"}.",
    ].join("\n"),
  );

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

async function loadRuntimeContext(
  repositories: Repositories,
  coordinationService: CoordinationService,
  agent: AgentSessionRecord,
): Promise<{
  workspace: WorkspaceRecord | null;
  cwd: string | undefined;
  contextItems: Array<{ id: string; type: ContextItemRecord["type"]; value: string }>;
}> {
  const [workspace, mountedItems, privateMemory, unreadMessages] = await Promise.all([
    repositories.workspaces.findById(agent.workspaceId),
    repositories.contexts.listMountedItems(agent.id),
    repositories.memory.listForAgent(agent.id),
    repositories.messages.listUnreadForAgent(agent.id),
  ]);
  const workspaceMemory = workspace
    ? await repositories.memory.listWorkspaceScoped(agent.workspaceId)
    : [];
  const contextItems: Array<{ id: string; type: ContextItemRecord["type"]; value: string }> = [];

  if (workspace?.sharedContext.trim()) {
    contextItems.push({
      id: `${workspace.id}:shared-context`,
      type: "text",
      value: workspace.sharedContext.trim(),
    });
  }

  const ownPrivateMemory = privateMemory.filter((b) => b.scope === "private");
  if (ownPrivateMemory.length > 0) {
    contextItems.push({
      id: `${agent.id}:private-memory`,
      type: "text",
      value: `My private memory:\n${ownPrivateMemory.map((b) => `  ${b.key}: ${b.value}`).join("\n")}`,
    });
  }

  if (workspaceMemory.length > 0) {
    const grouped = new Map<string, typeof workspaceMemory>();
    for (const b of workspaceMemory) {
      const list = grouped.get(b.agentId) ?? [];
      list.push(b);
      grouped.set(b.agentId, list);
    }
    const lines: string[] = [];
    for (const [agentId, blocks] of grouped) {
      const label = agentId === agent.id ? "me" : agentId;
      for (const b of blocks) {
        lines.push(`  [${label}] ${b.key}: ${b.value}`);
      }
    }
    if (lines.length > 0) {
      contextItems.push({
        id: `${agent.workspaceId}:workspace-memory`,
        type: "text",
        value: `Workspace shared memory:\n${lines.join("\n")}`,
      });
    }
  }

  if (unreadMessages.length > 0) {
    const msgLines = unreadMessages.map(
      (m) => `  [${m.id}] From: ${m.fromAgentId} | Subject: ${m.subject}\n    ${m.content}`,
    );
    contextItems.push({
      id: `${agent.id}:unread-messages`,
      type: "text",
      value: [
        `Unread messages from peer agents (${unreadMessages.length}):`,
        ...msgLines,
        "Use mark_message_read(messageId) to acknowledge each message after reading.",
      ].join("\n"),
    });
  }

  const packet = await coordinationService.renderExecutionPacket(agent.workspaceId, { agentId: agent.id });
  const { workspaceContext, targetContext } = packet ?? {};

  if (workspaceContext?.trim()) {
    contextItems.push({
      id: `${agent.workspaceId}:coordination-brief`,
      type: "text",
      value: workspaceContext.trim(),
    });
  }

  if (targetContext?.trim()) {
    contextItems.push({
      id: `${agent.id}:coordination-agent-brief`,
      type: "text",
      value: targetContext.trim(),
    });
  }

  if (workspace && Object.keys(workspace.sharedContextKv).length > 0) {
    contextItems.push({
      id: `${workspace.id}:shared-context-kv`,
      type: "text",
      value: `Workspace shared key-value context:\n${Object.entries(workspace.sharedContextKv).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
    });
  }

  contextItems.push(
    ...mountedItems.map((item) => ({
      id: item.id,
      type: item.type,
      value: item.value,
    })),
  );

  const charLimit = getContextCharLimit(agent.provider, agent.model);
  const truncatedItems = truncateContextItems(contextItems, charLimit);

  return {
    workspace,
    cwd: cwdFromMetadata(agent) ?? workspace?.projectRoot ?? undefined,
    contextItems: truncatedItems,
  };
}

export interface RuntimeManager {
  start(agentId: string): Promise<{ sessionId: string; state: AgentState }>;
  sendInput(
    agentId: string,
    input: {
      input?: string;
      attachments?: Array<{ type: "file" | "text"; value: string }>;
      tools?: AdapterToolDefinition[];
      toolResults?: AdapterToolResult[];
    },
  ): Promise<SendInputResult>;
  interrupt(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  recoverDetachedSessions(): Promise<number>;
}

export function createRuntimeManager(
  repositories: Repositories,
  eventService: EventService,
  coordinationService: CoordinationService,
  adapters: Record<string, AgentAdapter>,
  logger: LoggerLike = console,
): RuntimeManager {
  const runtimes = new Map<string, RuntimeHandle>();

  async function getAgent(agentId: string): Promise<AgentSessionRecord> {
    const agent = await repositories.agents.findById(agentId);

    if (!agent) {
      throw createHttpError(`Agent ${agentId} was not found.`, 404, "AGENT_NOT_FOUND");
    }

    return agent;
  }

  function getAdapter(provider: ProviderId): AgentAdapter {
    const adapter = adapters[provider];

    if (!adapter) {
      throw createHttpError(`Provider ${provider} is not configured.`, 400, "PROVIDER_UNSUPPORTED");
    }

    return adapter;
  }

  async function appendStatusChange(
    handle: RuntimeHandle,
    to: AgentState,
    reason: string,
  ): Promise<void> {
    const from = handle.lastKnownState;
    await eventService.append({
      agentId: handle.agentId,
      workspaceId: handle.workspaceId,
      provider: handle.provider,
      ts: new Date().toISOString(),
      type: "STATUS_CHANGED",
      payload: {
        from,
        to,
        reason,
      },
    });
    handle.lastKnownState = to;
  }

  async function appendRuntimeError(
    handle: RuntimeHandle,
    code: string,
    message: string,
  ): Promise<void> {
    await eventService.append({
      agentId: handle.agentId,
      workspaceId: handle.workspaceId,
      provider: handle.provider,
      ts: new Date().toISOString(),
      type: "ERROR",
      payload: {
        code,
        message,
      },
    });
    handle.lastKnownState = "ERROR";
  }

  async function cleanupRuntime(agentId: string): Promise<void> {
    const handle = runtimes.get(agentId);

    if (!handle) {
      return;
    }

    runtimes.delete(agentId);
    await handle.unsubscribe().catch((error) => {
      logger.warn(`failed to unsubscribe runtime listener for ${agentId}: ${String(error)}`);
    });
  }

  async function onAdapterEvent(handle: RuntimeHandle, event: AgentEvent): Promise<void> {
    await eventService.append({
      agentId: handle.agentId,
      workspaceId: handle.workspaceId,
      provider: handle.provider,
      ts: event.ts ?? new Date().toISOString(),
      type: event.type,
      payload: event.payload,
    });

    if (event.type === "STATUS_CHANGED") {
      const payload = event.payload as { to?: AgentState };
      if (payload.to) {
        handle.lastKnownState = payload.to;
      }
      return;
    }

    if (event.type === "SESSION_COMPLETED") {
      await cleanupRuntime(handle.agentId);
      return;
    }

    if (event.type === "ERROR") {
      handle.lastKnownState = "ERROR";
    }
  }

  async function ensureRuntime(agentId: string): Promise<RuntimeHandle> {
    const existing = runtimes.get(agentId);

    if (existing) {
      return existing;
    }

    const agent = await getAgent(agentId);
    const adapter = getAdapter(agent.provider);
    const runtimeContext = await loadRuntimeContext(repositories, coordinationService, agent);

    try {
      const session = await adapter.startSession({
        agentId: agent.id,
        model: agent.model,
        systemPrompt: buildSystemPrompt(agent, runtimeContext.workspace),
        cwd: runtimeContext.cwd,
        contextItems: runtimeContext.contextItems,
      });

      const handle: RuntimeHandle = {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        provider: agent.provider,
        sessionId: session.sessionId,
        adapter,
        unsubscribe: async () => {},
        lastKnownState: agent.state,
      };

      const unsubscribe = await adapter.streamEvents({
        sessionId: session.sessionId,
        onEvent: (event) => onAdapterEvent(handle, event),
      });
      handle.unsubscribe = unsubscribe;
      runtimes.set(agent.id, handle);

      await eventService.append({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        provider: agent.provider,
        ts: new Date().toISOString(),
        type: "SESSION_STARTED",
        payload: {
          sessionId: session.sessionId,
          model: agent.model,
        },
      });

      await appendStatusChange(handle, "READY", "Live provider session initialized");

      return handle;
    } catch (error) {
      if (error instanceof AdapterConfigurationError) {
        throw createHttpError(error.message, 400, "ADAPTER_CONFIGURATION_ERROR");
      }

      throw error;
    }
  }

  return {
    async start(agentId) {
      const handle = await ensureRuntime(agentId);
      return {
        sessionId: handle.sessionId,
        state: handle.lastKnownState,
      };
    },

    async sendInput(agentId, input) {
      const handle = await ensureRuntime(agentId);
      await appendStatusChange(handle, "RUNNING", "Processing input");

      try {
        const coordinationPacket = await coordinationService.renderExecutionPacket(handle.workspaceId, {
          agentId,
        });
        const coordinationAttachments = coordinationPacket?.content?.trim()
          ? [
              {
                type: "text" as const,
                value: `Coordination refresh:\n${coordinationPacket.content.trim()}`,
              },
            ]
          : [];
        const result = await handle.adapter.sendInput({
          sessionId: handle.sessionId,
          input: input.input,
          attachments: [...(input.attachments ?? []), ...coordinationAttachments],
          tools: input.tools,
          toolResults: input.toolResults,
        });
        await appendStatusChange(handle, "WAITING_INPUT", "Awaiting the next instruction");
        return result;
      } catch (error) {
        if (error instanceof AdapterInterruptedError) {
          await appendStatusChange(handle, "WAITING_INPUT", "Generation interrupted");
          return {};
        }

        if (error instanceof AdapterBusyError) {
          throw createHttpError(error.message, 409, "ADAPTER_BUSY");
        }

        if (error instanceof AdapterConfigurationError) {
          throw createHttpError(error.message, 400, "ADAPTER_CONFIGURATION_ERROR");
        }

        const message = error instanceof Error ? error.message : "Provider request failed";
        await appendRuntimeError(handle, "PROVIDER_REQUEST_FAILED", message);
        throw error;
      }
    },

    async interrupt(agentId) {
      const handle = runtimes.get(agentId);

      if (!handle) {
        return;
      }

      await handle.adapter.interrupt({
        sessionId: handle.sessionId,
      });
    },

    async stop(agentId) {
      const handle = runtimes.get(agentId);

      if (handle) {
        await handle.adapter.stop({
          sessionId: handle.sessionId,
        });
        await eventService.append({
          agentId: handle.agentId,
          workspaceId: handle.workspaceId,
          provider: handle.provider,
          ts: new Date().toISOString(),
          type: "SESSION_COMPLETED",
          payload: {
            outcome: "stopped",
          },
        });
        await cleanupRuntime(agentId);
        return;
      }

      const agent = await getAgent(agentId);

      if (!["STOPPED", "COMPLETED"].includes(agent.state)) {
        await eventService.append({
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          provider: agent.provider,
          ts: new Date().toISOString(),
          type: "SESSION_COMPLETED",
          payload: {
            outcome: "stopped",
          },
        });
      }
    },

    async recoverDetachedSessions() {
      const agents = await repositories.agents.list();
      const staleAgents = agents.filter((agent) => RECOVERABLE_RUNTIME_STATES.has(agent.state));

      for (const agent of staleAgents) {
        await eventService.append({
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          provider: agent.provider,
          ts: new Date().toISOString(),
          type: "ERROR",
          payload: {
            code: "CONTROL_PLANE_RESTARTED",
            message: "The embedded control plane restarted and detached the live provider session.",
          },
        });

        await eventService.append({
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          provider: agent.provider,
          ts: new Date().toISOString(),
          type: "SESSION_COMPLETED",
          payload: {
            outcome: "error",
          },
        });
      }

      if (staleAgents.length > 0) {
        logger.warn(`recovered ${staleAgents.length} detached agent session(s) after restart`);
      }

      return staleAgents.length;
    },
  };
}
