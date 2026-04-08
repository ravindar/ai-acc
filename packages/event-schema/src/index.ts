import { z } from "zod";

import type {
  AgentEventRecord,
  AgentState,
  ProviderId,
} from "@acc/shared-types";

export const agentEventTypeSchema = z.enum([
  "SESSION_STARTED",
  "STATUS_CHANGED",
  "OUTPUT_DELTA",
  "OUTPUT_FINAL",
  "TOOL_CALL_STARTED",
  "TOOL_CALL_FINISHED",
  "HEARTBEAT",
  "USAGE_TICK",
  "ERROR",
  "SESSION_COMPLETED",
  "CONTEXT_DROPPED",
]);

const agentStateSchema = z.enum([
  "CREATED",
  "STARTING",
  "READY",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "IDLE",
  "COMPLETED",
  "ERROR",
  "STOPPED",
]) satisfies z.ZodType<AgentState>;

export const sessionStartedPayloadSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  scenario: z.string().min(1).nullable().optional(),
});

export const statusChangedPayloadSchema = z.object({
  from: agentStateSchema.nullable(),
  to: agentStateSchema,
  reason: z.string().min(1).nullable().optional(),
});

export const outputPayloadSchema = z.object({
  stream: z.enum(["assistant", "stdout", "stderr"]),
  text: z.string(),
});

export const toolCallStartedPayloadSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()).optional(),
});

export const toolCallFinishedPayloadSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  success: z.boolean(),
  output: z.record(z.unknown()).optional(),
});

export const heartbeatPayloadSchema = z.object({
  status: z.literal("alive"),
});

export const usageTickPayloadSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const errorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const sessionCompletedPayloadSchema = z.object({
  outcome: z.enum(["completed", "stopped", "error"]),
});

export const contextDroppedPayloadSchema = z.object({
  droppedIds: z.array(z.string()),
  droppedChars: z.number().nonnegative(),
  remainingChars: z.number().nonnegative(),
  limitChars: z.number().nonnegative(),
  utilizationPercent: z.number().nonnegative(),
});

const payloadSchemaByType = {
  SESSION_STARTED: sessionStartedPayloadSchema,
  STATUS_CHANGED: statusChangedPayloadSchema,
  OUTPUT_DELTA: outputPayloadSchema,
  OUTPUT_FINAL: outputPayloadSchema,
  TOOL_CALL_STARTED: toolCallStartedPayloadSchema,
  TOOL_CALL_FINISHED: toolCallFinishedPayloadSchema,
  HEARTBEAT: heartbeatPayloadSchema,
  USAGE_TICK: usageTickPayloadSchema,
  ERROR: errorPayloadSchema,
  SESSION_COMPLETED: sessionCompletedPayloadSchema,
  CONTEXT_DROPPED: contextDroppedPayloadSchema,
} as const;

export const agentEventSchema = z.object({
  eventId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  provider: z.string().min(1),
  type: agentEventTypeSchema,
  payload: z.unknown(),
});

export type AgentEventEnvelope = z.infer<typeof agentEventSchema>;
export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

export function validateAgentEvent(
  event: AgentEventRecord,
): AgentEventRecord {
  const envelope = agentEventSchema.parse(event);
  const payloadSchema = payloadSchemaByType[envelope.type];
  const payload = payloadSchema.parse(envelope.payload);

  return {
    ...envelope,
    provider: envelope.provider as ProviderId,
    payload,
  };
}

export function createAgentEvent(
  event: AgentEventRecord,
): AgentEventRecord {
  return validateAgentEvent(event);
}
