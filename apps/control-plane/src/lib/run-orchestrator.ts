import type {
  ApprovalRequestRecord,
  AgentRunRecord,
  AgentSessionRecord,
  HandoffItemRecord,
  ToolCallRecord,
  TranscriptEntryRecord,
  WorktreeRecord,
  WorkspaceRecord,
} from "@acc/shared-types";
import type { AdapterToolDefinition, AdapterToolResult } from "@acc/adapter-sdk";

import type { EventService } from "./events/service.js";
import type { CoordinationService } from "./coordination-state.js";
import { createId } from "./ids.js";
import type { Repositories } from "./repositories.js";
import type { RuntimeManager } from "./runtime-manager.js";
import type { ToolBroker, ToolExecutionResult } from "./tool-broker.js";
import type { WorktreeManager } from "./worktree-manager.js";

const MAX_TOOL_STEPS = 12;
const TOOL_EXECUTION_TIMEOUT_MS = 60_000; // 60 seconds
const MAX_SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 5_000; // 5s → 10s → 20s

function isRateLimitError(msg: string): boolean {
  return /429|rate.?limit|tokens per min/i.test(msg);
}

function isRetryableSendError(msg: string): boolean {
  return isRateLimitError(msg) || /ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket hang/i.test(msg);
}

async function withSendRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    baseDelayMs: number;
    onRetry: (attempt: number, delayMs: number, error: unknown) => Promise<void>;
  },
  logger: Pick<Console, "warn">,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (!isRetryableSendError(msg) || attempt + 1 >= options.maxAttempts) {
        throw error;
      }
      const delay = options.baseDelayMs * Math.pow(2, attempt);
      logger.warn(`[orchestrator] Retryable error (attempt ${attempt + 1}/${options.maxAttempts}): ${msg}. Retrying in ${delay}ms`);
      await options.onRetry(attempt + 1, delay, error);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

type LoggerLike = Pick<Console, "error" | "info" | "warn">;

type PendingApprovalContext = {
  approvalId: string;
  runId: string;
  agentId: string;
  workspaceId: string;
  toolCallId: string;
  nextIteration: number;
};

type ActiveRunContext = {
  runId: string;
  agentId: string;
  workspaceId: string;
  stopped: boolean;
};

export interface RunOrchestrator {
  startRun(agentId: string, prompt: string, title?: string): Promise<AgentRunRecord>;
  stopRun(runId: string): Promise<AgentRunRecord | null>;
  approve(approvalId: string, decisionMessage?: string): Promise<ApprovalRequestRecord | null>;
  deny(approvalId: string, decisionMessage?: string): Promise<ApprovalRequestRecord | null>;
  createAgentFromHandoff(handoffId: string): Promise<AgentSessionRecord | null>;
  assignHandoff(handoffId: string, agentId: string): Promise<HandoffItemRecord | null>;
  resetWorktree(agentId: string): Promise<WorktreeRecord>;
  recoverInterruptedRuns(): Promise<number>;
}

