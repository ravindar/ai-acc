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
import { getPricing } from "@acc/pricing";

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

type OpenAIToolAccumulator = {
  callId: string;
  name: string;
  itemId?: string;
  argumentsText: string;
};

type CodexSession = {
  sessionId: string;
  agentId: string;
  model: string;
  systemPrompt?: string;
  cwd?: string;
  contextItems: StartSessionReq["contextItems"];
  listeners: Set<SessionListener>;
  state: AdapterStatus["state"];
  lastHeartbeatAt: string;
  heartbeatTimer: NodeJS.Timeout;
  lastResponseId?: string;
  activeRun?: {
    abortController: AbortController;
  };
};

type OpenAIUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const HEARTBEAT_INTERVAL_MS = 10_000;

function getOpenAIKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new AdapterConfigurationError(
      "OPENAI_API_KEY is required before a live Codex session can be started.",
    );
  }

  return apiKey;
}

function getOpenAIBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL?.trim() || OPENAI_BASE_URL).replace(/\/$/, "");
}

function createSessionId(agentId: string): string {
  return `codex_${agentId}_${randomUUID()}`;
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

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function buildInstructions(session: CodexSession): string | undefined {
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

function buildInputItems(req: SendInputReq): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  if (req.toolResults && req.toolResults.length > 0) {
    for (const toolResult of req.toolResults) {
      items.push({
        type: "function_call_output",
        call_id: toolResult.callId,
        output: JSON.stringify(toolResult.output),
      });
    }
  }

  if (req.input?.trim() || (req.attachments?.length ?? 0) > 0) {
    items.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: buildUserMessage(req.input ?? "", req.attachments),
        },
      ],
    });
  }

  return items;
}

function schemaAllowsNull(schema: Record<string, unknown>): boolean {
  const schemaType = schema.type;

  if (schemaType === "null") {
    return true;
  }

  if (Array.isArray(schemaType) && schemaType.includes("null")) {
    return true;
  }

  const unionOptions = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];

  return unionOptions.some((option) => isRecord(option) && schemaAllowsNull(option));
}

function makeSchemaNullable(schema: Record<string, unknown>): Record<string, unknown> {
  if (schemaAllowsNull(schema)) {
    return schema;
  }

  return {
    anyOf: [schema, { type: "null" }],
  };
}

function toOpenAIStrictSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    };
  }

  const normalized: Record<string, unknown> = {
    ...schema,
  };

  if (Array.isArray(schema.anyOf)) {
    normalized.anyOf = schema.anyOf.map((option) =>
      isRecord(option) ? toOpenAIStrictSchema(option) : option,
    );
  }

  if (Array.isArray(schema.oneOf)) {
    normalized.oneOf = schema.oneOf.map((option) =>
      isRecord(option) ? toOpenAIStrictSchema(option) : option,
    );
  }

  if (schema.type === "array" && isRecord(schema.items)) {
    normalized.items = toOpenAIStrictSchema(schema.items);
  }

  const schemaProperties = isRecord(schema.properties) ? schema.properties : undefined;

  if (schema.type === "object" || schemaProperties) {
    const originalRequired = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    const propertyKeys = Object.keys(schemaProperties ?? {});
    const nextProperties = Object.fromEntries(
      propertyKeys.map((propertyKey) => {
        const propertySchema = toOpenAIStrictSchema(schemaProperties?.[propertyKey]);
        return [
          propertyKey,
          originalRequired.includes(propertyKey)
            ? propertySchema
            : makeSchemaNullable(propertySchema),
        ];
      }),
    );

    normalized.type = "object";
    normalized.additionalProperties = false;
    normalized.properties = nextProperties;
    normalized.required = propertyKeys;
  }

  return normalized;
}

function toOpenAITools(tools: AdapterToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: toOpenAIStrictSchema(tool.inputSchema),
    strict: true,
  }));
}

function extractOutputText(payload: unknown): string {
  const response = asRecord(payload)?.response;
  const subject = (isRecord(response) ? response : payload) as Record<string, unknown>;
  const directText = subject.output_text;

  if (typeof directText === "string" && directText.trim().length > 0) {
    return directText;
  }

  const output = Array.isArray(subject.output) ? subject.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (!isRecord(contentItem)) {
        continue;
      }

      if (typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }

  return parts.join("");
}

