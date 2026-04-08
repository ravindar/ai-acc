import { randomUUID } from "node:crypto";

import {
  AdapterBusyError,
  AdapterConfigurationError,
  AdapterInterruptedError,
  consumeSseStream,
  type AdapterStatus,
  type AgentAdapter,
  type AgentEvent,
  type AdapterToolCall,
  type AdapterToolDefinition,
  type SendInputResult,
  type SendInputReq,
  type StartSessionReq,
} from "@acc/adapter-sdk";
import { getPricing, getModelCapabilities } from "@acc/pricing";

async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; baseDelayMs: number; retryOn: (error: unknown) => boolean },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!options.retryOn(error)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, options.baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    // HTTP 429 (rate limit) and 503 (service unavailable) are transient
    return error.message.includes("429") || error.message.includes("503");
  }
  return false;
}

type SessionListener = (event: AgentEvent) => void | Promise<void>;

type ClaudeMessage = {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
};

type ClaudeContentAccumulator = {
  index: number;
  kind: "text" | "tool_use" | "other";
  text: string;
  toolUseId?: string;
  name?: string;
  inputText: string;
};

type ClaudeSession = {
  sessionId: string;
  agentId: string;
  model: string;
  systemPrompt?: string;
  cwd?: string;
  contextItems: StartSessionReq["contextItems"];
  history: ClaudeMessage[];
  listeners: Set<SessionListener>;
  state: AdapterStatus["state"];
  lastHeartbeatAt: string;
  heartbeatTimer: NodeJS.Timeout;
  activeRun?: {
    abortController: AbortController;
  };
};

type UsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const HEARTBEAT_INTERVAL_MS = 10_000;

function getAnthropicKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    throw new AdapterConfigurationError(
      "ANTHROPIC_API_KEY is required before a live Claude session can be started.",
    );
  }

  return apiKey;
}

function getAnthropicBaseUrl(): string {
  return (process.env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_BASE_URL).replace(/\/$/, "");
}

function getAnthropicVersion(): string {
  return process.env.ANTHROPIC_VERSION?.trim() || ANTHROPIC_VERSION;
}

function createSessionId(agentId: string): string {
  return `claude_${agentId}_${randomUUID()}`;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function buildSystemPrompt(session: ClaudeSession): string | undefined {
  const sections: string[] = [];

  if (session.systemPrompt?.trim()) {
    sections.push(session.systemPrompt.trim());
  }

  if (session.cwd?.trim()) {
    sections.push(`Working directory: ${session.cwd.trim()}`);
  }

  if (session.contextItems && session.contextItems.length > 0) {
    const contextLines = session.contextItems.map((item, index) => {
      const prefix = `${index + 1}. [${item.type}]`;
      return `${prefix} ${item.value}`;
    });
    sections.push(`Shared context:\n${contextLines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildUserMessage(input: string, attachments?: SendInputReq["attachments"]): string {
  const sections = [input.trim()];

  for (const attachment of attachments ?? []) {
    sections.push(`[Attachment:${attachment.type}] ${attachment.value}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

function buildUserBlocks(req: SendInputReq): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  if (req.toolResults && req.toolResults.length > 0) {
    for (const toolResult of req.toolResults) {
      blocks.push({
        type: "tool_result",
        tool_use_id: toolResult.callId,
        content: JSON.stringify(toolResult.output),
        is_error: toolResult.isError === true,
      });
    }
  }

  if (req.input?.trim() || (req.attachments?.length ?? 0) > 0) {
    blocks.push({
      type: "text",
      text: buildUserMessage(req.input ?? "", req.attachments),
    });
  }

  return blocks;
}

function toAnthropicTools(tools: AdapterToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];

  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") {
      continue;
    }

    if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  return parts.join("\n\n").trim();
}

function extractToolCalls(content: unknown): AdapterToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: AdapterToolCall[] = [];

  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") {
      continue;
    }

    toolCalls.push({
      callId:
        typeof block.id === "string"
          ? block.id
          : `toolu_${randomUUID()}`,
      name: typeof block.name === "string" ? block.name : "unknown_tool",
      arguments: isRecord(block.input) ? block.input : {},
    });
  }

  return toolCalls;
}

