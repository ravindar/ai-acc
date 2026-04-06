import { createAgentEvent, validateAgentEvent } from "@acc/event-schema";
import type {
  AgentEventPayload,
  AgentEventRecord,
  AgentState,
  UsageTickPayload,
} from "@acc/shared-types";

import type { Database, QueryParam, QueryResultRow, Queryable } from "../database.js";
import { createId } from "../ids.js";
import type { EventBus } from "./bus.js";

type AgentEventRow = QueryResultRow & {
  id: string;
  seq: number;
  ts: string;
  workspace_id: string;
  agent_id: string;
  provider: string;
  event_type: AgentEventRecord["type"];
  payload: string;
};

type SequenceRow = QueryResultRow & {
  next_seq: number | string;
};

export type AppendAgentEventInput<TPayload = AgentEventPayload> = Omit<
  AgentEventRecord<TPayload>,
  "eventId" | "seq"
> & {
  eventId?: string;
};

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function mapEventRow(row: AgentEventRow): AgentEventRecord {
  return validateAgentEvent({
    eventId: row.id,
    seq: row.seq,
    ts: new Date(row.ts).toISOString(),
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    provider: row.provider,
    type: row.event_type,
    payload: JSON.parse(row.payload) as AgentEventPayload,
  });
}

async function getNextSequence(client: Queryable, agentId: string): Promise<number> {
  const result = await client.query<SequenceRow>(
    `
      select coalesce(max(seq), 0) + 1 as next_seq
      from agent_events
      where agent_id = ?
    `,
    [agentId],
  );

  return toNumber(result.rows[0].next_seq);
}

async function touchAgent(client: Queryable, agentId: string, ts: string): Promise<void> {
  await client.query(
    `
      update agent_sessions
      set
        last_event_at = ?,
        updated_at = ?
      where id = ?
    `,
    [ts, ts, agentId],
  );
}

async function updateAgentState(
  client: Queryable,
  agentId: string,
  ts: string,
  state: AgentState,
  details?: {
    errorCode?: string;
    errorMessage?: string;
    runtimeSessionId?: string | null;
    started?: boolean;
    completed?: boolean;
  },
): Promise<void> {
  await client.query(
    `
      update agent_sessions
      set
        state = ?,
        last_event_at = ?,
        heartbeat_at = ?,
        runtime_session_id = coalesce(?, runtime_session_id),
        error_code = coalesce(?, error_code),
        error_message = coalesce(?, error_message),
        started_at = case when ? = 1 then coalesce(started_at, ?) else started_at end,
        completed_at = case when ? = 1 then ? else completed_at end,
        updated_at = ?
      where id = ?
    `,
    [
      state,
      ts,
      ts,
      details?.runtimeSessionId ?? null,
      details?.errorCode ?? null,
      details?.errorMessage ?? null,
      details?.started ? 1 : 0,
      ts,
      details?.completed ? 1 : 0,
      ts,
      ts,
      agentId,
    ],
  );
}

