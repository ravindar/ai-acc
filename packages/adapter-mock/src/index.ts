import {
  AdapterBusyError,
  type AdapterToolCall,
  type AgentAdapter,
  type AdapterStatus,
  type AgentEvent,
  type SendInputReq,
  type SendInputResult,
  type StartSessionReq,
} from "@acc/adapter-sdk";
import type { AgentEventPayload, AgentState, ProviderId } from "@acc/shared-types";

export type MockScenarioId = "planner" | "reviewer" | "idle" | "error";

export type MockScenarioStep = {
  delayMs: number;
  type: AgentEvent["type"];
  payload: AgentEventPayload;
  state?: AgentState;
};

export interface MockScenarioDefinition {
  id: MockScenarioId;
  provider: ProviderId;
  model: string;
  initialState: AgentState;
  steps: MockScenarioStep[];
}

export const mockScenarios: Record<MockScenarioId, MockScenarioDefinition> = {
  planner: {
    id: "planner",
    provider: "codex",
    model: "gpt-5-codex",
    initialState: "STARTING",
    steps: [
      {
        delayMs: 0,
        type: "SESSION_STARTED",
        payload: {
          scenario: "planner",
        },
        state: "STARTING",
      },
      {
        delayMs: 250,
        type: "STATUS_CHANGED",
        payload: {
          from: "STARTING",
          to: "RUNNING",
          reason: "Mock planner scenario started",
        },
        state: "RUNNING",
      },
      {
        delayMs: 450,
        type: "OUTPUT_DELTA",
        payload: {
          stream: "assistant",
          text: "Breaking the current workspace into a planner swarm with implementation, review, and release tracks.",
        },
      },
      {
        delayMs: 700,
        type: "USAGE_TICK",
        payload: {
          inputTokens: 920,
          outputTokens: 310,
          costUsd: 0.024,
          latencyMs: 640,
          metadata: {
            scenario: "planner",
          },
        },
      },
      {
        delayMs: 950,
        type: "OUTPUT_FINAL",
        payload: {
          stream: "assistant",
          text: "Planner swarm finished the first pass and handed off three execution lanes.",
        },
      },
      {
        delayMs: 1200,
        type: "SESSION_COMPLETED",
        payload: {
          outcome: "completed",
        },
        state: "COMPLETED",
      },
    ],
  },
  reviewer: {
    id: "reviewer",
    provider: "claude",
    model: "sonnet",
    initialState: "STARTING",
    steps: [
      {
        delayMs: 0,
        type: "SESSION_STARTED",
        payload: {
          scenario: "reviewer",
        },
        state: "STARTING",
      },
      {
        delayMs: 220,
        type: "STATUS_CHANGED",
        payload: {
          from: "STARTING",
          to: "WAITING_INPUT",
          reason: "Needs confirmation before review continues",
        },
        state: "WAITING_INPUT",
      },
      {
        delayMs: 520,
        type: "OUTPUT_FINAL",
        payload: {
          stream: "assistant",
          text: "Review pass is blocked on a human decision about the release cutoff.",
        },
      },
    ],
  },
  idle: {
    id: "idle",
    provider: "codex",
    model: "gpt-5-codex",
    initialState: "STARTING",
    steps: [
      {
        delayMs: 0,
        type: "SESSION_STARTED",
        payload: {
          scenario: "idle",
        },
        state: "STARTING",
      },
      {
        delayMs: 240,
        type: "STATUS_CHANGED",
        payload: {
          from: "STARTING",
          to: "RUNNING",
          reason: "Mock idle scenario running",
        },
        state: "RUNNING",
      },
      {
        delayMs: 520,
        type: "OUTPUT_DELTA",
        payload: {
          stream: "assistant",
          text: "Finishing the current queue and waiting for new instructions.",
        },
      },
      {
        delayMs: 760,
        type: "STATUS_CHANGED",
        payload: {
          from: "RUNNING",
          to: "IDLE",
          reason: "No new output for the idle threshold window",
        },
        state: "IDLE",
      },
    ],
  },
  error: {
    id: "error",
    provider: "claude",
    model: "opus",
    initialState: "STARTING",
    steps: [
      {
        delayMs: 0,
        type: "SESSION_STARTED",
        payload: {
          scenario: "error",
        },
        state: "STARTING",
      },
      {
        delayMs: 180,
        type: "STATUS_CHANGED",
        payload: {
          from: "STARTING",
          to: "RUNNING",
          reason: "Mock error scenario started",
        },
        state: "RUNNING",
      },
      {
        delayMs: 420,
        type: "ERROR",
        payload: {
          code: "MOCK_REDIS_REFUSED",
          message: "Redis connection refused while attaching the simulated event stream.",
        },
        state: "ERROR",
      },
      {
        delayMs: 520,
        type: "SESSION_COMPLETED",
        payload: {
          outcome: "error",
        },
        state: "ERROR",
      },
    ],
  },
};

export function getMockScenario(id: MockScenarioId): MockScenarioDefinition {
  return mockScenarios[id];
}

type SessionListener = (event: AgentEvent) => void | Promise<void>;