function extractUsage(payload: unknown): UsageAccumulator {
  const record = asRecord(payload);
  const usage = asRecord(record?.usage);

  return {
    inputTokens: toNumber(usage?.input_tokens ?? usage?.inputTokens),
    outputTokens: toNumber(usage?.output_tokens ?? usage?.outputTokens),
    cacheCreationInputTokens: toNumber(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: toNumber(usage?.cache_read_input_tokens),
  };
}

function extractErrorMessage(payload: unknown): string {
  const record = asRecord(payload);
  const error = asRecord(record?.error);

  if (typeof error?.message === "string") {
    return error.message;
  }

  if (typeof record?.message === "string") {
    return record.message;
  }

  return "Anthropic Messages API request failed";
}

async function createHttpError(response: Response): Promise<Error> {
  const rawText = await response.text();
  const parsed = safeParseJson(rawText);
  const message = extractErrorMessage(parsed) || rawText || `HTTP ${response.status}`;
  return new Error(message);
}

function buildContentAccumulator(index: number): ClaudeContentAccumulator {
  return {
    index,
    kind: "other",
    text: "",
    inputText: "",
  };
}

function buildAssistantContent(accumulators: Map<number, ClaudeContentAccumulator>): Array<Record<string, unknown>> {
  return [...accumulators.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (block.kind === "text") {
        return {
          type: "text",
          text: block.text,
        };
      }

      if (block.kind === "tool_use") {
        const parsedInput = safeParseJson(block.inputText);
        return {
          type: "tool_use",
          id: block.toolUseId ?? `toolu_${randomUUID()}`,
          name: block.name ?? "unknown_tool",
          input: isRecord(parsedInput) ? parsedInput : {},
        };
      }

      return {
        type: "text",
        text: block.text,
      };
    })
    .filter((block) => {
      if (block.type === "text") {
        return typeof block.text === "string" && block.text.length > 0;
      }

      return true;
    });
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "claude" as const;

  private readonly sessions = new Map<string, ClaudeSession>();

  async startSession(req: StartSessionReq): Promise<{ sessionId: string }> {
    getAnthropicKey();

    const sessionId = createSessionId(req.agentId);
    const lastHeartbeatAt = new Date().toISOString();
    const session: ClaudeSession = {
      sessionId,
      agentId: req.agentId,
      model: req.model,
      systemPrompt: req.systemPrompt,
      cwd: req.cwd,
      contextItems: req.contextItems ?? [],
      history: [],
      listeners: new Set<SessionListener>(),
      state: "ready",
      lastHeartbeatAt,
      heartbeatTimer: this.createHeartbeatTimer(sessionId),
    };

    this.sessions.set(sessionId, session);

    return { sessionId };
  }

  async sendInput(req: SendInputReq): Promise<SendInputResult> {
    const session = this.getSession(req.sessionId);

    if (session.activeRun) {
      throw new AdapterBusyError(`Claude session ${req.sessionId} is already processing input.`);
    }

    const apiKey = getAnthropicKey();
    const system = buildSystemPrompt(session);
    const abortController = new AbortController();
    const startedAt = Date.now();
    const content = buildUserBlocks(req);

    if (content.length === 0) {
      return {};
    }

    session.activeRun = {
      abortController,
    };
    session.state = "running";

    try {
      const messages = [...session.history, { role: "user" as const, content }];
      const response = await withRetry(
        () => fetch(`${getAnthropicBaseUrl()}/messages`, {
          method: "POST",
          headers: {
            "anthropic-version": getAnthropicVersion(),
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            model: session.model,
            system,
            max_tokens: getModelCapabilities(session.model)?.maxOutputTokens ?? 4096,
            messages,
            tools: toAnthropicTools(req.tools),
            tool_choice: req.tools && req.tools.length > 0 ? { type: "auto", disable_parallel_tool_use: true } : undefined,
            stream: true,
          }),
          signal: abortController.signal,
        }),
        { maxAttempts: 3, baseDelayMs: 1000, retryOn: isTransientError },
      );

      if (!response.ok) {
        throw await createHttpError(response);
      }

      let assistantText = "";
      let emittedFinalOutput = false;
      const usage: UsageAccumulator = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      const contentBlocks = new Map<number, ClaudeContentAccumulator>();

      await consumeSseStream(response, async (event) => {
        if (!event.data || event.data === "[DONE]") {
          return;
        }

        const payload = safeParseJson(event.data);
        const record = asRecord(payload);
        const eventType =
          event.event === "message" && typeof record?.type === "string" ? record.type : event.event;

        switch (eventType) {
          case "message_start": {
            const message = asRecord(record?.message);
            const streamedUsage = extractUsage(message);
            usage.inputTokens = Math.max(usage.inputTokens, streamedUsage.inputTokens);
            usage.outputTokens = Math.max(usage.outputTokens, streamedUsage.outputTokens);
            usage.cacheCreationInputTokens = Math.max(usage.cacheCreationInputTokens, streamedUsage.cacheCreationInputTokens);
            usage.cacheReadInputTokens = Math.max(usage.cacheReadInputTokens, streamedUsage.cacheReadInputTokens);
            return;
          }
          case "content_block_start": {
            const index = toNumber(record?.index);
            const block = asRecord(record?.content_block);
            const accumulator = contentBlocks.get(index) ?? buildContentAccumulator(index);

            if (block?.type === "text") {
              accumulator.kind = "text";
              accumulator.text = typeof block.text === "string" ? block.text : "";
            } else if (block?.type === "tool_use") {
              accumulator.kind = "tool_use";
              accumulator.toolUseId =
                typeof block.id === "string" ? block.id : accumulator.toolUseId ?? `toolu_${randomUUID()}`;
              accumulator.name = typeof block.name === "string" ? block.name : accumulator.name ?? "unknown_tool";
              if (isRecord(block.input) && Object.keys(block.input).length > 0) {
                accumulator.inputText = JSON.stringify(block.input);
              }
            } else {
              accumulator.kind = "other";
            }

            contentBlocks.set(index, accumulator);
            return;
          }
          case "content_block_delta": {
            const index = toNumber(record?.index);
            const delta = asRecord(record?.delta);
            const accumulator = contentBlocks.get(index) ?? buildContentAccumulator(index);

            if (delta?.type === "text_delta") {
              const textDelta = typeof delta.text === "string" ? delta.text : "";
              if (!textDelta) {
                return;
              }

              accumulator.kind = "text";
              accumulator.text += textDelta;
              assistantText += textDelta;
              contentBlocks.set(index, accumulator);

              await this.emit(session, {
                type: "OUTPUT_DELTA",
                payload: {
                  stream: "assistant",
                  text: textDelta,
                },
              });
              return;
            }

            const partialJson =
              typeof delta?.partial_json === "string"
                ? delta.partial_json
                : typeof delta?.partialJson === "string"
                  ? delta.partialJson
                  : "";

            if (delta?.type === "input_json_delta" || partialJson) {
              accumulator.kind = "tool_use";
              accumulator.inputText += partialJson;
              contentBlocks.set(index, accumulator);
            }
            return;
          }
          case "message_delta": {
            const streamedUsage = extractUsage(record);
            usage.inputTokens = Math.max(usage.inputTokens, streamedUsage.inputTokens);
            usage.outputTokens = Math.max(usage.outputTokens, streamedUsage.outputTokens);
            usage.cacheCreationInputTokens = Math.max(usage.cacheCreationInputTokens, streamedUsage.cacheCreationInputTokens);
            usage.cacheReadInputTokens = Math.max(usage.cacheReadInputTokens, streamedUsage.cacheReadInputTokens);
            return;
          }
          case "message_stop":
          case "content_block_stop":
          case "ping":
            return;
          case "error":
            throw new Error(extractErrorMessage(payload));
          default:
            return;
        }
      });

      const responseContent = buildAssistantContent(contentBlocks);
      const finalAssistantText = extractAssistantText(responseContent) || assistantText.trim();
      const toolCalls = extractToolCalls(responseContent);
      const pricing = getPricing(session.model);
      const costUsd = pricing
        ? roundCurrency(
            // Regular input tokens
            (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
            // Cache creation: 1.25× input price
            (usage.cacheCreationInputTokens / 1_000_000) * pricing.inputPerMillion * 1.25 +
            // Cache read: 0.10× input price
            (usage.cacheReadInputTokens / 1_000_000) * pricing.inputPerMillion * 0.10 +
            // Output tokens
            (usage.outputTokens / 1_000_000) * pricing.outputPerMillion,
          )
        : 0;

      session.history = [...messages, { role: "assistant", content: responseContent }];

      if (finalAssistantText && !emittedFinalOutput) {
        emittedFinalOutput = true;
        await this.emit(session, {
          type: "OUTPUT_FINAL",
          payload: {
            stream: "assistant",
            text: finalAssistantText,
          },
        });
      }

      await this.emit(session, {
        type: "USAGE_TICK",
        payload: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
          latencyMs: Date.now() - startedAt,
          metadata: {
            model: session.model,
          },
        },
      });

      session.state = "waiting_input";
      return {
        assistantText: finalAssistantText || undefined,
        toolCalls,
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        session.state = "waiting_input";
        throw new AdapterInterruptedError("Claude generation was interrupted.");
      }

      session.state = "error";
      throw error;
    } finally {
      session.lastHeartbeatAt = new Date().toISOString();
      session.activeRun = undefined;
    }
  }

  async interrupt(req: { sessionId: string }): Promise<void> {
    const session = this.getSession(req.sessionId);

    session.activeRun?.abortController.abort();
    session.state = "waiting_input";
  }

  async stop(req: { sessionId: string }): Promise<void> {
    const session = this.getSession(req.sessionId);

    session.activeRun?.abortController.abort();
    clearInterval(session.heartbeatTimer);
    session.state = "stopped";
    this.sessions.delete(req.sessionId);
  }

  async getStatus(req: { sessionId: string }): Promise<AdapterStatus> {
    const session = this.getSession(req.sessionId);

    return {
      sessionId: session.sessionId,
      state: session.state,
      lastHeartbeatAt: session.lastHeartbeatAt,
      providerModel: session.model,
    };
  }

  async attachContext(_req: { sessionId: string; contextIds: string[] }): Promise<void> {}

  async streamEvents(req: {
    sessionId: string;
    onEvent: (event: AgentEvent) => void;
  }): Promise<() => Promise<void>> {
    const session = this.getSession(req.sessionId);
    session.listeners.add(req.onEvent);

    return async () => {
      session.listeners.delete(req.onEvent);
    };
  }

  private getSession(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Unknown Claude session ${sessionId}`);
    }

    return session;
  }

  private createHeartbeatTimer(sessionId: string): NodeJS.Timeout {
    const timer = setInterval(() => {
      const session = this.sessions.get(sessionId);

      if (!session || session.state === "stopped") {
        clearInterval(timer);
        return;
      }

      void this.emit(session, {
        type: "HEARTBEAT",
        payload: {
          status: "alive",
        },
      });
    }, HEARTBEAT_INTERVAL_MS);

    timer.unref?.();
    return timer;
  }

  private async emit(session: ClaudeSession, event: AgentEvent): Promise<void> {
    const ts = event.ts ?? new Date().toISOString();
    session.lastHeartbeatAt = ts;

    for (const listener of session.listeners) {
      await listener({
        ...event,
        ts,
      });
    }
  }
}
