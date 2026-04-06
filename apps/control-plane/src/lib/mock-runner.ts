import { MockAdapter, getMockScenario, type MockScenarioId } from "@acc/adapter-mock";
import type { AgentEventRecord, AgentSessionRecord } from "@acc/shared-types";

import type { EventService } from "./events/service.js";

type LoggerLike = Pick<Console, "error" | "info" | "warn">;

export interface MockRunner {
  start(agent: AgentSessionRecord, scenarioId: MockScenarioId): Promise<{ sessionId: string }>;
}

export function createMockRunner(
  eventService: EventService,
  logger: LoggerLike = console,
): MockRunner {
  const adapter = new MockAdapter();
  const activeRuns = new Map<string, NodeJS.Timeout[]>();

  function clearRun(agentId: string): void {
    const timers = activeRuns.get(agentId);

    if (!timers) {
      return;
    }

    for (const timer of timers) {
      clearTimeout(timer);
    }

    activeRuns.delete(agentId);
  }

  async function appendHeartbeat(baseEvent: Pick<AgentEventRecord, "agentId" | "workspaceId" | "provider">): Promise<void> {
    await eventService.append({
      ...baseEvent,
      ts: new Date().toISOString(),
      type: "HEARTBEAT",
      payload: {
        status: "alive",
      },
    });
  }

  return {
    async start(agent, scenarioId) {
      if (activeRuns.has(agent.id)) {
        throw new Error(`Mock scenario already running for agent ${agent.id}`);
      }

      const scenario = getMockScenario(scenarioId);
      const session = await adapter.startSession({
        agentId: agent.id,
        model: scenario.model,
      });

      await eventService.append({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        provider: scenario.provider,
        ts: new Date().toISOString(),
        type: "STATUS_CHANGED",
        payload: {
          from: agent.state,
          to: scenario.initialState,
          reason: `Mock scenario ${scenarioId} initialized`,
        },
      });

      const timers: NodeJS.Timeout[] = [];

      for (const step of scenario.steps) {
        const timer = setTimeout(() => {
          void (async () => {
            try {
              await appendHeartbeat({
                agentId: agent.id,
                workspaceId: agent.workspaceId,
                provider: scenario.provider,
              });

              await eventService.append({
                agentId: agent.id,
                workspaceId: agent.workspaceId,
                provider: scenario.provider,
                ts: new Date().toISOString(),
                type: step.type,
                payload:
                  step.type === "SESSION_STARTED"
                    ? {
                        ...(step.payload as Record<string, unknown>),
                        sessionId: session.sessionId,
                        model: scenario.model,
                      }
                    : step.payload,
              });
            } catch (error) {
              logger.error(error);
            }
          })().finally(() => {
            if (step === scenario.steps.at(-1)) {
              clearRun(agent.id);
            }
          });
        }, step.delayMs);

        timers.push(timer);
      }

      activeRuns.set(agent.id, timers);
      logger.info(`started mock scenario ${scenarioId} for agent ${agent.id}`);

      return session;
    },
  };
}