async function appendUsageTick(
  client: Queryable,
  event: AgentEventRecord<UsageTickPayload>,
): Promise<void> {
  await client.query(
    `
      insert into usage_ticks (
        id,
        agent_id,
        workspace_id,
        ts,
        input_tokens,
        output_tokens,
        cost_usd,
        latency_ms,
        metadata
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      createId("ut"),
      event.agentId,
      event.workspaceId,
      event.ts,
      event.payload.inputTokens,
      event.payload.outputTokens,
      event.payload.costUsd,
      event.payload.latencyMs ?? null,
      JSON.stringify(event.payload.metadata ?? {}),
    ],
  );
}

async function applySideEffects(client: Queryable, event: AgentEventRecord): Promise<void> {
  switch (event.type) {
    case "SESSION_STARTED": {
      const payload = event.payload as { sessionId?: string | null };
      await updateAgentState(client, event.agentId, event.ts, "STARTING", {
        runtimeSessionId: payload.sessionId ?? null,
        started: true,
      });
      return;
    }
    case "STATUS_CHANGED": {
      const payload = event.payload as { to: AgentState };
      await updateAgentState(client, event.agentId, event.ts, payload.to);
      return;
    }
    case "HEARTBEAT": {
      await client.query(
        `
          update agent_sessions
          set
            heartbeat_at = ?,
            last_event_at = ?,
            updated_at = ?
          where id = ?
        `,
        [event.ts, event.ts, event.ts, event.agentId],
      );
      return;
    }
    case "USAGE_TICK": {
      await appendUsageTick(client, event as AgentEventRecord<UsageTickPayload>);
      await touchAgent(client, event.agentId, event.ts);
      return;
    }
    case "ERROR": {
      const payload = event.payload as { code: string; message: string };
      await updateAgentState(client, event.agentId, event.ts, "ERROR", {
        errorCode: payload.code,
        errorMessage: payload.message,
      });
      return;
    }
    case "SESSION_COMPLETED": {
      const payload = event.payload as { outcome: "completed" | "stopped" | "error" };
      const nextState =
        payload.outcome === "completed"
          ? "COMPLETED"
          : payload.outcome === "stopped"
            ? "STOPPED"
            : "ERROR";
      await updateAgentState(client, event.agentId, event.ts, nextState, {
        completed: true,
      });
      return;
    }
    default: {
      await touchAgent(client, event.agentId, event.ts);
    }
  }
}

export interface EventService {
  append(
    input: AppendAgentEventInput,
  ): Promise<AgentEventRecord>;
  listAgentEvents(agentId: string, cursor?: number, limit?: number): Promise<AgentEventRecord[]>;
  listWorkspaceEvents(
    workspaceId: string,
    options?: {
      agentId?: string;
      limit?: number;
    },
  ): Promise<AgentEventRecord[]>;
}

export function createEventService(db: Database, bus: EventBus): EventService {
  return {
    async append(
      input: AppendAgentEventInput,
    ): Promise<AgentEventRecord> {
      const event = await db.transaction(async (client) => {
        const seq = await getNextSequence(client, input.agentId);
        const normalized = createAgentEvent({
          ...input,
          eventId: input.eventId ?? createId("ev"),
          seq,
        });

        await client.query(
          `
            insert into agent_events (
              id,
              agent_id,
              workspace_id,
              seq,
              event_type,
              ts,
              provider,
              payload
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            normalized.eventId,
            normalized.agentId,
            normalized.workspaceId,
            normalized.seq,
            normalized.type,
            normalized.ts,
            normalized.provider,
            JSON.stringify(normalized.payload),
          ],
        );

        await applySideEffects(client, normalized as AgentEventRecord);

        return normalized;
      });

      bus.publish(event);
      return event;
    },

    async listAgentEvents(agentId: string, cursor?: number, limit: number = 100): Promise<AgentEventRecord[]> {
      const clampedLimit = Math.min(Math.max(limit, 1), 500);
      const params: QueryParam[] = [agentId];
      let filter = "where agent_id = ?";

      if (typeof cursor === "number") {
        filter += " and seq > ?";
        params.push(cursor);
      }

      params.push(clampedLimit);

      const result = await db.query<AgentEventRow>(
        `
          select id, seq, ts, workspace_id, agent_id, provider, event_type, payload
          from agent_events
          ${filter}
          order by seq asc
          limit ?
        `,
        params,
      );

      return result.rows.map(mapEventRow);
    },

    async listWorkspaceEvents(
      workspaceId: string,
      options?: {
        agentId?: string;
        limit?: number;
      },
    ): Promise<AgentEventRecord[]> {
      const clampedLimit = Math.min(Math.max(options?.limit ?? 200, 1), 500);
      const params: QueryParam[] = [workspaceId];
      let filter = "where workspace_id = ?";

      if (options?.agentId) {
        filter += " and agent_id = ?";
        params.push(options.agentId);
      }

      params.push(clampedLimit);

      const result = await db.query<AgentEventRow>(
        `
          select id, seq, ts, workspace_id, agent_id, provider, event_type, payload
          from (
            select id, seq, ts, workspace_id, agent_id, provider, event_type, payload
            from agent_events
            ${filter}
            order by ts desc, id desc
            limit ?
          ) recent_events
          order by ts asc, id asc
        `,
        params,
      );

      return result.rows.map(mapEventRow);
    },
  };
}