function extractUsage(payload: unknown, model: string, latencyMs: number): OpenAIUsage | null {
  const response = asRecord(payload)?.response;
  const subject = (isRecord(response) ? response : payload) as Record<string, unknown>;
  const usage = subject.usage;

  if (!isRecord(usage)) {
    return null;
  }

  const inputTokens = toNumber(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = toNumber(usage.output_tokens ?? usage.outputTokens);
  const pricing = getPricing(model);
  const costUsd = pricing
    ? roundCurrency(
        (inputTokens / 1_000_000) * pricing.inputPerMillion +
          (outputTokens / 1_000_000) * pricing.outputPerMillion,
      )
    : 0;

  return {
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
  };
}

function extractErrorMessage(payload: unknown): string {
  const record = asRecord(payload);
  const error = record?.error;

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  if (typeof record?.message === "string") {
    return record.message;
  }

  return "OpenAI Responses API request failed";
}

async function createHttpError(response: Response): Promise<Error> {
  const rawText = await response.text();
  const parsed = safeParseJson(rawText);
  const message = extractErrorMessage(parsed) || rawText || `HTTP ${response.status}`;
  return new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function finalizeToolCalls(toolAccumulators: Map<number, OpenAIToolAccumulator>): AdapterToolCall[] {
  return [...toolAccumulators.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, tool]) => ({
      callId: tool.callId,
      name: tool.name,
      arguments: isRecord(safeParseJson(tool.argumentsText || "{}"))
        ? (safeParseJson(tool.argumentsText || "{}") as Record<string, unknown>)
        : {},
    }));
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;

  private readonly sessions = new Map<string, CodexSession>();

  async startSession(req: StartSessionReq): Promise<{ sessionId: string }> {
    getOpenAIKey();

    const sessionId = createSessionId(req.agentId);
    const lastHeartbeatAt = new Date().toISOString();
    const session: CodexSession = {
      sessionId,
      agentId: req.agentId,
      model: req.model,
      systemPrompt: req.systemPrompt,
      cwd: req.cwd,
      contextItems: req.contextItems ?? [],
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
      throw new AdapterBusyError(`Codex session ${req.sessionId} is already processing input.`);
    }

    const apiKey = getOpenAIKey();
    const instructions = buildInstructions(session);
    const abortController = new AbortController();
    const startedAt = Date.now();
    const input = buildInputItems(req);

    if (input.length === 0) {
      return {};
    }

    session.activeRun = {
      abortController,
    };
    session.state = "running";

    try {
      const response = await withRetry(
        () => fetch(`${getOpenAIBaseUrl()}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: session.model,
            instructions,
            input,
            previous_response_id: session.lastResponseId,
            tools: toOpenAITools(req.tools),
            tool_choice: req.tools && req.tools.length > 0 ? "auto" : undefined,
            parallel_tool_calls: false,
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
      let usageEmitted = false;
      let finalPayload: unknown;
      let responseId = session.lastResponseId;
      const toolAccumulators = new Map<number, OpenAIToolAccumulator>();

      await consumeSseStream(response, async (event) => {
        if (!event.data || event.data === "[DONE]") {
          return;
        }

        const payload = safeParseJson(event.data);
        const record = asRecord(payload);

        switch (event.event) {
          case "response.created":
          case "response.in_progress": {
            const responseRecord = asRecord(record?.response);
            if (typeof responseRecord?.id === "string") {
              responseId = responseRecord.id;
            }
            return;
          }
          case "response.output_item.added": {
            const outputIndex = toNumber(record?.output_index);
            const item = asRecord(record?.item);
            if (item?.type !== "function_call") {
              return;
            }

            toolAccumulators.set(outputIndex, {
              callId:
                typeof item.call_id === "string"
                  ? item.call_id
                  : typeof item.id === "string"
                    ? item.id
                    : `call_${randomUUID()}`,
              name: typeof item.name === "string" ? item.name : "unknown_tool",
              itemId: typeof item.id === "string" ? item.id : undefined,
              argumentsText: typeof item.arguments === "string" ? item.arguments : "",
            });
            return;
          }
          case "response.function_call_arguments.delta": {
            const outputIndex = toNumber(record?.output_index);
            const existing = toolAccumulators.get(outputIndex) ?? {
              callId: typeof record?.call_id === "string" ? record.call_id : `call_${randomUUID()}`,
              name: typeof record?.name === "string" ? record.name : "unknown_tool",
              itemId: typeof record?.item_id === "string" ? record.item_id : undefined,
              argumentsText: "",
            };
            existing.argumentsText += typeof record?.delta === "string" ? record.delta : "";
            toolAccumulators.set(outputIndex, existing);
            return;
          }
          case "response.function_call_arguments.done": {
            const outputIndex = toNumber(record?.output_index);
            const existing = toolAccumulators.get(outputIndex) ?? {
              callId: typeof record?.call_id === "string" ? record.call_id : `call_${randomUUID()}`,
              name: typeof record?.name === "string" ? record.name : "unknown_tool",
              itemId: typeof record?.item_id === "string" ? record.item_id : undefined,
              argumentsText: "",
            };
            existing.argumentsText = typeof record?.arguments === "string" ? record.arguments : existing.argumentsText;
            toolAccumulators.set(outputIndex, existing);
            return;
          }
          case "response.output_text.delta": {
            const delta =
              typeof record?.delta === "string"
                ? record.delta
                : typeof record?.text === "string"
                  ? record.text
                  : "";

            if (!delta) {
              return;
            }

            assistantText += delta;
            await this.emit(session, {
              type: "OUTPUT_DELTA",
              payload: {
                stream: "assistant",
                text: delta,
              },
            });
            return;
          }
          case "response.output_text.done": {
            const finalText = typeof record?.text === "string" ? record.text : "";
            if (finalText && assistantText.length === 0) {
              assistantText = finalText;
            }
            return;
          }
          case "response.output_item.done": {
            const item = asRecord(record?.item);
            if (item?.type !== "function_call") {
              return;
            }
            const outputIndex = toNumber(record?.output_index);
            const existing = toolAccumulators.get(outputIndex) ?? {
              callId:
                typeof item.call_id === "string"
                  ? item.call_id
                  : typeof item.id === "string"
                    ? item.id
                    : `call_${randomUUID()}`,
              name: typeof item.name === "string" ? item.name : "unknown_tool",
              itemId: typeof item.id === "string" ? item.id : undefined,
              argumentsText: "",
            };
            existing.argumentsText = typeof item.arguments === "string" ? item.arguments : existing.argumentsText;
            toolAccumulators.set(outputIndex, existing);
            return;
          }
          case "response.completed": {
            finalPayload = payload;
            const responseRecord = asRecord(record?.response);
            if (typeof responseRecord?.id === "string") {
              responseId = responseRecord.id;
            }
            const finalText = extractOutputText(payload) || assistantText;

            if (finalText && !emittedFinalOutput) {
              assistantText = finalText;
              emittedFinalOutput = true;
              await this.emit(session, {
                type: "OUTPUT_FINAL",
                payload: {
                  stream: "assistant",
                  text: finalText,
                },
              });
            }

            const usage = extractUsage(payload, session.model, Date.now() - startedAt);
            if (usage && !usageEmitted) {
              usageEmitted = true;
              await this.emit(session, {
                type: "USAGE_TICK",
                payload: {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  costUsd: usage.costUsd,
                  latencyMs: usage.latencyMs,
                  metadata: {
                    model: session.model,
                  },
                },
              });
            }
            return;
          }
          case "response.failed":
          case "response.error":
          case "error": {
            throw new Error(extractErrorMessage(payload));
          }
          default: {
            if (event.event.endsWith(".failed")) {
              throw new Error(extractErrorMessage(payload));
            }
          }
        }
      });

      if (finalPayload && responseId) {
        session.lastResponseId = responseId;
      }

      if (assistantText && !emittedFinalOutput) {
        await this.emit(session, {
          type: "OUTPUT_FINAL",
          payload: {
            stream: "assistant",
            text: assistantText,
          },
        });
      }

      session.state = "waiting_input";
      return {
        assistantText: assistantText || undefined,
        toolCalls: finalizeToolCalls(toolAccumulators),
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        session.state = "waiting_input";
        throw new AdapterInterruptedError("Codex generation was interrupted.");
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

  private getSession(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Unknown Codex session ${sessionId}`);
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

  private async emit(session: CodexSession, event: AgentEvent): Promise<void> {
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
