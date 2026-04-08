import type { AppConfig } from "../config.js";

import { ClaudeAdapter } from "@acc/adapter-claude";
import { CodexAdapter } from "@acc/adapter-codex";
import { MockAdapter } from "@acc/adapter-mock";

import { createDatabase } from "./database.js";
import { createCoordinationService, type CoordinationService } from "./coordination-state.js";
import { createEventBus, type EventBus } from "./events/bus.js";
import { createEventService, type EventService } from "./events/service.js";
import { assertCoreSchema, runMigrations } from "./migrations.js";
import { createMockRunner, type MockRunner } from "./mock-runner.js";
import { createRepositories, type Repositories } from "./repositories.js";
import { createRunOrchestrator, type RunOrchestrator } from "./run-orchestrator.js";
import { createRuntimeManager, type RuntimeManager } from "./runtime-manager.js";
import { createToolBroker, type ToolBroker } from "./tool-broker.js";
import { createWorktreeManager, type WorktreeManager } from "./worktree-manager.js";

export interface AppServices {
  config: AppConfig;
  db: ReturnType<typeof createDatabase>;
  repositories: Repositories;
  eventBus: EventBus;
  eventService: EventService;
  runtimeManager: RuntimeManager;
  coordinationService: CoordinationService;
  worktreeManager: WorktreeManager;
  toolBroker: ToolBroker;
  runOrchestrator: RunOrchestrator;
  mockRunner: MockRunner;
}

export async function createServices(config: AppConfig): Promise<AppServices> {
  const db = createDatabase(config);

  try {
    await db.ping();

    if (config.autoMigrate) {
      await runMigrations(db);
    }

    await assertCoreSchema(db);

    const eventBus = createEventBus();
    const eventService = createEventService(db, eventBus);
    const repositories = createRepositories(db);
    const coordinationService = createCoordinationService(repositories);
    const runtimeManager = createRuntimeManager(repositories, eventService, coordinationService, {
      codex: new CodexAdapter(),
      claude: new ClaudeAdapter(),
      mock: new MockAdapter(),
    });
    const worktreeManager = createWorktreeManager(config, repositories);
    const toolBroker = createToolBroker(config, repositories, coordinationService);
    const runOrchestrator = createRunOrchestrator(
      repositories,
      runtimeManager,
      eventService,
      worktreeManager,
      toolBroker,
      coordinationService,
    );

    // Wire the run orchestrator into the tool broker so spawn_agent can start runs.
    toolBroker.bindOrchestrator(runOrchestrator);

    await runtimeManager.recoverDetachedSessions();
    await runOrchestrator.recoverInterruptedRuns();

    coordinationService.setAutoSpawnCallback(async (handoffId, prompt) => {
      const handoff = await repositories.handoffs.findById(handoffId);
      if (!handoff) return;
      // Guard against runaway cascade chains (depth > 3)
      const sourceChain = [handoffId];
      let currentHandoff = handoff;
      for (let depth = 0; depth < 3; depth++) {
        if (!currentHandoff.sourceAgentId) break;
        const sourceAgent = await repositories.agents.findById(currentHandoff.sourceAgentId);
        if (!sourceAgent) break;
        // Check if the source agent itself came from a handoff
        const parentRuns = await repositories.runs.listByAgent(currentHandoff.sourceAgentId);
        const sourceRun = parentRuns.find((r) => r.id === currentHandoff.sourceRunId);
        if (!sourceRun) break;
        sourceChain.push(currentHandoff.sourceAgentId);
        if (sourceChain.length >= 3) break;
        break; // Only trace one level for simplicity
      }
      if (sourceChain.length >= 3) {
        console.warn(`auto-spawn chain depth limit reached for handoff ${handoffId}, skipping`);
        return;
      }
      const newAgent = await runOrchestrator.createAgentFromHandoff(handoffId);
      if (newAgent) {
        await runOrchestrator.startRun(newAgent.id, prompt);
      }
    });

    return {
      config,
      db,
      repositories,
      eventBus,
      eventService,
      runtimeManager,
      coordinationService,
      worktreeManager,
      toolBroker,
      runOrchestrator,
      mockRunner: createMockRunner(eventService),
    };
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}
