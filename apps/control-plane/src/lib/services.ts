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

    await runtimeManager.recoverDetachedSessions();
    await runOrchestrator.recoverInterruptedRuns();

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
