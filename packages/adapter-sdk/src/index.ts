import type { AgentEventPayload, AgentEventType, ProviderId } from "@acc/shared-types";

export interface StartSessionReq {
  agentId: string;
  model: string;
  systemPrompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  contextItems?: Array<{
    id: string;
    type: "file" | "url" | "text";
    value: string;
  }>;
}

export interface SendInputReq {
  sessionId: string;
  input?: string;
  attachments?: Array<{
    type: "file" | "text";
    value: string;
  }>;
  tools?: AdapterToolDefinition[];
  toolResults?: AdapterToolResult[];
}

export interface AdapterToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AdapterToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AdapterToolResult {
  callId: string;
  output: Record<string, unknown>;
  isError?: boolean;
}

export interface SendInputResult {
  assistantText?: string;
  toolCalls?: AdapterToolCall[];
}

export interface AdapterStatus {
  sessionId: string;
  state: "ready" | "running" | "waiting_input" | "completed" | "error" | "stopped";
  lastHeartbeatAt: string;
  providerModel?: string;
}

export type { AgentEventType };

export interface AgentEvent<TPayload = AgentEventPayload> {
  type: AgentEventType;
  payload: TPayload;
  ts?: string;
}

export class AdapterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConfigurationError";
  }
}

export class AdapterBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterBusyError";
  }
}

export class AdapterInterruptedError extends Error {
  constructor(message: string = "Adapter run interrupted") {
    super(message);
    this.name = "AdapterInterruptedError";
  }
}

export function isAdapterInterruptedError(error: unknown): error is AdapterInterruptedError {
  return error instanceof AdapterInterruptedError;
}

export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export async function consumeSseStream(
  response: Response,
  onEvent: (event: ServerSentEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.body) {
    throw new Error("Streaming response body was empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function flushBuffer(force: boolean = false): Promise<void> {
    const separator = "\n\n";

    while (true) {
      const separatorIndex = buffer.indexOf(separator);

      if (separatorIndex === -1) {
        if (force && buffer.trim().length > 0) {
          const block = buffer;
          buffer = "";
          await emitBlock(block, onEvent);
        }
        return;
      }

      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + separator.length);
      await emitBlock(block, onEvent);
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      await flushBuffer(done);

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function emitBlock(
  block: string,
  onEvent: (event: ServerSentEvent) => void | Promise<void>,
): Promise<void> {
  const normalizedBlock = block.replace(/\r/g, "");

  if (normalizedBlock.trim().length === 0) {
    return;
  }

  let eventName = "message";
  let data = "";
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of normalizedBlock.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).replace(/^ /, "");

    switch (field) {
      case "event":
        eventName = rawValue || "message";
        break;
      case "data":
        data += data.length > 0 ? `\n${rawValue}` : rawValue;
        break;
      case "id":
        id = rawValue;
        break;
      case "retry": {
        const retryValue = Number(rawValue);
        if (Number.isFinite(retryValue)) {
          retry = retryValue;
        }
        break;
      }
      default:
        break;
    }
  }

  await onEvent({
    event: eventName,
    data,
    id,
    retry,
  });
}

export interface AgentAdapter {
  readonly provider: ProviderId;
  startSession(req: StartSessionReq): Promise<{ sessionId: string }>;
  sendInput(req: SendInputReq): Promise<SendInputResult>;
  interrupt(req: { sessionId: string }): Promise<void>;
  stop(req: { sessionId: string }): Promise<void>;
  getStatus(req: { sessionId: string }): Promise<AdapterStatus>;
  attachContext(req: { sessionId: string; contextIds: string[] }): Promise<void>;
  streamEvents(req: {
    sessionId: string;
    onEvent: (event: AgentEvent) => void;
  }): Promise<() => Promise<void>>;
}