type MockSession = {
  sessionId: string;
  agentId: string;
  model: string;
  listeners: Set<SessionListener>;
  history: string[];
  state: AdapterStatus["state"];
  lastHeartbeatAt: string;
  heartbeatTimer: ReturnType<typeof setInterval>;
  activeRun: boolean;
};

const HEARTBEAT_INTERVAL_MS = 10_000;

function buildMockToolCall(callId: string, name: string, args: Record<string, unknown>): AdapterToolCall {
  return {
    callId,
    name,
    arguments: args,
  };
}

export class MockAdapter implements AgentAdapter {
  readonly provider = "mock" as const;

  private readonly sessions = new Map<string, MockSession>();

  async startSession(req: StartSessionReq): Promise<{ sessionId: string }> {
    const sessionId = `mock_${req.agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const session: MockSession = {
      sessionId,
      agentId: req.agentId,
      model: req.model,
      listeners: new Set<SessionListener>(),
      history: [],
      state: "ready",
      lastHeartbeatAt: new Date().toISOString(),
      heartbeatTimer: setInterval(() => {
        const existing = this.sessions.get(sessionId);
        if (!existing) {
          return;
        }
        existing.lastHeartbeatAt = new Date().toISOString();
        void this.emit(existing, {
          type: "HEARTBEAT",
          payload: {
            status: "alive",
          },
        });
      }, HEARTBEAT_INTERVAL_MS),
      activeRun: false,
    };

    this.sessions.set(sessionId, session);
    return { sessionId };
  }

  async sendInput(req: SendInputReq): Promise<SendInputResult> {
    const session = this.getSession(req.sessionId);

    if (session.activeRun) {
      throw new AdapterBusyError(`Mock session ${req.sessionId} is already processing input.`);
    }

    session.activeRun = true;
    session.state = "running";
    if (req.input?.trim()) {
      session.history.push(req.input.trim());
    }

    try {
      let result: SendInputResult;

      if (req.toolResults?.some((toolResult) => toolResult.callId.startsWith("mock_run_command"))) {
        const assistantText =
          "The approved command completed in the isolated worktree. I turned the result into a structured follow-up so the operator can route the next step from the inbox.";
        result = {
          assistantText,
          toolCalls: [
            buildMockToolCall("mock_create_handoff_1", "create_handoff", {
              title: "Review command output",
              summary: "The command completed in the agent worktree and produced output worth handing off.",
              recommendedProvider: "claude",
              recommendedModel: "sonnet",
              nextPrompt: "Review the latest run artifacts and decide the next code change to make.",
            }),
          ],
        };
      } else if (req.toolResults?.some((toolResult) => toolResult.callId.startsWith("mock_create_handoff"))) {
        result = {
          assistantText:
            "Created a structured handoff after the approved command completed. The operator can assign the follow-up from the inbox.",
        };
      } else if (req.toolResults?.some((toolResult) => toolResult.isError)) {
        result = {
          assistantText:
            "The risky tool request was denied or failed, so I stopped before making changes. A safer next step would be to inspect files or ask for a narrower approval.",
        };
      } else {
        const task = req.input?.trim() || "Continue the tracked run safely.";
        result = {
          assistantText: "I want to validate the current workspace safely before proposing a follow-up.",
          toolCalls: [
            buildMockToolCall("mock_run_command_1", "run_command", {
              command: "node",
              args: ["-e", `console.log(${JSON.stringify(`mock tool run: ${task.slice(0, 80)}`)})`],
            }),
          ],
        };
      }

      if (result.assistantText) {
        await this.emit(session, {
          type: "OUTPUT_FINAL",
          payload: {
            stream: "assistant",
            text: result.assistantText,
          },
        });
      }

      await this.emit(session, {
        type: "USAGE_TICK",
        payload: {
          inputTokens: Math.max(32, Math.round((req.input?.length ?? 0) / 4)),
          outputTokens: Math.max(24, Math.round((result.assistantText?.length ?? 0) / 4)),
          costUsd: 0,
          latencyMs: 5,
          metadata: {
            provider: "mock",
          },
        },
      });
      session.state = "waiting_input";
      return result;
    } finally {
      session.activeRun = false;
      session.lastHeartbeatAt = new Date().toISOString();
    }
  }

  async interrupt(req: { sessionId: string }): Promise<void> {
    const session = this.getSession(req.sessionId);
    session.activeRun = false;
    session.state = "waiting_input";
  }

  async stop(req: { sessionId: string }): Promise<void> {
    const session = this.getSession(req.sessionId);
    clearInterval(session.heartbeatTimer);
    session.state = "stopped";
    this.sessions.delete(req.sessionId);
  }

  async getStatus(req: { sessionId: string }): Promise<AdapterStatus> {
    const session = this.getSession(req.sessionId);
    return {
      sessionId: req.sessionId,
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

  private getSession(sessionId: string): MockSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Mock session ${sessionId} does not exist.`);
    }

    return session;
  }

  private async emit(session: MockSession, event: AgentEvent): Promise<void> {
    for (const listener of session.listeners) {
      await listener({
        ...event,
        ts: event.ts ?? new Date().toISOString(),
      });
    }
  }
}