export function createRunOrchestrator(
  repositories: Repositories,
  runtimeManager: RuntimeManager,
  eventService: EventService,
  worktreeManager: WorktreeManager,
  toolBroker: ToolBroker,
  coordinationService: CoordinationService,
  logger: LoggerLike = console,
): RunOrchestrator {
  const activeRuns = new Map<string, ActiveRunContext>();
  const pendingApprovals = new Map<string, PendingApprovalContext>();

  async function refreshCoordination(workspaceId: string): Promise<void> {
    try {
      await coordinationService.refreshWorkspaceState(workspaceId);
    } catch (error) {
      logger.warn(`failed to refresh coordination state for ${workspaceId}: ${String(error)}`);
    }
  }

  /** Phase 3: after a coordination refresh, resume any agents whose dependencies just resolved. */
  async function resumeUnblockedAgents(workspaceId: string): Promise<void> {
    try {
      const unblockedIds = await coordinationService.resumeBlockedAgents(workspaceId);
      for (const agentId of unblockedIds) {
        const pendingRun = await repositories.runs.findQueuedForAgent(agentId);
        if (pendingRun) {
          activeRuns.set(pendingRun.id, {
            runId: pendingRun.id,
            agentId,
            workspaceId,
            stopped: false,
          });
          void continueRun(pendingRun.id, agentId, { input: pendingRun.prompt }, 0);
        }
      }
    } catch (error) {
      logger.warn(`failed to resume unblocked agents for ${workspaceId}: ${String(error)}`);
    }
  }

  async function getAgentAndWorkspace(agentId: string): Promise<{ agent: AgentSessionRecord; workspace: WorkspaceRecord }> {
    const agent = await repositories.agents.findById(agentId);

    if (!agent) {
      throw new Error(`Agent ${agentId} was not found.`);
    }

    const workspace = await repositories.workspaces.findById(agent.workspaceId);

    if (!workspace) {
      throw new Error(`Workspace ${agent.workspaceId} was not found.`);
    }

    return { agent, workspace };
  }

  async function appendTranscript(
    entry: Omit<TranscriptEntryRecord, "seq"> & { seq?: number },
  ): Promise<TranscriptEntryRecord> {
    const transcriptEntry = await repositories.transcript.append({
      ...entry,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      metadata: entry.metadata ?? {},
    });
    await refreshCoordination(entry.workspaceId);
    return transcriptEntry;
  }

  async function setRunState(
    runId: string,
    state: AgentRunRecord["state"],
    errorMessage?: string,
  ): Promise<void> {
    await repositories.runs.updateState(runId, {
      state,
      errorMessage,
      completedAt: ["COMPLETED", "ERROR", "STOPPED"].includes(state) ? new Date().toISOString() : undefined,
    });
  }

  async function ensureWorktreeForRun(
    agent: AgentSessionRecord,
    workspace: WorkspaceRecord,
  ): Promise<WorktreeRecord | null> {
    const inspection = await worktreeManager.inspectProjectRoot(workspace.projectRoot);

    if (!inspection.enabled) {
      return null;
    }

    return worktreeManager.ensureAgentWorktree(agent, workspace);
  }

  function buildAdapterTools(
    toolDefinitions: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>,
  ): AdapterToolDefinition[] {
    return toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  function toAdapterToolResult(providerCallId: string, result: ToolExecutionResult): AdapterToolResult {
    return {
      callId: providerCallId,
      output: result.output,
      isError: result.status !== "completed",
    };
  }

  async function appendToolRequestedEvent(
    agent: AgentSessionRecord,
    workspaceId: string,
    toolCall: ToolCallRecord,
  ): Promise<void> {
    await eventService.append({
      agentId: agent.id,
      workspaceId,
      provider: agent.provider,
      ts: new Date().toISOString(),
      type: "TOOL_CALL_STARTED",
      payload: {
        callId: toolCall.id,
        toolName: toolCall.toolName,
        input: toolCall.input,
      },
    });
  }

  async function appendToolFinishedEvent(
    agent: AgentSessionRecord,
    workspaceId: string,
    toolCall: ToolCallRecord,
    result: ToolExecutionResult,
  ): Promise<void> {
    await eventService.append({
      agentId: agent.id,
      workspaceId,
      provider: agent.provider,
      ts: new Date().toISOString(),
      type: "TOOL_CALL_FINISHED",
      payload: {
        callId: toolCall.id,
        toolName: toolCall.toolName,
        success: result.status === "completed",
        output: result.output,
      },
    });
  }

  async function handleToolResult(
    run: AgentRunRecord,
    agent: AgentSessionRecord,
    toolCall: ToolCallRecord,
    result: ToolExecutionResult,
  ): Promise<ToolCallRecord> {
    const updated = await repositories.toolCalls.update(toolCall.id, {
      status: result.status,
      output: result.output,
    });

    await appendTranscript({
      id: createId("tr"),
      runId: run.id,
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      entryType: "tool",
      content: `${toolCall.toolName} completed with status ${result.status}.`,
      metadata: {
        toolName: toolCall.toolName,
        output: result.output,
        artifactIds: result.artifactIds ?? [],
      },
      createdAt: new Date().toISOString(),
    });

    await appendToolFinishedEvent(agent, run.workspaceId, updated ?? toolCall, result);
    return updated ?? toolCall;
  }

  async function executeToolCallWithTimeout(
    run: AgentRunRecord,
    agent: AgentSessionRecord,
    workspace: WorkspaceRecord,
    worktree: WorktreeRecord | null,
    toolCall: ToolCallRecord,
  ): Promise<ToolExecutionResult> {
    const context = { run, agent, workspace, worktree };
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Tool ${toolCall.toolName} timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)),
        TOOL_EXECUTION_TIMEOUT_MS,
      ),
    );
    return Promise.race([toolBroker.execute(context, toolCall), timeoutPromise]);
  }

  async function executeToolCall(
    run: AgentRunRecord,
    agent: AgentSessionRecord,
    workspace: WorkspaceRecord,
    worktree: WorktreeRecord | null,
    toolCall: ToolCallRecord,
  ): Promise<{ persistedToolCall: ToolCallRecord; result: ToolExecutionResult }> {
    const runningCall =
      (await repositories.toolCalls.update(toolCall.id, {
        status: "running",
      })) ?? toolCall;

    try {
      const result = await executeToolCallWithTimeout(run, agent, workspace, worktree, runningCall);
      const persistedToolCall = await handleToolResult(run, agent, runningCall, result);
      return { persistedToolCall, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      const result: ToolExecutionResult = {
        status: "error",
        output: {
          message,
        },
      };
      const persistedToolCall = await handleToolResult(run, agent, runningCall, result);
      return { persistedToolCall, result };
    }
  }

  async function continueRun(
    runId: string,
    agentId: string,
    request: {
      input?: string;
      toolResults?: AdapterToolResult[];
    },
    iteration: number,
  ): Promise<void> {
    const active = activeRuns.get(runId);

    if (!active || active.stopped) {
      return;
    }

    if (iteration > MAX_TOOL_STEPS) {
      await setRunState(runId, "ERROR", `Run exceeded the max tool step limit (${MAX_TOOL_STEPS}).`);
      await coordinationService.onRunCompleted(active.workspaceId, agentId, runId, "error");
      await appendTranscript({
        id: createId("tr"),
        runId,
        workspaceId: active.workspaceId,
        agentId,
        entryType: "error",
        content: `Run exceeded the max tool step limit (${MAX_TOOL_STEPS}).`,
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      activeRuns.delete(runId);
      return;
    }

    const run = await repositories.runs.findById(runId);
    const lookup = await getAgentAndWorkspace(agentId);
    const worktree = await ensureWorktreeForRun(lookup.agent, lookup.workspace);
    const toolDefinitions = await toolBroker.listTools({
      workspace: lookup.workspace,
      worktree,
    });

    try {
      await setRunState(runId, "RUNNING");
      const result = await withSendRetry(
        () => runtimeManager.sendInput(agentId, {
          input: request.input,
          toolResults: request.toolResults,
          tools: buildAdapterTools(toolDefinitions),
        }),
        {
          maxAttempts: MAX_SEND_RETRY_ATTEMPTS,
          baseDelayMs: SEND_RETRY_BASE_DELAY_MS,
          onRetry: async (attempt, delayMs, retryError) => {
            const delaySec = Math.round(delayMs / 1000);
            const errMsg = retryError instanceof Error ? retryError.message : String(retryError);
            const reason = isRateLimitError(errMsg) ? "rate-limited" : "transient network error";
            await appendTranscript({
              id: createId("tr"),
              runId,
              workspaceId: active.workspaceId,
              agentId,
              entryType: "system",
              content: `Provider ${reason} — retrying in ${delaySec}s (attempt ${attempt}/${MAX_SEND_RETRY_ATTEMPTS - 1})...`,
              metadata: { retryAttempt: attempt, delayMs },
              createdAt: new Date().toISOString(),
            });
          },
        },
        logger,
      );

      const assistantText = result.assistantText?.trim() ?? "";
      if (assistantText) {
        await appendTranscript({
          id: createId("tr"),
          runId,
          workspaceId: lookup.workspace.id,
          agentId,
          entryType: "assistant",
          content: assistantText,
          metadata: {
            phase: result.toolCalls && result.toolCalls.length > 0 ? "tool-request" : "final",
          },
          createdAt: new Date().toISOString(),
        });
      }

      const toolCalls = result.toolCalls ?? [];

      if (toolCalls.length === 0) {
        if (!assistantText) {
          throw new Error("Provider returned neither assistant text nor tool calls.");
        }

        await setRunState(runId, "COMPLETED");
        await coordinationService.onRunCompleted(lookup.workspace.id, agentId, runId, "completed");
        await resumeUnblockedAgents(lookup.workspace.id);
        activeRuns.delete(runId);
        return;
      }

      // Create DB records for all requested tool calls.
      const createdToolCalls = await Promise.all(
        toolCalls.map((requestedTool) =>
          repositories.toolCalls.create({
            id: createId("tc"),
            runId,
            workspaceId: lookup.workspace.id,
            agentId,
            providerCallId: requestedTool.callId,
            approvalId: undefined,
            toolName: requestedTool.name,
            status: "requested",
            input: requestedTool.arguments,
            output: undefined,
            requestedCwd: typeof requestedTool.arguments.cwd === "string" ? requestedTool.arguments.cwd : worktree?.path,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
      );

      // Emit TOOL_CALL_STARTED events and transcript entries for all tool calls.
      await Promise.all(createdToolCalls.map((tc) => appendToolRequestedEvent(lookup.agent, lookup.workspace.id, tc)));
      for (let i = 0; i < createdToolCalls.length; i++) {
        const tc = createdToolCalls[i];
        const requestedTool = toolCalls[i];
        await appendTranscript({
          id: createId("tr"),
          runId,
          workspaceId: lookup.workspace.id,
          agentId,
          entryType: "tool",
          content: `${requestedTool.name} requested.`,
          metadata: {
            toolCallId: tc.id,
            providerCallId: requestedTool.callId,
            input: requestedTool.arguments,
          },
          createdAt: new Date().toISOString(),
        });
      }

      // Separate into approval-required and auto-execute groups.
      const firstApprovalIdx = toolCalls.findIndex((tc) => toolBroker.requiresApproval(tc.name));

      if (firstApprovalIdx >= 0) {
        // Gate on the first approval-needing tool call; auto tools in the same batch are deferred.
        if (toolCalls.length > 1) {
          logger.warn(
            `[orchestrator] ${toolCalls.length} tool calls in batch — pausing on approval for "${toolCalls[firstApprovalIdx].name}", deferring ${toolCalls.length - 1} others`,
          );
        }
        const approvalToolCall = createdToolCalls[firstApprovalIdx];
        const requestedTool = toolCalls[firstApprovalIdx];

        const approval = await repositories.approvals.create({
          id: createId("apr"),
          runId,
          workspaceId: lookup.workspace.id,
          agentId,
          toolCallId: approvalToolCall.id,
          status: "PENDING",
          requestedAction: requestedTool.name,
          requestedPayload: requestedTool.arguments,
          reason: assistantText || undefined,
          decisionMessage: undefined,
          createdAt: new Date().toISOString(),
          decidedAt: undefined,
        });

        await repositories.toolCalls.update(approvalToolCall.id, {
          approvalId: approval.id,
          status: "pending_approval",
        });
        await setRunState(runId, "WAITING_APPROVAL");
        await eventService.append({
          agentId,
          workspaceId: lookup.workspace.id,
          provider: lookup.agent.provider,
          ts: new Date().toISOString(),
          type: "STATUS_CHANGED",
          payload: {
            from: lookup.agent.state,
            to: "WAITING_APPROVAL",
            reason: `Tool ${requestedTool.name} is waiting for operator approval.`,
          },
        });
        await appendTranscript({
          id: createId("tr"),
          runId,
          workspaceId: lookup.workspace.id,
          agentId,
          entryType: "approval",
          content: `Approval required for ${requestedTool.name}.`,
          metadata: {
            approvalId: approval.id,
            input: requestedTool.arguments,
            summary: assistantText || undefined,
          },
          createdAt: new Date().toISOString(),
        });

        pendingApprovals.set(approval.id, {
          approvalId: approval.id,
          runId,
          agentId,
          workspaceId: lookup.workspace.id,
          toolCallId: approvalToolCall.id,
          nextIteration: iteration + 1,
        });
        return;
      }

      // No approval needed — execute all tool calls concurrently.
      if (toolCalls.length > 1) {
        logger.info(`[orchestrator] Executing ${toolCalls.length} tool calls in parallel`);
      }
      const runFallback: AgentRunRecord = run ?? {
        id: runId,
        workspaceId: lookup.workspace.id,
        agentId,
        title: "",
        prompt: request.input ?? "",
        state: "RUNNING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };

      const parallelResults = await Promise.allSettled(
        createdToolCalls.map((tc) =>
          executeToolCall(runFallback, lookup.agent, lookup.workspace, worktree, tc),
        ),
      );

      const adapterToolResults: AdapterToolResult[] = [];
      for (let i = 0; i < createdToolCalls.length; i++) {
        const settled = parallelResults[i];
        const tc = createdToolCalls[i];
        const requestedTool = toolCalls[i];

        if (settled.status === "fulfilled") {
          const { persistedToolCall, result: toolResult } = settled.value;
          if (toolResult.status !== "completed") {
            await coordinationService.onBlockerDetected(
              lookup.workspace.id,
              agentId,
              `Tool ${requestedTool.name} failed`,
              requestedTool.name,
            );
          }
          adapterToolResults.push(toAdapterToolResult(persistedToolCall.providerCallId ?? requestedTool.callId, toolResult));
        } else {
          // Unexpected throw from executeToolCall itself (rare — it normally catches internally).
          const errMsg = settled.reason instanceof Error ? settled.reason.message : "Tool execution failed";
          const errorResult: ToolExecutionResult = { status: "error", output: { message: errMsg } };
          await handleToolResult(runFallback, lookup.agent, tc, errorResult);
          adapterToolResults.push(toAdapterToolResult(tc.providerCallId ?? requestedTool.callId, errorResult));
        }
      }

      await continueRun(runId, agentId, { toolResults: adapterToolResults }, iteration + 1);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Run execution failed";
      const message = isRateLimitError(rawMessage)
        ? "API rate limit reached. The provider rejected the request due to token-per-minute limits. Wait a moment and try again."
        : rawMessage;
      logger.error(error);
      await setRunState(runId, "ERROR", message);
      await coordinationService.onRunCompleted(active.workspaceId, agentId, runId, "error");
      await appendTranscript({
        id: createId("tr"),
        runId,
        workspaceId: active.workspaceId,
        agentId,
        entryType: "error",
        content: message,
        metadata: isRateLimitError(rawMessage) ? { rawError: rawMessage } : {},
        createdAt: new Date().toISOString(),
      });
      activeRuns.delete(runId);
    }
  }

  async function resumeAfterApproval(
    approval: ApprovalRequestRecord,
    approved: boolean,
    decisionMessage?: string,
  ): Promise<void> {
    const pending = pendingApprovals.get(approval.id);

    if (!pending) {
      throw new Error(`Approval ${approval.id} is no longer resumable.`);
    }

    const [run, toolCall] = await Promise.all([
      repositories.runs.findById(pending.runId),
      repositories.toolCalls.findById(pending.toolCallId),
    ]);

    if (!run || !toolCall) {
      throw new Error(`Run context for approval ${approval.id} was not found.`);
    }

    const { agent, workspace } = await getAgentAndWorkspace(pending.agentId);
    const worktree = await ensureWorktreeForRun(agent, workspace);
    pendingApprovals.delete(approval.id);

    const providerCallId = toolCall.providerCallId ?? toolCall.id;

    if (!approved) {
      const deniedCall = await repositories.toolCalls.update(toolCall.id, {
        status: "denied",
        output: {
          denied: true,
          message: decisionMessage ?? "The operator denied this tool request.",
        },
      });
      await appendTranscript({
        id: createId("tr"),
        runId: run.id,
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        entryType: "approval",
        content: `Approval denied for ${toolCall.toolName}.`,
        metadata: {
          approvalId: approval.id,
          decisionMessage,
        },
        createdAt: new Date().toISOString(),
      });
      await appendToolFinishedEvent(agent, workspace.id, deniedCall ?? toolCall, {
        status: "denied",
        output: {
          denied: true,
          message: decisionMessage ?? "The operator denied this tool request.",
        },
      });
      await setRunState(run.id, "RUNNING");
      void continueRun(
        run.id,
        run.agentId,
        {
          toolResults: [
            {
              callId: providerCallId,
              output: {
                denied: true,
                message: decisionMessage ?? "The operator denied this tool request.",
              },
              isError: true,
            },
          ],
        },
        pending.nextIteration,
      );
      return;
    }

    await repositories.toolCalls.update(toolCall.id, {
      status: "approved",
    });
    const { persistedToolCall, result } = await executeToolCall(run, agent, workspace, worktree, toolCall);
    await setRunState(run.id, "RUNNING");
    void continueRun(
      run.id,
      run.agentId,
      {
        toolResults: [toAdapterToolResult(persistedToolCall.providerCallId ?? providerCallId, result)],
      },
      pending.nextIteration,
    );
  }

  return {
    async startRun(agentId, prompt, title) {
      const existing = await repositories.runs.findActiveByAgent(agentId);

      if (existing) {
        throw new Error(`Agent ${agentId} already has an active run.`);
      }

      const { agent, workspace } = await getAgentAndWorkspace(agentId);
      const now = new Date().toISOString();
      const run = await repositories.runs.create({
        id: createId("run"),
        workspaceId: workspace.id,
        agentId,
        title: title?.trim() || prompt.trim().slice(0, 96) || agent.title,
        prompt,
        state: "CREATED",
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      });

      activeRuns.set(run.id, {
        runId: run.id,
        agentId,
        workspaceId: workspace.id,
        stopped: false,
      });

      await appendTranscript({
        id: createId("tr"),
        runId: run.id,
        workspaceId: workspace.id,
        agentId,
        entryType: "user",
        content: prompt,
        metadata: {
          title: run.title,
        },
        createdAt: now,
      });

      // Phase 3: gating check — if the coordinator says wait, queue the run instead of executing
      const gate = await coordinationService.checkCanRun(workspace.id, agentId);
      if (!gate.allowed) {
        activeRuns.delete(run.id); // not actively executing
        await setRunState(run.id, "QUEUED");
        await eventService.append({
          agentId,
          workspaceId: workspace.id,
          provider: agent.provider,
          ts: new Date().toISOString(),
          type: "STATUS_CHANGED",
          payload: {
            from: agent.state,
            to: "WAITING_DEPENDENCY",
            reason: gate.reason ?? "Waiting on a dependency before this agent can run.",
          },
        });
        return run;
      }

      void continueRun(run.id, agentId, { input: prompt }, 0);
      return run;
    },

    async stopRun(runId) {
      const run = await repositories.runs.findById(runId);

      if (!run) {
        return null;
      }

      const active = activeRuns.get(runId);
      if (active) {
        active.stopped = true;
      }

      await runtimeManager.interrupt(run.agentId);
      await setRunState(runId, "STOPPED");
      await appendTranscript({
        id: createId("tr"),
        runId,
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        entryType: "system",
        content: "Run stopped by operator.",
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      activeRuns.delete(runId);
      return repositories.runs.findById(runId);
    },

    async approve(approvalId, decisionMessage) {
      const approval = await repositories.approvals.resolve(approvalId, "APPROVED", decisionMessage);

      if (!approval) {
        return null;
      }

      await refreshCoordination(approval.workspaceId);
      await resumeUnblockedAgents(approval.workspaceId);
      await resumeAfterApproval(approval, true, decisionMessage);
      return approval;
    },

    async deny(approvalId, decisionMessage) {
      const approval = await repositories.approvals.resolve(approvalId, "DENIED", decisionMessage);

      if (!approval) {
        return null;
      }

      await refreshCoordination(approval.workspaceId);
      await resumeUnblockedAgents(approval.workspaceId);
      await resumeAfterApproval(approval, false, decisionMessage);
      return approval;
    },

    async createAgentFromHandoff(handoffId) {
      const handoff = await repositories.handoffs.findById(handoffId);

      if (!handoff) {
        return null;
      }

      const now = new Date().toISOString();
      const sourceRun = await repositories.runs.findById(handoff.sourceRunId);
      const agent = await repositories.agents.create({
        id: createId("ag"),
        workspaceId: handoff.workspaceId,
        provider: handoff.recommendedProvider,
        model: handoff.recommendedModel,
        title: handoff.title,
        state: "CREATED",
        lastEventAt: now,
        heartbeatAt: now,
        usage: {
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        metadata: {
          role: handoff.title,
          initialTask: handoff.nextPrompt,
          sourceRunId: sourceRun?.id,
          handoffId: handoff.id,
          preview: handoff.summary.slice(0, 220),
          cwd: (await repositories.workspaces.findById(handoff.workspaceId))?.projectRoot ?? "",
        },
      });

      await repositories.handoffs.assign(handoff.id, agent.id);
      await coordinationService.refreshWorkspaceState(handoff.workspaceId);
      await resumeUnblockedAgents(handoff.workspaceId);
      return agent;
    },

    async assignHandoff(handoffId, agentId) {
      const handoff = await repositories.handoffs.assign(handoffId, agentId);

      if (handoff) {
        await coordinationService.refreshWorkspaceState(handoff.workspaceId);
        await resumeUnblockedAgents(handoff.workspaceId);
      }

      return handoff;
    },

    async resetWorktree(agentId) {
      const { agent, workspace } = await getAgentAndWorkspace(agentId);
      return worktreeManager.resetAgentWorktree(agent, workspace);
    },

    async recoverInterruptedRuns() {
      const agents = await repositories.agents.list();
      let recovered = 0;

      for (const agent of agents) {
        const active = await repositories.runs.findActiveByAgent(agent.id);

        if (!active) {
          continue;
        }

        recovered += 1;

        // Count how many tool steps completed so the user knows where the run was interrupted.
        const transcriptEntries = await repositories.transcript.listByRun(active.id);
        const toolStepCount = transcriptEntries.filter((e) => e.entryType === "tool").length;
        const stepInfo = toolStepCount > 0
          ? ` after ${toolStepCount} tool step${toolStepCount === 1 ? "" : "s"}`
          : "";
        const errorMsg = `Control plane restarted while this run was active${stepInfo}. Start a new run to continue.`;

        await setRunState(active.id, "ERROR", errorMsg);
        await appendTranscript({
          id: createId("tr"),
          runId: active.id,
          workspaceId: active.workspaceId,
          agentId: active.agentId,
          entryType: "system",
          content: `Run interrupted by control-plane restart at tool step ${toolStepCount}/${MAX_TOOL_STEPS}.`,
          metadata: { toolStepCount, maxToolSteps: MAX_TOOL_STEPS },
          createdAt: new Date().toISOString(),
        });
      }

      const pending = await repositories.approvals.listPending();
      const ONE_HOUR_MS = 60 * 60 * 1_000;
      let staleDenied = 0;
      for (const approval of pending) {
        const ageMs = Date.now() - new Date(approval.createdAt).getTime();
        if (ageMs >= ONE_HOUR_MS) {
          await repositories.approvals.resolve(
            approval.id,
            "DENIED",
            "The embedded control plane restarted and this approval was pending for over an hour.",
          );
          staleDenied += 1;
        }
        // Recent approvals (<1 h) are left PENDING so the operator can review them in the UI.
      }

      if (recovered > 0) {
        logger.warn(`marked ${recovered} interrupted run(s) as errored after restart`);
      }
      if (staleDenied > 0) {
        logger.warn(`auto-denied ${staleDenied} stale approval request(s) older than 1 hour`);
      }

      return recovered;
    },
  };
}
