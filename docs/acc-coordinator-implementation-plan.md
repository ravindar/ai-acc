# ACC Coordinator Implementation Plan

## Goal
Build a hidden control-plane `ACC Coordinator` so the user talks to one workspace conversation while ACC coordinates multi-agent work behind the scenes across providers.

The coordinator is not a visible user-facing agent. It is a workspace-level orchestration service that:
- collects agent asks, findings, blockers, approvals, and handoffs
- decides execution order and dependency gating
- synthesizes one operator-facing ask in `Workspace`
- splits one user reply into per-agent continuation packets
- keeps context durable and reusable across providers

## Current anchors in the codebase

### Shared types
- [/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts) (444 lines)

Key state enumerations (verified values):
- `AgentState`: 10 values — `CREATED | STARTING | READY | RUNNING | WAITING_INPUT | WAITING_APPROVAL | IDLE | COMPLETED | ERROR | STOPPED`. **Does NOT include `WAITING_DEPENDENCY`** (added in Phase 3) or any provider-specific states.
- `AgentRunState`: 6 values — `CREATED | RUNNING | WAITING_APPROVAL | COMPLETED | ERROR | STOPPED`. **Does NOT include `QUEUED`** (required by Phase 3 gating — must be added).
- `CoordinationFindingType`: 9 values, all lowercase strings. Phase 7 adds `command_request` and `access_request`.
- `ApprovalRequestRecord.toolCallId: string` — non-nullable. Cannot create an `ApprovalRequestRecord` without a real tool call.
- `CoordinationStateRecord` has **15 fields** (8 original + `dependencyGraph`, `executionPlan`, `blockedAgents`, `coordinatorDecisions`, `replyPackets`, `teamAskHistory`, `currentPromptId` — all added in Phase 1, **IMPLEMENTED**).
- `CoordinationAgentBriefRecord` has `subscribedFindingTypes` but no `subscriptionReasons` (Phase 2 adds it).

### Control-plane coordination service
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts) (1012 lines)

Current relevant logic (line numbers approximate — file has grown since Phase 0+1):
- `classifyFindingType(...)` — Uses regex pattern matching only. No structured signal input yet (Phase 2 adds short-circuit for structured metadata).
- `deriveFindingSubscriptions(...)` — Returns `CoordinationFindingType[]` (plain array, no reasons). Phase 2 adds `subscriptionReasons`.
- `summarizeTeamAsk(...)` — **Phase 1 IMPLEMENTED**: now scoped by `promptId`. ID is stable within a prompt round; a new `promptId` always produces a new ID. Signature accepts `teamAskHistory` and `currentPromptId`.
- `collectCoordinationSignals(...)` — Core signal harvesting function. **Known N+1 issue**: calls `loadLatestRunContext` per agent, which does `runs.slice(0, 6)` and queries transcript for each run. Fixed in Phase 13.
- `loadLatestRunContext(...)` — Per-agent transcript lookup. O(agents × 6 runs × transcript rows). Fixed in Phase 13.
- `extractActionRequestFromText(...)` — Heuristic text parser for operator action requests.
- `buildAgentBrief(...)` — builds per-agent brief.
- `buildCoordinationState(...)` — **Phase 1 IMPLEMENTED**: accepts `existingState?` and `currentPromptId?`; returns all 15 fields. Now private (not exported).
- `renderWorkspaceCoordinationContext(...)` — **Phase 0 IMPLEMENTED**: now private (not exported).
- `renderAgentCoordinationContext(...)` — **Phase 0 IMPLEMENTED**: now private (not exported).
- `renderExecutionPacket(...)` — on `CoordinationService` interface.
- `refreshWorkspaceState(...)` — **Phase 1 IMPLEMENTED**: dual-write hazard resolved. No longer writes to `workspaces.layout_config.coordinationBrief`. Reads `coordination_brief` from dedicated `workspaces` column.
- `CoordinationService` interface — **7 methods** after Phase 0+1: `getWorkspaceState`, `refreshWorkspaceState`, `renderExecutionPacket`, `renderTeamAsk`, `getExecutionPlan` (returns real execution plan), `decomposeWorkspaceReply` (Phase 5). Phase 3 adds `checkCanRun`, `resumeBlockedAgents`. Phase 6 adds 4 trigger methods.
- `createCoordinationService` factory — the sole implementation. `refreshWindowMs` is hardcoded to 3000ms.

### Runtime injection
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts) (478 lines)

Current relevant logic:
- `loadRuntimeContext(...)` — **Phase 0 IMPLEMENTED**: now takes `coordinationService: CoordinationService` as a parameter. Calls `coordinationService.renderExecutionPacket()` — zero direct imports from `coordination-state.ts`.
- `buildSystemPrompt(...)` — line 65. Already includes execution policy at lines 82–90.
- `sendInput(...)` — Calls `coordinationService.renderExecutionPacket()` to inject coordination on each turn. **No retry logic** for adapter API failures (Phase 10 adds it).

### Control-plane repositories and migrations
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts) (~1000 lines)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts) (799 lines, 8 migrations)

Current relevant storage (**Phase 1 IMPLEMENTED — migration 0009 applied**):
- `workspace_coordination_states` table: `workspace_id PK, brief, agent_briefs, handoff_summaries, finding_summaries, action_requests, team_ask, created_at, updated_at, dependency_graph, execution_plan, blocked_agents, coordinator_decisions, reply_packets, team_ask_history, current_prompt_id`
- `workspaces` table now has a dedicated `coordination_brief TEXT` column (backfilled from `workspace_coordination_states.brief`). The `layout_config.coordinationBrief` dual-write has been removed.
- `ensureColumn` helper guards against re-running `ALTER TABLE` on existing columns.
- 9 migrations total (0001–0009).

### Run orchestrator and tool execution
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts) (753 lines)

Key facts:
- `startRun()` at line 561: no gating check, immediately dispatches (Phase 3 target).
- `continueRun()` at line 254: main tool loop, `MAX_TOOL_STEPS = 12`.
- `activeRuns` and `pendingApprovals` are **in-memory Maps** — lost on restart. `recoverInterruptedRuns()` handles re-entrant recovery.
- Parallel tool calls explicitly blocked (line 330).
- No timeout on tool execution — hangs indefinitely if toolBroker.execute() never returns.

- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts) (670 lines)

Key facts:
- `create_handoff` tool at lines 632–661: **only path for handoff creation** (no POST /handoffs route).
- Auto-approved tools: list_tree, read_file, search_files, git_status, git_diff, run_verification_command, create_handoff.
- Approval-required tools: write_file, apply_patch, run_command.

### Workspace and handoff routes
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/workspaces.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/workspaces.ts) (491 lines)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/agents.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/agents.ts) (~9000 lines — needs splitting)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/handoffs.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/handoffs.ts) (48 lines)

Key facts:
- `PATCH /handoffs/:id` at handoffs.ts line 43 already calls `coordinationService.refreshWorkspaceState()`.
- `POST /workspaces/:id/coordination/dispatch` does NOT exist (Phase 5 adds it).

### Adapter packages
- [/Users/ravindargujral/Downloads/ai-ace/packages/adapter-claude/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/adapter-claude/src/index.ts) (659 lines)
- [/Users/ravindargujral/Downloads/ai-ace/packages/adapter-codex/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/adapter-codex/src/index.ts) (740 lines)
- [/Users/ravindargujral/Downloads/ai-ace/packages/adapter-mock/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/adapter-mock/src/index.ts) (420 lines)

Key facts:
- Claude adapter has 10s heartbeat. **Codex adapter has NO heartbeat** (Phase 10 adds it).
- Neither adapter has retry/backoff for 429 or 503 responses (Phase 10 adds it).
- Pricing hardcoded in both adapters: Claude sonnet/haiku/opus rates, Codex gpt-5-codex rates. These need a maintenance strategy (Phase 10).
- Codex adapter disables parallel tool calls (`parallel_tool_calls: false` at line 444).
- Mock adapter has 4 scenarios (planner, reviewer, idle, error) with realistic event sequences.

### Desktop workspace shell
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx) (10,001 lines — needs splitting into components)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/lib/api.ts](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/lib/api.ts) (577 lines)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css)

Key facts:
- `workspaceConversationGroups` memo at line 2220 builds `WorkspacePromptGroup[]`.
- `submitWorkspaceInstruction(...)` at line 4707. Sequential per-agent loop at lines 4778–4791 (Phase 5 target).
- `handleBroadcast(...)` at line 4905. Calls `submitWorkspaceInstruction`.
- `decomposeWorkspaceReply` function does NOT exist yet (Phase 5 adds it).

### Tauri desktop backend
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/src/main.rs](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/src/main.rs) (789 lines)

Key facts:
- 7 Tauri IPC commands: `get_provider_settings`, `save_provider_settings`, `get_control_plane_runtime_status`, `list_project_tree`, `read_text_file`, `write_text_file`, `run_terminal_command`.
- API keys stored in **macOS Keychain** (`com.acc.desktop.providers`). Migrates from legacy JSON file on first launch.
- Control plane launched as child process with `ACC_PORT=7711` hardcoded. Supervisor thread restarts it every 2s if it exits.
- **`run_terminal_command` has no path restriction** — runs `sh -lc <command>` in any directory the operator specifies (Phase 11 target).
- **`write_text_file` has no workspace boundary check** — canonicalizes path but does not restrict writes to workspace root (Phase 11 target).
- File tree: max depth 4, max 48 entries per directory.
- File preview: truncated at 24KB. Terminal output: truncated at 32KB.
- Port 7711 hardcoded in two places: `config.ts` default AND `main.rs` line 101. These must stay in sync.

## Target model

### User-facing model
- The user talks to one workspace-level conversation.
- ACC decides which agents run, wait, or need context.
- If the team needs input, ACC asks one coordinated question.
- The user replies once.
- ACC decomposes that reply into per-agent continuation packets.

### Control-plane model
- `ACC Coordinator` owns coordination state and orchestration policy.
- Agents do not negotiate directly with the operator.
- Agents publish structured findings, blockers, and asks into coordination state.
- Downstream agents consume only the findings relevant to their role.

## Architecture decisions

### Prompt-group scoping for team asks

A "prompt round" is one workspace instruction and the team's response to it. Team asks must be scoped to the active round, not to the workspace lifetime. Without scoping, a team ask generated during round 1 surfaces again during round 2 even though those agents have already received fresh instructions — making the workspace conversation feel stitched together.

**Model**:
- Each workspace instruction generates a `promptId` (client-generated, format `workspace-prompt-${timestamp}`, matches the `WorkspaceThreadEntry.id` already used client-side).
- `CoordinationStateRecord.currentPromptId` tracks the active round. It is advanced whenever the coordinator receives a new workspace instruction via `POST /workspaces/:id/coordination/dispatch`.
- `CoordinationTeamAskRecord.promptId` links each team ask to the round that produced it. A new `promptId` always produces a new team ask ID, even if the request set looks identical.
- `CoordinationReplyPacketRecord.promptId` links each reply packet to the round it was dispatched in.
- `teamAskHistory` keeps up to 20 past asks across rounds. The active `teamAsk` field only surfaces the ask for the current `currentPromptId`.

**Why not use the desktop's `WorkspacePromptGroup` directly**: Prompt groups are pure client-side time-window derivations — no durable ID exists on the server. `promptId` is the server-side equivalent, set explicitly by the desktop when dispatching.

### Server-side dispatch as the target architecture

Phase 5 (original plan) had the server decompose a reply into packets and the desktop create individual runs from those packets. This has a partial-dispatch failure mode: if the connection drops between packets, some agents run and others do not, with no recovery path.

The target architecture is fully server-side dispatch:
1. Desktop sends one request: `POST /workspaces/:id/coordination/dispatch` with `replyText + promptId`.
2. The **route handler** (not the coordinator itself) calls `coordinationService.decomposeWorkspaceReply()` to build packets, then calls `runOrchestrator.startRun()` for each eligible packet.
3. Desktop receives `{ status, dispatchedRunIds, blockedAgentIds }` and subscribes to run events via WebSocket.
4. Ordering, gating, and retries are entirely server-side.

**Why route-level orchestration, not inside CoordinationService**: `CoordinationService` only receives `repositories`. `RunOrchestrator` also depends on `CoordinationService` (for gating in Phase 3). Injecting the orchestrator into the coordinator creates a circular dependency. The route handler is the natural composition point — it already orchestrates between services (e.g., `PATCH /handoffs` calls coordinator AND emits events).

**Dispatch only replaces workspace-wide instructions**. Focused-agent messages (`scope === "agent"`) still call `POST /agents/:id/runs` directly — the coordinator is not involved in those.

**Compatibility with Phase 0 and Phase 1**: Both phases are compatible. All prompt-group scoping additions (`promptId`, `currentPromptId`) are additive optional fields. The `CoordinationService` interface additions from Phase 0 (`renderTeamAsk`, `getExecutionPlan`) do not depend on dispatch model. Phase 1's `replyPackets` and `teamAskHistory` fields are used unchanged; `currentPromptId` was added as part of the Phase 1 implementation.

## Phased implementation

### Phase 0: Freeze the current model and add coordinator boundaries ✓ IMPLEMENTED
Goal:
- make the hidden coordinator explicit in the architecture before adding behavior

Current state (read before coding)
- `CoordinationService` interface already exists at `coordination-state.ts` line 879 with three methods: `getWorkspaceState`, `refreshWorkspaceState`, `renderExecutionPacket`.
- `createCoordinationService` factory at line 897 is the sole implementation. It is already wired through `services.ts` to `runtimeManager`, `toolBroker`, and `runOrchestrator` — those callers are clean.
- Two exported functions bypass the interface and are called directly by `runtime-manager.ts` (lines 14–15, 118, 127): `renderAgentCoordinationContext` and `renderWorkspaceCoordinationContext`. These are the only source-level interface bypasses.
- Do NOT introduce a new `CoordinatorService` name. The correct name is `CoordinationService`. The plan's earlier use of `CoordinatorService` was wrong.

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/services.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/services.ts)

Changes
- Add two methods to the existing `CoordinationService` interface (do not create a second interface):
  ```typescript
  renderTeamAsk(workspaceId: string): Promise<CoordinationTeamAskRecord | null>;
  getExecutionPlan(workspaceId: string): Promise<null>; // stub; Phase 1 gives this its real return type
  ```
  Implement both as stubs in `createCoordinationService`:
  - `renderTeamAsk`: call `this.getWorkspaceState(workspaceId)` and return `state?.teamAsk ?? null`.
  - `getExecutionPlan`: return `Promise.resolve(null)`. (**Note**: Phase 1 upgraded this to its real return type — reads from `state.executionPlan`.)
  - `decomposeWorkspaceReply` and `buildWorkspaceCoordinationState` are NOT interface methods in Phase 0. They are internal functions. Do not add them to the interface.
- Remove the `export` keyword from `renderWorkspaceCoordinationContext`, `renderAgentCoordinationContext`, `renderRoleCoordinationContext`, and `buildCoordinationState`. They become private module-level functions.
- Update `runtime-manager.ts` to remove the direct imports of `renderAgentCoordinationContext` and `renderWorkspaceCoordinationContext` at lines 14–15. Replace the two direct calls at lines 118 and 127 with a single call to `coordinationService.renderExecutionPacket(workspaceId, { agentId: agent.id })` and destructure `workspaceContext` and `targetContext` from the returned `RenderedCoordinationPacketRecord`.
- Add the following JSDoc comment immediately above the `CoordinationService` interface declaration:
  ```typescript
  /**
   * Internal control-plane coordinator. Not a user-visible agent.
   * All cross-agent coordination state reads and writes must go through this interface.
   * External callers must never import coordination-state pure functions directly.
   */
  ```
- Document the known dual-write hazard but do not fix it in Phase 0: `refreshWorkspaceState` currently writes `brief` to both `workspace_coordination_states.brief` and `workspaces.layout_config.coordinationBrief` (via `repositories.workspaces.update` at coordination-state.ts lines 937–945). Phase 1 migration 0009 will resolve this by adding a dedicated `coordination_brief` column to `workspaces`. Add a `// TODO(phase-1): remove layoutConfig dual-write once 0009 migration lands` comment at that line.
- No changes to `shared-types/src/index.ts` in Phase 0.
- No schema or migration changes in Phase 0.
- No `any` types or TypeScript error suppressions. The two stub methods must have explicit return type annotations.

Acceptance
- `renderAgentCoordinationContext` and `renderWorkspaceCoordinationContext` are no longer exported from `coordination-state.ts` and are no longer directly imported by any source file.
- `runtime-manager.ts` has zero direct imports from `coordination-state.ts`.
- The `CoordinationService` interface has 5 methods (3 existing + 2 new stubs).
- TypeScript compiles without errors after the change.

### Phase 1: Expand the durable coordinator state model ✓ IMPLEMENTED
Goal:
- persist all information needed for execution gating, findings, asks, and replay

Files
- [/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)

Step 1: TypeScript type definitions (shared-types first, before touching migrations or repositories)

Add these type aliases to `packages/shared-types/src/index.ts`:

```typescript
export type CoordinationDependencyType =
  | "depends_on_finding"
  | "depends_on_agent"
  | "depends_on_handoff"
  | "depends_on_approval"
  | "depends_on_user_input";

export type CoordinatorDecisionType =
  | "run_now"
  | "wait"
  | "resume"
  | "blocked"
  | "ask_user"
  | "request_approval";

export interface CoordinationDependencyEdge {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  dependencyType: CoordinationDependencyType;
  sourceId: string;    // finding ID, handoff ID, approval ID, or agentId depending on type
  reason?: string;
  resolvedAt?: string; // ISO string; absent = unresolved
  createdAt: string;
}

export interface CoordinatorDecisionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  decision: CoordinatorDecisionType;
  reason: string;
  dependencyIds: string[];
  decidedAt: string;
}

export interface CoordinationReplyPacketRecord {
  packetId: string;
  workspaceId: string;
  agentId?: string;
  /** The workspace thread entry ID that triggered this packet. Links packet to a prompt round. */
  promptId?: string;
  content: string;
  renderedAt: string;
}
```

Extend `CoordinationStateRecord` by adding these fields (all are workspace-level):
```typescript
dependencyGraph: CoordinationDependencyEdge[];          // all dependency edges for this workspace
executionPlan: Array<{                                   // per-agent current decision
  agentId: string;
  decision: CoordinatorDecisionType;
  order: number;
  updatedAt: string;
}>;
blockedAgents: Array<{                                  // agents currently waiting
  agentId: string;
  reason: string;
  dependencyId: string;
}>;
coordinatorDecisions: CoordinatorDecisionRecord[];      // capped at 50; drop oldest first
replyPackets: CoordinationReplyPacketRecord[];          // capped at 10; oldest first
teamAskHistory: CoordinationTeamAskRecord[];            // capped at 20; newest first
```

Fix the team ask ID problem: `summarizeTeamAsk` at `coordination-state.ts` line 342 currently generates `id: \`team-ask-${workspaceId}\`` — a deterministic ID that gets overwritten on every refresh, making history impossible. Change to:
- Compare `new Set(incomingRequestIds)` against the `requestIds` of the most recent entry in `teamAskHistory`.
- If the sets differ, generate a new ID using `\`team-ask-${workspaceId}-${Date.now()}\`` and prepend the new record to `teamAskHistory`.
- If the sets are the same, update only `updatedAt` on the existing record and keep the same ID.
- The in-memory `teamAsk` field remains the most recent (index 0 of `teamAskHistory`).

Step 2: Migration 0009

Add to `migrations.ts` as `"0009_coordinator_state_phase1.sql"`:
```sql
-- All new columns are JSON arrays; SQLite ALTER TABLE fills existing rows with the default automatically.
-- No explicit backfill loop is needed for the new array columns.
ALTER TABLE workspace_coordination_states ADD COLUMN dependency_graph     TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_coordination_states ADD COLUMN execution_plan        TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_coordination_states ADD COLUMN blocked_agents        TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_coordination_states ADD COLUMN coordinator_decisions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_coordination_states ADD COLUMN reply_packets         TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_coordination_states ADD COLUMN team_ask_history      TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_coordination_states ADD COLUMN current_prompt_id     TEXT;

-- Migrate existing team_ask snapshot into the new history column.
UPDATE workspace_coordination_states
SET team_ask_history = json_array(json(team_ask))
WHERE team_ask IS NOT NULL AND team_ask != 'null' AND team_ask != '';
```

Use `ensureColumn` (migrations.ts line 258) for each of the **seven** columns, then run the `UPDATE` for the backfill. The six array columns are `TEXT NOT NULL DEFAULT '[]'`; `current_prompt_id` is nullable `TEXT`. No new indexes are required — all querying is done by fetching the workspace row and filtering in application code, consistent with the existing pattern.

Also in migration 0009: add `coordination_brief` as a dedicated column to `workspaces` to resolve the dual-write hazard from Phase 0:
```sql
ALTER TABLE workspaces ADD COLUMN coordination_brief TEXT;
UPDATE workspaces SET coordination_brief = (
  SELECT brief FROM workspace_coordination_states WHERE workspace_id = workspaces.id
) WHERE EXISTS (SELECT 1 FROM workspace_coordination_states WHERE workspace_id = workspaces.id);
```
After this migration lands, remove the `layoutConfig.coordinationBrief` write-through from `refreshWorkspaceState` (the `repositories.workspaces.update` call at coordination-state.ts lines 937–945).

Step 3: Repositories extension

In `repositories.ts`:
- Add seven new fields to `CoordinationStateRow`: `dependency_graph: string | null`, `execution_plan: string | null`, `blocked_agents: string | null`, `coordinator_decisions: string | null`, `reply_packets: string | null`, `team_ask_history: string | null`, `current_prompt_id: string | null`.
- Also add `coordination_brief: string | null` to `WorkspaceRow` (used by `mapWorkspace` to prefer the new dedicated column over `layout_config.coordinationBrief`).
- Add six new parse functions following the same guard-then-flatMap pattern as `parseCoordinationFindingSummaries`. Name them: `parseCoordinationDependencyGraph`, `parseCoordinationExecutionPlan`, `parseCoordinationBlockedAgents`, `parseCoordinatorDecisions`, `parseCoordinationReplyPackets`, `parseCoordinationTeamAskHistory`. Each must default to `[]` on invalid input.
- Extend the `SELECT` query to include all seven new columns plus `current_prompt_id`.
- Extend the `INSERT ... ON CONFLICT DO UPDATE` upsert to write all seven new values.
- Extend `mapCoordinationState` to call all six new parse functions and set `currentPromptId: row.current_prompt_id ?? null`.
- Update both workspace `SELECT` queries (list and findById) to include `coordination_brief`.

Step 4: `getExecutionPlan` stub upgrade

Now that `executionPlan` has a real type, replace the Phase 0 stub in `createCoordinationService`:
```typescript
async getExecutionPlan(workspaceId: string): Promise<Array<{ agentId: string; decision: CoordinatorDecisionType; order: number; updatedAt: string }> | null> {
  const state = await this.getWorkspaceState(workspaceId);
  return state?.executionPlan ?? null;
}
```

Migration safety
- `TEXT NOT NULL DEFAULT '[]'` columns: SQLite fills existing rows automatically on `ALTER TABLE`. No application-level backfill loop is needed for the six new array columns.
- The `team_ask_history` backfill `UPDATE` handles existing team ask snapshots.
- Do not assume a clean database; the `ensureColumn` helper guards against re-running already-applied `ALTER TABLE` statements.

Acceptance
- The control plane can persist and replay coordination decisions, dependency state, reply packets, and team ask history.
- Existing workspaces survive the schema migration without data loss or startup errors.
- `CoordinationStateRecord` has all 15 fields (8 original + 6 Phase 1 fields + `currentPromptId`) with no TypeScript errors.
- `CoordinationTeamAskRecord` carries `promptId?` and `CoordinationReplyPacketRecord` carries `promptId?`.
- The team ask ID is no longer deterministic: a new `promptId` always produces a new ask ID even if the request set is identical; within the same prompt round, the ID is stable across refreshes.
- `migration 0009` adds all 7 new columns (`dependency_graph`, `execution_plan`, `blocked_agents`, `coordinator_decisions`, `reply_packets`, `team_ask_history`, `current_prompt_id`) to `workspace_coordination_states` and `coordination_brief` to `workspaces`.

### Phase 2: Formalize typed findings and subscriptions ✓ IMPLEMENTED
Goal:
- make findings a structured signal and let each agent consume only relevant findings

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts)

Current state (read before coding)
- All 9 finding types (`architecture`, `risk`, `decision`, `blocker`, `dependency`, `test`, `handoff`, `implementation`, `general`) exist in `CoordinationFindingType` and are used consistently.
- `subscribedFindingTypes` is already stored in `CoordinationAgentBriefRecord` (line 128) and round-tripped through `parseCoordinationAgentBriefs`. The persistence is ALREADY DONE. Phase 2 work is improving the classification and subscription LOGIC, not re-implementing persistence.
- `renderAgentCoordinationContext` already renders subscribed types as a string at line 799. No change needed there.
- `deriveFindingSubscriptions` already uses planner recommendations and role metadata (lines 304–340). It is already partially hybrid. The "provider/model-agnostic defaults" referred to in the plan are the three baseline types hardcoded at line 308: `["decision", "blocker", "handoff"]`. No change to the baseline is needed.
- `classifyFindingType` currently accepts only `{source, title?, summary?, detail?}` — it has no way to receive tool call status, approval status, handoff status, or transcript metadata.
- `CoordinationTeamAskRecord.findingTypes` is hardcoded to `["decision", "blocker"]` at line 407 regardless of actual finding types implicated.
- `parseCoordinationFindingSummaries` in `repositories.ts` has an unsafe cast at line ~394 that passes any string value as `findingType` without validation.

Changes

1. Extend `classifyFindingType` signature (additive only — existing classification branches must not change behavior; new inputs are checked first and short-circuit before existing text heuristics):
   ```typescript
   function classifyFindingType(input: {
     source: CoordinationFindingSummaryRecord["source"];
     title?: string;
     summary?: string;
     detail?: string;
     toolCallStatus?: ToolCallStatus;          // 'error' or 'denied' → 'blocker'
     approvalStatus?: ApprovalStatus;          // 'DENIED' → 'blocker'
     handoffStatus?: HandoffStatus;            // 'OPEN' or 'ASSIGNED' → 'handoff'
     transcriptMetadata?: Record<string, unknown>; // if metadata.findingType is a valid CoordinationFindingType, use it directly and skip heuristics
   }): CoordinationFindingType
   ```
   Add these short-circuit checks at the top of the function, before the existing `source === "handoff"` check:
   - If `input.transcriptMetadata?.findingType` is a string in the known 9-element set, return it directly.
   - If `input.approvalStatus === "DENIED"` or `input.toolCallStatus === "error"` or `input.toolCallStatus === "denied"`, return `"blocker"`.
   - If `input.handoffStatus === "OPEN"` or `input.handoffStatus === "ASSIGNED"`, return `"handoff"`.

2. Update the call site in `collectCoordinationSignals` (line ~548): pass `transcriptMetadata: latestTranscriptEntry.metadata` when calling `classifyFindingType` for assistant-reply findings. No other call sites need updating (handoff-source findings and run-error findings already resolve their type via the `source` field).

3. Add `subscriptionReasons` to `CoordinationAgentBriefRecord` in `shared-types/src/index.ts`:
   ```typescript
   subscriptionReasons: Partial<Record<CoordinationFindingType, string>>;
   ```
   Update `deriveFindingSubscriptions` to return `{ types: CoordinationFindingType[]; reasons: Partial<Record<CoordinationFindingType, string>> }` instead of a plain array. The reason string for each type should describe which rule added it (e.g., `"planner:architect role"`, `"baseline:decision"`, `"role:qa"`, etc.). Update `buildAgentBrief` to split this into `subscribedFindingTypes` and `subscriptionReasons`.

4. Fix the unsafe cast in `parseCoordinationAgentBriefs` (`repositories.ts` line ~394): replace the `as CoordinationFindingType` cast with a guard that checks against the known 9-element set. Default to `"general"` for unknown values.

5. Extend the `parseCoordinationAgentBriefs` function to parse `subscriptionReasons`. Default to `{}` when absent or invalid:
   ```typescript
   subscriptionReasons: (record.subscriptionReasons && typeof record.subscriptionReasons === 'object' && !Array.isArray(record.subscriptionReasons))
     ? record.subscriptionReasons as Partial<Record<CoordinationFindingType, string>>
     : {},
   ```

6. Fix the hardcoded `findingTypes: ["decision", "blocker"]` in `summarizeTeamAsk` (line 407). Derive the actual finding types from the implicated action requests: for each `requestId` in `needsInputRequests`, look up whether its ID matches the `coord-finding-*` or `coord-handoff-*` pattern and collect the `findingType`. Replace the hardcoded array with this derived set, falling back to `["decision", "blocker"]` only if no types can be derived.

No schema migration required for Phase 2. All new data (`subscriptionReasons`) is stored inside the existing `agent_briefs` JSON blob column, which accepts any JSON object. The `ensureColumn` default-defaulting means existing rows return `subscriptionReasons: {}` safely.

Acceptance
- The coordinator can explain why a given finding was delivered to agent A and not agent B: inspect `agentBrief.subscriptionReasons[findingType]` to see the rule.
- `classifyFindingType` accepts structured context (tool status, approval status, handoff status, transcript metadata) and agents can self-classify by emitting `findingType` in their transcript metadata.
- `CoordinationTeamAskRecord.findingTypes` reflects actual implicated types, not a hardcoded list.
- The unsafe `parseCoordinationFindingSummaries` cast is replaced with a validated guard.

### Phase 3: Dependency-aware execution gating ✓ IMPLEMENTED

Prerequisite
- A minimal unit test harness must exist for `coordination-state.ts` pure functions before this phase begins.
- Without it, gating regressions are undetectable and debugging execution order bugs will be very slow.
- Minimum required tests before Phase 3 coding starts:
  - `classifyFindingType` with known inputs
  - `deriveFindingSubscriptions` with role + planner hints
  - `buildExecutionPlan` with a simple two-agent dependency
  - `buildCoordinationState` round-trip (build → persist → reload → matches)
- Test harness setup: add `vitest` and `@vitest/coverage-v8` to `apps/control-plane/package.json`. Add a `vitest.config.ts` at `apps/control-plane/vitest.config.ts` with `{ test: { environment: "node" } }`. Add test files as `src/lib/*.test.ts` co-located with the source. Run with `vitest run --reporter=verbose` from the `apps/control-plane` directory. No other test infrastructure changes are needed.

Goal:
- follow planner order when needed and block downstream agents until prerequisites are satisfied

Files
- [/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts)

Current state (read before coding)
- `startRun()` is at `run-orchestrator.ts` line 561. It calls `continueRun()` at line 602 with NO gating check. Any prompt that reaches this function immediately starts executing.
- `buildExecutionPlan` does not exist anywhere in the codebase. Phase 1 adds the `executionPlan` field to `CoordinationStateRecord` but the function that builds it must be written here.
- `CoordinationService` interface (coordination-state.ts line 879) currently has 5 methods after Phase 0. No `checkCanRun` method exists.
- `AgentState` in `shared-types/src/index.ts` does NOT include `WAITING_DEPENDENCY`. All gated agents currently have no distinct state to report to the desktop.
- `refreshCoordination()` at run-orchestrator.ts line 64 already exists and calls `coordinationService.refreshWorkspaceState()`. It is called after approval decisions (lines ~638, ~650) and after `createAgentFromHandoff` (line ~702). The auto-resume hook must follow this same call pattern.

Step 0: Add `QUEUED` to `AgentRunState` and `WAITING_DEPENDENCY` to `AgentState`

Both additions are in `packages/shared-types/src/index.ts`.

- Add `"QUEUED"` to `AgentRunState`. It sits between `"CREATED"` and `"RUNNING"`. After this change `AgentRunState` has 7 values: `CREATED | QUEUED | RUNNING | WAITING_APPROVAL | COMPLETED | ERROR | STOPPED`. A `QUEUED` run is one that has been submitted but is waiting for a dependency to resolve before it enters the tool loop.
- Add `"WAITING_DEPENDENCY"` to `AgentState`. It sits between `"WAITING_INPUT"` and `"STOPPED"`. After this change `AgentState` has 11 values.

Both type changes affect only the union literals in shared-types. No other code changes are needed in this step — `AgentRunState` and `AgentState` are discriminated unions used throughout, so TypeScript will surface any unhandled cases automatically after the change.

Step 1: Add `WAITING_DEPENDENCY` to `AgentState`

(Covered in Step 0 above.)

Step 2: Add two new methods to the `CoordinationService` interface

In `coordination-state.ts`, add to the existing `CoordinationService` interface:
```typescript
checkCanRun(workspaceId: string, agentId: string): Promise<{
  allowed: boolean;
  reason?: string;
  dependencyId?: string;
}>;

resumeBlockedAgents(workspaceId: string): Promise<string[]>; // returns agentIds that were unblocked
```

Implement both in `createCoordinationService`:
- `checkCanRun`: call `this.getWorkspaceState(workspaceId)`. Look up the agent in `state.executionPlan`. If the agent's decision is `"wait"` or `"blocked"`, return `{ allowed: false, reason, dependencyId }`. Otherwise return `{ allowed: true }`. If no state exists or the agent is not in the plan, return `{ allowed: true }` (default open — no gating without a plan).
- `resumeBlockedAgents`: call `this.getWorkspaceState(workspaceId)`. For each entry in `state.blockedAgents`, check whether its dependency is now resolved (finding published, handoff resolved, approval decided). Collect IDs of newly unblockable agents. Call `this.refreshWorkspaceState(workspaceId, ...)` to update `blockedAgents` and `executionPlan`, then return the unblocked agent IDs. The caller is responsible for dispatching new runs to those agents.

Step 3: Implement `buildExecutionPlan` internal function

Add a private `buildExecutionPlan(state: CoordinationStateRecord, agentBriefs: CoordinationAgentBriefRecord[]): Array<{ agentId: string; decision: CoordinatorDecisionType; order: number; updatedAt: string }>` function inside `coordination-state.ts`:

Algorithm:
1. Sort agents by `executionOrder` from their brief (ascending, ties broken by agentId lexicographic order). Agents without `executionOrder` go last.
2. For each agent in order:
   - Check if the agent has any unresolved `CoordinationDependencyEdge` entries in `state.dependencyGraph` where `toAgentId === agent.agentId` and `resolvedAt` is absent.
   - If unresolved dependencies exist: decision = `"wait"`, add to `blockedAgents`.
   - If the agent's most recent `CoordinationActionRequestRecord` has `kind === "approval"` and no resolved approval: decision = `"ask_user"`.
   - If all dependencies resolved and no pending approval: decision = `"run_now"`.
3. Return the plan array. This function is pure — it takes state and returns a new plan. It does NOT write to the database. `refreshWorkspaceState` calls it and writes the result.

Call `buildExecutionPlan` inside `refreshWorkspaceState` (after all other fields are built, before the database write). Assign the result to `coordinationState.executionPlan`.

Step 4: Add gating check in `startRun()`

In `run-orchestrator.ts`, locate `startRun()` at line 561. Before the call to `continueRun()` at line 602, add:
```typescript
// Phase 3: gating check
const gate = await coordinationService.checkCanRun(run.workspaceId, run.agentId);
if (!gate.allowed) {
  await setRunState(runId, "QUEUED"); // QUEUED is an existing AgentRunState value
  await eventService.append({
    agentId: run.agentId,
    workspaceId: run.workspaceId,
    provider: run.provider,
    ts: new Date().toISOString(),
    type: "STATUS_CHANGED",
    payload: { from: run.state, to: "WAITING_DEPENDENCY", reason: gate.reason ?? "Waiting on dependency" },
  });
  return; // do not call continueRun — the run stays queued
}
```
Note: `QUEUED` is an `AgentRunState` value. `WAITING_DEPENDENCY` is an `AgentState` value. These are on different types. Verify the exact run state handling in `run-orchestrator.ts` before coding — use `setRunState` with the correct type.

Step 5: Auto-resume on state refresh

In `run-orchestrator.ts`, after any call to `refreshCoordination()` (lines ~638, ~650, ~702), add:
```typescript
const unblocked = await coordinationService.resumeBlockedAgents(workspaceId);
for (const agentId of unblocked) {
  const pendingRun = await repositories.runs.findQueuedForAgent(agentId);
  if (pendingRun) {
    await continueRun(pendingRun.id); // re-enter the run loop for each newly unblocked agent
  }
}
```
This requires a `findQueuedForAgent(agentId)` method on `repositories.runs` — add it to the runs repository. It returns the most recent run with state `"QUEUED"` for the given agent, or `null`.

Acceptance
- `AgentState` includes `WAITING_DEPENDENCY`.
- `CoordinationService` has `checkCanRun` and `resumeBlockedAgents` methods.
- `startRun()` checks coordination before dispatching. An agent with an unresolved dependency does not begin executing immediately.
- Resolving a dependency (via handoff, approval, or finding publish) automatically resumes any queued agent runs through `resumeBlockedAgents`.
- A workspace command can yield: one agent starts now, one waits for findings, one waits for approval, one waits for user input — without the desktop hard-coding any of that logic.
- TypeScript compiles without errors after the change.

### Phase 4: Team ask synthesizer and single-ask operator surface ✓ IMPLEMENTED

Goal:
- merge multiple agent asks into one operator-facing question in the workspace thread

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css)

Current state (read before coding)
- `summarizeTeamAsk` at coordination-state.ts line 342 currently produces a `CoordinationTeamAskRecord` with hardcoded `findingTypes: ["decision", "blocker"]` (fixed in Phase 2). It does not produce `blockedBranches` or `recommendedResponseShape` — those fields don't exist yet.
- `workspaceConversationGroups` is a `useMemo` at App.tsx line 2220. It builds `WorkspacePromptGroup[]`. Each group has a `teamAsk` field of type `WorkspaceTeamAsk | null`.
- The team ask is already rendered as a single card when `group.teamAsk` is non-null (App.tsx line 7457+).
- The suppression logic at App.tsx line 7458–7461 already hides `needs_input` cards from the coordination queue when a team ask is active for those agentIds. This behavior is ALREADY IMPLEMENTED. Phase 4 improves the synthesized ask content, it does not rewrite the suppression logic.
- `WorkspaceTeamAsk` type at App.tsx line 153: has `id, title, summary, detail, agentIds, requestIds, ts` — missing `blockedBranches` and `recommendedResponseShape`.

Changes

1. Add two new fields to `CoordinationTeamAskRecord` in `packages/shared-types/src/index.ts`:
   ```typescript
   blockedBranches: Array<{
     agentId: string;
     agentTitle: string;
     blockedSince: string;  // ISO string
     blockedReason: string;
   }>;
   recommendedResponseShape: "approval" | "input" | "direction" | "confirmation";
   ```
   Both fields are optional (`?`) so existing records without them remain valid. Default `blockedBranches` to `[]` and `recommendedResponseShape` to `"direction"` when absent.

2. Improve `summarizeTeamAsk` in `coordination-state.ts`:
   - Populate `blockedBranches` from `state.blockedAgents` — map each entry to `{ agentId, agentTitle (from agentBriefs), blockedSince: updatedAt, blockedReason: reason }`.
   - Derive `recommendedResponseShape` from the implicated `findingTypes`:
     - Any `"blocker"` → `"approval"`
     - Any `"dependency"` → `"direction"`
     - Any `"decision"` → `"direction"`
     - Only `"general"` → `"input"`
     - Default → `"direction"`

3. Update `parseCoordinationTeamAsk` in `repositories.ts` to parse the two new optional fields from the JSON blob. Default both to safe values when absent.

4. Update `WorkspaceTeamAsk` type in `App.tsx` to include:
   ```typescript
   blockedBranches: Array<{ agentId: string; agentTitle: string; blockedSince: string; blockedReason: string }>;
   recommendedResponseShape: "approval" | "input" | "direction" | "confirmation";
   ```

5. In the `workspaceConversationGroups` memo (App.tsx line 2220), propagate `blockedBranches` and `recommendedResponseShape` from `CoordinationTeamAskRecord` to `WorkspaceTeamAsk` when mapping the team ask.

6. In the team ask card render (App.tsx line ~7457), show blocked branch summaries when `teamAsk.blockedBranches.length > 0` and add a hint showing `recommendedResponseShape` so the operator knows what kind of reply is expected.

No new migration is needed for Phase 4. The two new fields are inside the existing `team_ask` JSON blob column.

Acceptance
- In all-agent mode, the operator sees one clean team question, not multiple overlapping asks.
- The team ask card shows which agents are blocked and why.
- The team ask card hints at the expected reply shape (approval vs freeform input vs direction).
- `needs_input` cards from individual agents are suppressed when the synthesized team ask covers them (this is already done; Phase 4 enriches the team ask content only).
- TypeScript compiles without errors after the change.

### Phase 5: Server-side dispatch with prompt-group scoping ✓ IMPLEMENTED

Goal:
- The operator sends one workspace reply; the coordinator decomposes it into per-agent packets AND starts the runs server-side. No partial-dispatch failure from mid-loop network drops. Team asks are scoped to one prompt round.

Design (see "Architecture decisions" above for reasoning):
- A single `POST /workspaces/:id/coordination/dispatch` endpoint replaces the desktop's sequential `POST /agents/:id/runs` loop for workspace-wide messages.
- The route handler (not `CoordinationService`) calls `decomposeWorkspaceReply` + `runOrchestrator.startRun` in sequence, avoiding circular dependency.
- Each dispatch carries a `promptId` generated by the desktop that advances `currentPromptId` and scopes the team ask to the new round.

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/workspaces.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/workspaces.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/lib/api.ts](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/lib/api.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx)

Current state (read before coding)
- `POST /workspaces/:id/coordination/dispatch` does NOT exist. Must be added to `workspaces.ts`.
- `decomposeWorkspaceReply` does not exist on `CoordinationService`. Must be added to the interface and implemented.
- `submitWorkspaceInstruction` in App.tsx at line 4707 loops over `targetAgents` sequentially (lines 4778–4791) calling `dispatchInstruction(agent.id, message)` for each. This is the code that must be replaced for workspace-wide messages.
- `CoordinationReplyPacketRecord` (Phase 1) has `packetId, workspaceId, agentId?, promptId?, content, renderedAt`.
- `CoordinationStateRecord.currentPromptId` exists (Phase 1 addition) and is persisted in `workspace_coordination_states.current_prompt_id`.
- `app.acc.runOrchestrator` is available inside route handlers via `app.acc` (same pattern as `app.acc.coordinationService`).

Step 1: Add `decomposeWorkspaceReply` to `CoordinationService` interface

In `coordination-state.ts`, add to the `CoordinationService` interface:
```typescript
decomposeWorkspaceReply(workspaceId: string, input: {
  replyText: string;
  promptId: string;       // advances currentPromptId; scopes team ask to this round
  teamAskId?: string;     // the team ask being answered (if this is a team reply)
}): Promise<{
  status: "routed" | "no_agents" | "all_blocked" | "stale_state";
  packets: Array<{
    agentId: string;
    content: string;      // per-agent continuation, enriched with relevant findings
    intent: string;       // short label: "continue", "unblock", "apply-finding", etc.
  }>;
  blockedAgentIds: string[];
  reason?: string;        // populated when status !== "routed"
}>;
```

Implement in `createCoordinationService`:

Algorithm:
1. Fetch current `CoordinationStateRecord`. If none, return `{ status: "stale_state", packets: [], blockedAgentIds: [] }`.
2. Call `buildCoordinationState({ ..., currentPromptId: input.promptId })` to advance the prompt round. Persist via `repositories.coordination.upsert`. This archives any prior-round team ask into `teamAskHistory`.
3. Collect `eligibleAgents`: entries in `state.executionPlan` where decision is `"run_now"` or `"resume"`. If the execution plan is empty, fall back to all non-stopped agents (Phase 3 hasn't run yet in early phases).
4. If no eligible agents: check whether any have decision `"blocked"` or `"wait"` → `all_blocked`. If no plan entries at all → `no_agents`.
5. For each eligible agent, build a packet:
   - Base: `input.replyText`.
   - Append relevant `sharedFindings` (from `CoordinationAgentBriefRecord.sharedFindings`).
   - Append pending handoff summaries for that agent from `state.handoffSummaries`.
   - Append open `actionRequests` for that agent (kind `"needs_input"` only).
   - Set `intent` from `executionPlan[agent].decision` (`"run_now"` → `"continue"`, `"resume"` → `"unblock"`).
   - Set `promptId: input.promptId` on the packet.
6. Persist packets to `state.replyPackets` (prepend, cap at 10). Save via `repositories.coordination.upsert`.
7. Return `{ status: "routed", packets, blockedAgentIds }`.

Step 2: Add `POST /workspaces/:id/coordination/dispatch` to `workspaces.ts`

Add after the existing `PUT /workspaces/:id/coordination` handler (~line 210 in workspaces.ts). This is the only place where `coordinationService` and `runOrchestrator` are composed together — do not pass the orchestrator into the coordinator service.

```typescript
// POST /workspaces/:id/coordination/dispatch
app.post("/:id/coordination/dispatch", async (request, reply) => {
  const { id: workspaceId } = z.object({ id: z.string() }).parse(request.params);
  const { replyText, promptId, teamAskId } = z.object({
    replyText: z.string().min(1),
    promptId: z.string().min(1),
    teamAskId: z.string().optional(),
  }).parse(request.body);

  const decomposed = await app.acc.coordinationService.decomposeWorkspaceReply(workspaceId, {
    replyText,
    promptId,
    teamAskId,
  });

  if (decomposed.status !== "routed") {
    reply.code(200);
    return { workspaceId, ...decomposed, dispatchedRunIds: [] };
  }

  const dispatchedRunIds: string[] = [];
  for (const packet of decomposed.packets) {
    try {
      const run = await app.acc.runOrchestrator.startRun(packet.agentId, packet.content);
      dispatchedRunIds.push(run.id);
    } catch (err) {
      app.log.warn({ agentId: packet.agentId, err }, "dispatch: startRun failed for agent");
    }
  }

  reply.code(202);
  return {
    workspaceId,
    status: "dispatched" as const,
    dispatchedRunIds,
    blockedAgentIds: decomposed.blockedAgentIds,
  };
});
```

Note: Individual `startRun` failures are logged but do not abort the full dispatch — a partial dispatch is better than no dispatch. Each failed run's agent will surface as `QUEUED` (Phase 3) or `ERROR` on the desktop, giving the operator visibility.

Step 3: Add `dispatchWorkspaceReply` API function in `api.ts`

```typescript
export async function dispatchWorkspaceReply(
  workspaceId: string,
  input: { replyText: string; promptId: string; teamAskId?: string },
): Promise<{
  status: "dispatched" | "no_agents" | "all_blocked" | "stale_state";
  dispatchedRunIds: string[];
  blockedAgentIds: string[];
  reason?: string;
}> {
  return requestJson(`/api/v1/workspaces/${workspaceId}/coordination/dispatch`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
```

Step 4: Update `submitWorkspaceInstruction` in App.tsx

The desktop generates a `promptId` that matches the `WorkspaceThreadEntry.id` it already creates (format `workspace-prompt-${Date.now()}`). This ties the server's `currentPromptId` to the client-side prompt group identity.

Replace the sequential loop at lines 4778–4791 with a dispatch-aware path for workspace-wide messages:

```typescript
// Generate promptId matching the WorkspaceThreadEntry.id already created at line 4734
const promptId = `workspace-prompt-${queuedAt}`; // queuedAt is set when the entry is created

if (scope !== "agent") {
  // Workspace-wide instruction: let the coordinator dispatch
  const result = await dispatchWorkspaceReply(workspaceId, {
    replyText: message,
    promptId,
    teamAskId: activeWorkspaceTeamAsk?.id,
  });

  if (result.status === "dispatched") {
    // runs are already started server-side; subscribe to events via WebSocket
    dispatchedRuns = result.dispatchedRunIds.map((runId) => ({ id: runId }));
  } else if (result.status === "all_blocked") {
    setWorkspaceNotice({ tone: "info", text: "All agents are waiting on dependencies. Reply queued." });
    return;
  } else if (result.status === "no_agents") {
    setWorkspaceNotice({ tone: "error", text: "No eligible agents to receive this reply." });
    return;
  } else {
    // stale_state: fall back to direct broadcast and log
    for (const agent of targetAgents) {
      const run = await createAgentRun({ agentId: agent.id, prompt: message });
      dispatchedRuns.push(run);
    }
    console.warn("Coordinator state stale; used direct broadcast fallback");
  }
} else {
  // Focused-agent message: direct path, coordinator not involved
  for (const agent of targetAgents) {
    const run = await createAgentRun({ agentId: agent.id, prompt: message });
    dispatchedRuns.push(run);
  }
}
```

The `queuedAt` value is already set at line 4734 (format `new Date().toISOString()`). Use `Date.now()` to match the existing entry ID format. Do NOT regenerate it — use the same timestamp that was used to build `WorkspaceThreadEntry.id` so the server-side `currentPromptId` matches the client-side group identity.

Fallback contract
- `dispatched` — runs started server-side; desktop subscribes to events, no further action needed.
- `no_agents` — no eligible agents; desktop shows status message, does NOT dispatch anything.
- `all_blocked` — all agents blocked on dependencies; desktop shows blocked state.
- `stale_state` — coordinator state could not be rebuilt; desktop falls back to direct broadcast and logs warning.
- Individual agent `startRun` failures do not abort the dispatch. Each failure is logged server-side and the agent surfaces as `ERROR` or `QUEUED` on the desktop.

Acceptance
- One `POST /workspaces/:id/coordination/dispatch` call starts all eligible agent runs server-side. The desktop does not call `POST /agents/:id/runs` for workspace-wide instructions.
- The `currentPromptId` in `CoordinationStateRecord` equals the `promptId` sent by the desktop.
- The team ask generated after dispatch has `promptId` matching `currentPromptId` — it is scoped to the new round, not the previous one.
- Focused-agent messages (`scope === "agent"`) still use the direct `POST /agents/:id/runs` path unchanged.
- TypeScript compiles without errors after the change.

### Phase 6: Handoffs, blockers, and findings as live coordination signals ✓ IMPLEMENTED

Goal:
- make handoffs and blockers actively affect downstream work, not just appear in review queues

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/handoffs.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/handoffs.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts)

Current state (read before coding)
- There is NO `POST /handoffs` route for creating handoffs. Handoffs are created ONLY via the `create_handoff` tool in `tool-broker.ts` at line 632–661. The `create_handoff` case already calls `coordinationService.refreshWorkspaceState()` at line 652. This is the correct trigger insertion point for `onHandoffCreated`.
- `PATCH /handoffs/:id` at `handoffs.ts` line 31 already calls `coordinationService.refreshWorkspaceState()` at line 43 for status updates. This is where `onHandoffResolved` must be called.
- `RunOrchestrator` does not call `onRunCompleted` or `onBlockerDetected` — these must be added.
- After a run reaches COMPLETED at run-orchestrator.ts line ~324 (`setRunState(runId, "COMPLETED")`), there is no coordinator callback.
- Tool failures are returned via the `TOOL_RESULT` event with `isError: true`. The current code does not classify tool failures as blocker signals.

Step 1: Add four new methods to `CoordinationService` interface

In `coordination-state.ts`, add to the `CoordinationService` interface:
```typescript
onHandoffCreated(workspaceId: string, handoffId: string): Promise<void>;
onHandoffResolved(workspaceId: string, handoffId: string): Promise<void>;
onRunCompleted(workspaceId: string, agentId: string, runId: string, outcome: "completed" | "error"): Promise<void>;
onBlockerDetected(workspaceId: string, agentId: string, description: string, toolName?: string): Promise<void>;
```

Implement all four in `createCoordinationService`. Each implementation:
- Fetches current state.
- Updates the dependency graph (marks relevant edges as resolved or adds a new blocker edge).
- Calls `refreshWorkspaceState` to persist and rebuild execution plan.
- `onHandoffCreated`: adds a `CoordinationDependencyEdge` with `dependencyType: "depends_on_handoff"`, `fromAgentId = handoff.assignedAgentId ?? ""`, `toAgentId = targetAgentId` (derive from handoff context), `sourceId = handoffId`.
- `onHandoffResolved`: marks all dependency edges with `sourceId === handoffId` as resolved by setting `resolvedAt = new Date().toISOString()`.
- `onRunCompleted`: marks all `"depends_on_agent"` edges where `fromAgentId === agentId` as resolved when `outcome === "completed"`.
- `onBlockerDetected`: creates a new `CoordinationActionRequestRecord` with `kind: "needs_input"`, appends it to `state.actionRequests`, refreshes state. This surfaces the blocker in the team ask on next synthesis.

Step 2: Trigger wiring — handoff creation in `tool-broker.ts`

In `tool-broker.ts`, in the `create_handoff` tool case at line 652, after the existing `coordinationService.refreshWorkspaceState(...)` call, add:
```typescript
await coordinationService.onHandoffCreated(workspaceId, handoff.id);
```
The `workspaceId` is available from the run context passed into the tool broker's tool call handler.

Step 3: Trigger wiring — handoff resolution in `handoffs.ts`

In `handoffs.ts`, in the `PATCH /handoffs/:id` handler at line 43, after the existing `coordinationService.refreshWorkspaceState(...)` call, add:
```typescript
if (body.status === "COMPLETED" || body.status === "CANCELLED") {
  await coordinationService.onHandoffResolved(handoff.workspaceId, handoff.id);
}
```
The `handoff.workspaceId` is available on the fetched handoff record.

Step 4: Trigger wiring — run completion in `run-orchestrator.ts`

In `run-orchestrator.ts`, after every `setRunState(runId, "COMPLETED")` and `setRunState(runId, "ERROR")` call, add:
```typescript
await coordinationService.onRunCompleted(run.workspaceId, run.agentId, runId, outcome);
const unblocked = await coordinationService.resumeBlockedAgents(run.workspaceId);
for (const unblockedAgentId of unblocked) {
  const pendingRun = await repositories.runs.findQueuedForAgent(unblockedAgentId);
  if (pendingRun) {
    void continueRun(pendingRun.id); // fire non-blocking — each run manages its own loop
  }
}
```
Do not await the `continueRun` calls for unblocked agents — they run independently.

Step 5: Trigger wiring — tool error in `run-orchestrator.ts`

In the tool result processing loop (run-orchestrator.ts around line 330, where `toolResult.isError` is checked), after recording the tool result event, add:
```typescript
if (toolResult.isError) {
  await coordinationService.onBlockerDetected(
    run.workspaceId,
    run.agentId,
    `Tool ${toolCall.name} failed`,
    toolCall.name,
  );
}
```

Acceptance
- Handoffs and blockers are part of live coordination, not just static artifacts in Inbox.
- Creating a handoff via the `create_handoff` tool immediately updates the dependency graph.
- Resolving a handoff (via `PATCH /handoffs/:id` with `status: "COMPLETED"`) automatically unblocks dependent agents without a manual operator refresh.
- Completing a run automatically resumes any agents that depend on that agent's completion.
- Tool errors surface as blocker signals in the team ask.
- TypeScript compiles without errors after the change.

### Phase 7: Command/tool-access escalation translation ✓ IMPLEMENTED

Goal:
- agents should ask for access, not tell the operator to run commands manually

Files
- [/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx)

Design note — do not use transcript text pattern matching
- Detecting phrases like “please run” or “I need shell access” from raw prose is fragile. Agent models (Claude vs Codex) phrase the same intent differently, and this produces false positives and missed detections.
- Instead, teach agents to emit structured signals. The coordinator handles typed signals, not text inference.

Current state (read before coding)
- `CoordinationFindingType` uses lowercase string literals (`”architecture”`, `”risk”`, `”decision”`, etc.). Any new types MUST also be lowercase.
- `ApprovalRequestRecord` has `toolCallId: string` as non-nullable. This means you CANNOT create an `ApprovalRequestRecord` synthetically without a real tool call — doing so would violate the schema. Do NOT try to create an `ApprovalRequestRecord` in the coordinator for access requests. Use `CoordinationActionRequestRecord` (kind: `”approval”`) instead.
- `CoordinationActionRequestRecord` with `kind: “approval”` is the correct model for coordinator-generated access requests. It is already rendered in the team ask and inbox flows.
- `buildSystemPrompt` at runtime-manager.ts lines 82–90 already instructs agents: `”If you need command access, prefer the command tool path over plain-text instructions like 'please run this for me'.”` This is a start, but it doesn't teach agents about the structured `findingType` signal.
- The `transcriptMetadata` short-circuit added in Phase 2 to `classifyFindingType` is the mechanism that lets agents self-classify findings by including `findingType` in their transcript metadata. Phase 7 builds on that.

Changes

1. Add two new finding types to `CoordinationFindingType` in `packages/shared-types/src/index.ts`:
   ```typescript
   // ADD to the CoordinationFindingType union (use lowercase to match existing convention):
   | “command_request”   // agent needs a shell command or script executed
   | “access_request”   // agent needs a tool, credential, or permission it does not have
   ```
   After this change, `CoordinationFindingType` has 11 values.

2. Update `buildSystemPrompt` in `runtime-manager.ts` to extend the execution policy section (lines 82–90). Add one new bullet to the existing `Execution policy` block:
   ```
   - If you need a shell command executed on your behalf or need a tool/credential/permission you do not have, emit a structured finding with type “command_request” or “access_request” in your response metadata rather than asking the operator in plain text. Example metadata: {“findingType”: “command_request”, “commandDescription”: “npm install”}.
   ```
   Do not change the existing policy bullets. Only add this one new bullet.

3. Coordinator handling in `coordination-state.ts`: when `collectCoordinationSignals` processes a finding with `findingType === “command_request”` or `findingType === “access_request”`:
   - Create a `CoordinationActionRequestRecord` with `kind: “approval”`, `title` = `”Access request: ${finding.title}”`, `summary` = `finding.summary`.
   - Set the agent's execution plan decision to `”request_approval”` by adding a `CoordinatorDecisionRecord`.
   - Add a `CoordinationDependencyEdge` with `dependencyType: “depends_on_approval”` pointing to this action request ID.
   Do NOT create an `ApprovalRequestRecord` — that type requires a live tool call ID and is managed by the `RunOrchestrator`. Use `CoordinationActionRequestRecord` throughout.

4. In the desktop (App.tsx), the `coordinationQueue` in `WorkspacePromptGroup` (line ~167) already surfaces `CoordinationActionRequestRecord` items as `WorkspaceCoordinationQueueItem` with `kind: “approval”`. These will automatically show inline in the workspace thread when the coordinator creates them. No new UI component is needed. However, ensure the `kind: “approval”` queue item renders an approve/deny action inline — check the existing render at App.tsx line ~7457 and ensure `approval` kind items show a decision button, not just a text card.

5. Remove any prose-scanning logic from the coordinator if any was added during earlier development. The signal is the finding type, not the text.

Acceptance
- The operator sees coordinator-generated approval flows when an agent requests command access or a new tool, not raw prose in the transcript.
- The approach works identically across Claude and Codex agents because it is based on structured output (transcript metadata `findingType`), not text patterns.
- `command_request` and `access_request` findings gate the requesting agent via `CoordinationActionRequestRecord` of kind `”approval”`, not via `ApprovalRequestRecord`.
- TypeScript compiles without errors. No uppercase finding type constants are introduced.

### Phase 8: Workspace becomes the only normal action surface ✓ IMPLEMENTED

Goal:
- make the workspace thread the single normal conversation surface

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css)

Current state (read before coding)
- `workspaceConversationGroups` at App.tsx line 2220 already builds `WorkspacePromptGroup[]`. Each group has `agentThreads`, `coordinationQueue`, `coordinationFindings`, and `teamAsk`.
- The workspace thread renders these groups at App.tsx line ~7455. The current rendering is correct in structure but items from `coordinationQueue` that are not directly related to the current prompt group may still surface.
- The `Inbox` view (`homeThread.kind === "inbox"`) renders `HandoffItemRecord` and `ApprovalRequestRecord` items. This should remain as a secondary audit surface — it is NOT being replaced.
- Agent replies and approval actions are already shown inline in the workspace thread. The primary gap is that some operational controls (run stop, agent filter buttons, roster management) appear in the workspace thread header or sidebar rather than being accessible only in the agent detail view.
- The `RightSidebarTab` type includes `"files" | "terminal" | "artifacts" | "details"`. These panels are already accessible via the inspector sidebar.

Changes

1. In `workspaceConversationGroups` (App.tsx line 2220), filter `coordinationQueue` items to only include items whose `agentId` appears in the current prompt group's `agentThreads`. Do not surface coordination queue items from agents that are not part of the current prompt group — they belong to a different conversation branch.

2. In the prompt group render (App.tsx line ~7455), collapse the `coordinationFindings` list by default if it has more than 3 entries. Add a "Show all findings" toggle. This prevents long finding lists from burying the team ask and reply flow.

3. Move "Stop all runs" and "Interrupt agent" buttons out of the workspace thread header. These controls should only appear in the agent inspector panel (right sidebar `"session"` tab). In the workspace thread, show only the broadcast composer and the team ask card.

4. When `workspaceFocusedAgent` is set (user clicked a specific agent), the workspace thread should show only that agent's thread and suppress the team ask card. This per-agent focus mode is already partially implemented — verify that the `workspaceFocusedAgent` guard on the team ask render (App.tsx line ~2657) is active and correct.

5. In `styles.css`, ensure the `.workspace-conversation-stream` has `overflow-y: auto` and that the `.fleet-activity-panel` does not expand to push the composer out of view. The composer must always be visible at the bottom of the workspace thread without scrolling.

No API changes are needed for Phase 8. All changes are in App.tsx rendering logic and CSS.

Acceptance
- The operator can initiate, review, approve, and continue agent work entirely from the `Workspace` thread.
- `Inbox` remains accessible but is not required for normal workflow.
- Coordination queue items are scoped to their prompt group, not shown globally.
- Long finding lists are collapsed by default and expandable.
- The broadcast composer is always visible at the bottom without scrolling.

### Phase 9: UX polish after the behavior is correct ✓ IMPLEMENTED

Goal:
- make it feel closer to Codex / Claude Code while preserving the multi-agent model

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css)

Current state (read before coding)
- The workspace thread uses `.thread-stream.workspace-conversation-stream` as the scroll container.
- Agent reply cards use `.workspace-agent-thread` and `.workspace-reply-item` CSS classes.
- The team ask card uses `.workspace-team-ask-card` (or similar — verify exact class name in styles.css before touching it).
- The fleet activity strip uses `.fleet-activity-panel` and is positioned alongside the thread.
- The roster sidebar uses `.agent-roster` or similar.
- The broadcast composer uses `.broadcast-composer` or similar.
- Phase 9 MUST NOT change behavior — only visual tightening.

Changes

1. **Workspace header — tighten**: reduce padding on `.workspace-header` to match Codex-style compact header (16px padding instead of 24px). Reduce font size of the workspace name to `0.85rem`. Keep the agent filter pills but make them smaller (use `.pill-xs` if available, otherwise add it).

2. **Team ask card — cleaner**: the team ask card should use a left-border accent (2px solid, accent color) instead of a full background-fill card. Render the `title` in bold, `summary` in muted text, and `blockedBranches` as a compact inline list with agent initials. Add a dismiss chevron to collapse it. Class: `.workspace-team-ask-card`.

3. **Agent replies — compact**: reduce the gap between agent reply cards from 16px to 8px. Agent title should be on the same line as the first sentence of the reply, not a separate header row. Use `.workspace-reply-compact` class for this layout. Keep the approval and handoff inline actions but make them smaller buttons (`.action-xs`).

4. **Findings — collapsed by default**: add a `<details>` or controlled expand/collapse on `.coordination-findings-list`. Show first 2 findings inline; add "N more" toggle link for the rest.

5. **Roster — side rail only**: the agent roster panel should not take up the left sidebar when the workspace thread is active. Move it to a collapsible right-rail strip that shows agent initials + state indicator dot only. Expand on hover or click to show full agent card. Apply a `[data-roster-compact]` attribute on the roster container to enable the compact mode in CSS.

6. **Scroll stability**: in `workspaceShouldAutoScrollRef` logic, ensure the scroll anchor is the bottom of the `.workspace-conversation-stream` container. The current behavior scrolls on every update including minor re-renders. Debounce the auto-scroll trigger to fire only when a NEW prompt group or reply is added, not on every state update.

7. **Inline approvals**: approval action buttons (approve/deny) in the workspace thread should render as `.inline-decision-approve` / `.inline-decision-deny` with a fixed minimum width of 80px and a subtle border, so they stand out without looking like primary CTAs.

Acceptance
- The workspace reads like one coherent conversation rather than a stitched control-plane page.
- Visual style is closer to Codex/Claude Code (compact, no decorative borders everywhere, focus on the content).
- No behavior changes from Phase 8. Only CSS and render structure changes.
- Scroll behavior is stable — the thread does not jump unexpectedly when new content arrives.

### Phase 10: Infrastructure reliability and adapter parity ✓ IMPLEMENTED

Goal:
- make the system production-stable — tool execution cannot hang, adapters can survive transient failures, and the Codex adapter behaves the same as the Claude adapter

Files
- [/Users/ravindargujral/Downloads/ai-ace/packages/adapter-codex/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/adapter-codex/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/packages/adapter-claude/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/adapter-claude/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts)

Current state (read before coding)
- `executeToolCall` in run-orchestrator.ts delegates to `toolBroker.execute()`. There is no timeout — a hung tool execution blocks the run forever.
- Claude adapter has a 10s heartbeat interval (emits HEARTBEAT events). Codex adapter has no heartbeat mechanism at all.
- Neither adapter has retry or backoff logic. A 429 or transient 503 from the provider API surfaces immediately as a hard error that terminates the run.
- Model pricing is hardcoded in both adapters. When Anthropic or OpenAI changes pricing, the numbers must be updated manually with no signal that they are stale.

Step 1: Tool execution timeout in `run-orchestrator.ts`

Wrap `toolBroker.execute()` in a `Promise.race` with a timeout:
```typescript
const TOOL_EXECUTION_TIMEOUT_MS = 60_000; // 60 seconds

async function executeToolCallWithTimeout(
  runId: string,
  toolCall: AdapterToolCall,
  context: ...,
): Promise<ToolResult> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Tool ${toolCall.name} timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`)), TOOL_EXECUTION_TIMEOUT_MS)
  );
  return Promise.race([toolBroker.execute(runId, toolCall, context), timeoutPromise]);
}
```
Replace the `executeToolCall` call in `continueRun` with `executeToolCallWithTimeout`. When timeout fires, treat it as a tool error (set tool call status to `"error"`, continue the run loop with an error result).

`TOOL_EXECUTION_TIMEOUT_MS` should be a configurable constant at the top of run-orchestrator.ts (not a magic number inline).

Step 2: Codex adapter heartbeat parity

In `adapter-codex/src/index.ts`, add a heartbeat interval matching the Claude adapter's pattern. After `streamEvents` is called, start a `setInterval` at 10,000ms that emits `{ type: "HEARTBEAT", payload: { status: "alive" } }` via `onEvent`. Clear the interval when `unsubscribe()` is called. This ensures the runtime-manager's heartbeat tracking works identically for Codex and Claude agents.

Step 3: Retry/backoff for adapter API calls

Add a `withRetry` wrapper used by both adapters:
```typescript
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
```
Wrap the `fetch` call in both `adapter-claude` and `adapter-codex` `sendInput` implementations with `withRetry({ maxAttempts: 3, baseDelayMs: 1000, retryOn: isTransientError })`. Define `isTransientError` to return `true` for HTTP 429 and 503 status codes. Do not retry `AdapterConfigurationError` or `AdapterBusyError`.

Step 4: Adapter pricing maintenance strategy

Add a `MODEL_PRICING_UPDATED_AT` constant at the top of each adapter file:
```typescript
// Pricing last verified: 2026-04-03. Check provider docs if costs look wrong.
const MODEL_PRICING_UPDATED_AT = "2026-04-03";
```
This is a documentation convention, not a runtime check. It gives the next developer a clear signal that the pricing table needs verification when updating models.

Acceptance
- A hung tool call cannot block a run indefinitely — 60s timeout terminates it with a clean error.
- Codex agents emit HEARTBEAT events on the same 10s cadence as Claude agents.
- Transient 429/503 errors from either provider are retried up to 3 times with exponential backoff before surfacing as hard errors.
- Adapter pricing tables have a last-verified timestamp in the source.

### Phase 11: Security and safety hardening ✓ IMPLEMENTED

Goal:
- prevent path traversal and unscoped command execution in the Tauri backend and control-plane API

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/src/main.rs](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/src/main.rs)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/app.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/app.ts) (or wherever CORS is configured)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts)

Current state (read before coding)
- `run_terminal_command` in main.rs (line 717) runs `sh -lc <command>` in any `cwd` the caller specifies. No check that `cwd` is inside a workspace project root.
- `write_text_file` in main.rs (line 695) canonicalizes the path but does not check that the canonical path is inside any workspace root. Any file on the filesystem can be overwritten.
- The control-plane Fastify app has CORS configured with `origin: true` (allow all origins). Since the control plane is localhost-only in production, this is low risk but should be tightened.
- The `run_command` tool in tool-broker.ts already restricts `cwd` to the workspace `projectRoot` (verified). The Tauri terminal command does not have this protection.

Step 1: Restrict `run_terminal_command` to workspace roots in `main.rs`

The Tauri command currently accepts any `cwd`. It should validate that the canonical `cwd` is a subdirectory of a known workspace root. However, `main.rs` has no access to workspace data — workspace roots are stored in the control-plane database.

The simplest safe approach: add an `allowed_roots: Vec<String>` parameter to `run_terminal_command`. The desktop passes `workspace.projectRoot` as the only allowed root. Rust validates `canonical_cwd.starts_with(&canonical_root)` before executing:
```rust
fn is_within_any_root(cwd: &Path, allowed_roots: &[String]) -> bool {
    allowed_roots.iter().any(|root| {
        fs::canonicalize(root)
            .map(|canonical_root| cwd.starts_with(&canonical_root))
            .unwrap_or(false)
    })
}
```
If `is_within_any_root` returns `false`, return `Err("Terminal cwd is outside the allowed workspace root.".to_string())`.

Update the TypeScript `runTerminalCommand` API function in `api.ts` to pass `allowedRoots: [workspace.projectRoot]`.

Step 2: Restrict `write_text_file` to workspace roots in `main.rs`

Apply the same `allowed_roots` parameter pattern to `write_text_file`. The desktop passes `workspace.projectRoot`. Validate that `canonical_path.starts_with(&canonical_root)` before writing.

Step 3: Tighten CORS in the control-plane

In the Fastify app setup (wherever CORS is configured), replace `origin: true` with:
```typescript
origin: ["http://127.0.0.1:7711", "http://localhost:7711", "tauri://localhost"],
```
This restricts CORS to the embedded control-plane origin and the Tauri app origin. External web pages cannot make credentialed requests to the control plane.

Step 4: No changes to tool-broker.ts — `run_command` tool already validates against `workspace.projectRoot`. Document this in a comment above the cwd validation check so it's clear the restriction is intentional.

Acceptance
- `run_terminal_command` cannot execute commands outside the workspace project root.
- `write_text_file` cannot overwrite files outside the workspace project root.
- CORS is restricted to localhost and Tauri origins.
- Existing tool-broker.ts cwd restriction is documented.
- TypeScript compiles without errors after the Rust parameter changes.

## Cross-cutting: IDE vision and agent communication model

### What this system builds toward

The final state is an IDE-like environment where:
- The operator talks to one workspace conversation, not to individual agents.
- Multiple agents (Claude, Codex, or any adapter) work on different parts of a problem in parallel or in sequence, coordinated automatically.
- Context is durable across app restarts, across provider switches, and across agent generations.
- Agents share relevant discoveries without the operator having to relay information between them.

### How agents communicate with each other

Agents do NOT communicate directly. There is no agent-to-agent RPC or chat channel. All inter-agent communication is **indirect via the coordinator**:

1. An agent publishes a `CoordinationFindingSummaryRecord` (via `collectCoordinationSignals` in `refreshWorkspaceState`). This records what the agent learned.
2. The coordinator classifies the finding type and routes it to downstream agents based on their `subscribedFindingTypes`.
3. On the next turn, a downstream agent receives the relevant finding in its `renderAgentCoordinationContext` output — part of its context window.
4. Handoffs (`create_handoff` tool) are the explicit hand-over mechanism: an agent signals that another agent should pick up a task, with a structured prompt and artifact IDs.

This is intentional. Direct agent-to-agent channels would create race conditions and make replay impossible. The coordinator's durable state is the message bus.

### Context preservation across providers

- The `CoordinationAgentBriefRecord` for each agent contains `summary`, `instructions`, `coordinationNotes`, `risks`, `sharedFindings`, and `relatedHandoffIds` — all rendered into the agent's context window at session start and on each turn.
- This brief is built from the planner recommendation AND from live findings accumulated during the session.
- When an agent is stopped and restarted (even after an app restart), it receives the same brief, so it has continuity of context without re-reading the full transcript.
- The `RenderedCoordinationPacketRecord` returned by `renderExecutionPacket` is what the agent actually sees — it is the serialized form of the coordinator's knowledge about the agent's role, dependencies, and pending asks.

### Provider-agnostic coordination

- The coordinator knows each agent's `provider` (claude/codex) and `model` but treats them symmetrically. All coordination signals go through the same `CoordinationService` regardless of provider.
- The `buildSystemPrompt` function in `runtime-manager.ts` injects the coordination packet via the `attachments` mechanism (`SendInputReq.attachments`), not via separate provider-specific context APIs. Both the Claude and Codex adapters receive this the same way.
- The structured finding type approach in Phases 2 and 7 is specifically designed to be provider-agnostic: a Claude agent and a Codex agent both emit the same `findingType` in transcript metadata, and the coordinator handles it identically.

### Runs and agent lifecycle

- Agents are persistent sessions (`AgentSessionRecord`). They survive across multiple runs.
- Runs (`AgentRunRecord`) are individual task executions within a session. One agent can have many runs.
- Creating a run: `POST /api/v1/agents/:agentId/runs` → `createAgentRun` in `api.ts` → `runOrchestrator.startRun()`.
- The coordination brief is injected at run start AND on every `sendInput` call via `coordinationService.renderExecutionPacket()`.
- When a run is queued (Phase 3 gating), it waits in `"QUEUED"` state until its dependencies resolve. No new session or adapter connection is created for queued runs.

## Delivery order

### Track 1: Coordinator (phases 0–9, sequential)
1. Phase 0: coordinator boundary — seal bypasses, add interface stubs
2. Phase 1: durable state expansion — schema + migration safety
3. Phase 2: typed findings and subscriptions — structured signal model
4. Phase 3: dependency-aware execution gating (requires `QUEUED` state from Step 0)
5. Phase 4: team ask synthesizer
6. Phase 5: reply decomposition
7. Phase 6: handoff/blocker integration
8. Phase 7: approval/escalation translation
9. Phase 8: workspace-only action surface
10. Phase 9: UX polish

### Track 2: Infrastructure (phases 10–11, can run in parallel with Track 1 phases 4–9)
11. Phase 10: infrastructure reliability and adapter parity
12. Phase 11: security and safety hardening

Phases 10 and 11 are independent of the coordinator track. They can be worked on in parallel with coordinator phases 4–9. They MUST be complete before a production release.

## Definition of done

### Coordinator behavior
- User gives one workspace instruction.
- ACC decides which agents run now and which wait.
- Agents publish structured findings into durable coordination state.
- Downstream agents receive only relevant findings.
- If the team needs input, ACC asks one clean question in `Workspace`.
- User replies once.
- ACC decomposes that reply into per-agent packets.
- Agents resume in the correct order.
- Command access requests become coordinator-generated approval flows, not manual chores.
- Handoffs and blockers actively affect downstream execution.
- All of the above survives app restart.

### Reliability and safety
- A hung tool call is terminated after 60 seconds, not held indefinitely.
- Transient provider errors (429, 503) are retried before surfacing to the operator.
- Both Claude and Codex agents emit heartbeat events on the same cadence.
- Terminal and file commands in the desktop cannot reach outside the workspace project root.
- CORS is restricted to localhost and Tauri origins.

## Concrete acceptance checks by file area

### Shared types and persistence
- [/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/shared-types/src/index.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts)
Checks:
- coordinator state can store dependency graph, decisions, reply packets, and team ask history

### Control-plane coordinator behavior
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/runtime-manager.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/tool-broker.ts)
Checks:
- gated execution respects planner order and dependencies
- team asks are synthesized once
- reply packets are rendered server-side
- manual command asks become approval flows

### Routes and API
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/workspaces.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/workspaces.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/agents.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/agents.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/handoffs.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/handoffs.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/lib/api.ts](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/lib/api.ts)
Checks:
- desktop can fetch coordination state, rendered packets, and team reply decomposition results

### Desktop workspace thread
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/styles.css)
Checks:
- workspace is the only normal action surface
- one prompt group renders one conversation branch
- team ask appears once
- operator replies once
- approvals and follow-ups remain available inline

## Test plan

### Test harness setup (prerequisite for Phase 3)
- Add `vitest` and `@vitest/coverage-v8` to `apps/control-plane/package.json`.
- Add `vitest.config.ts` at `apps/control-plane/vitest.config.ts`: `{ test: { environment: "node" } }`.
- Test files live as `src/lib/*.test.ts` co-located with source. Run with `vitest run` from `apps/control-plane`.
- No other infrastructure changes needed.

### Control-plane unit tests (in `apps/control-plane/src/lib/`)

**`coordination-state.test.ts`:**
- `classifyFindingType` — one assertion per known finding type, both regex path and structured short-circuit path (Phase 2)
- `deriveFindingSubscriptions` — role-based subscription rules, baseline always included
- `buildExecutionPlan` — two-agent dependency: agent A unblocked, agent B blocked until A completes
- `checkCanRun` — agent in `wait` decision returns `allowed: false`; agent in `run_now` returns `allowed: true`
- `resumeBlockedAgents` — resolving a dependency returns the previously-blocked agentId
- `summarizeTeamAsk` — deterministic ID is replaced by unique IDs when request set changes (Phase 1 fix)
- `decomposeWorkspaceReply` — `stale_state` returned when no coordination state exists; `routed` with packets when agents eligible

**`run-orchestrator.test.ts`:**
- Tool execution timeout: mock a tool that never resolves; verify it's rejected after `TOOL_EXECUTION_TIMEOUT_MS`
- Gating: `startRun()` with a blocked agent emits `WAITING_DEPENDENCY` status event and does not call `sendInput`
- Auto-resume: completing run A triggers `continueRun` for a queued run B that depended on A

**`adapter-codex.test.ts`:**
- Heartbeat events emitted at 10s interval (use fake timers)

### Tauri safety tests (manual)
- `run_terminal_command` with `cwd` outside `allowedRoots` returns an error
- `write_text_file` with path outside `allowedRoots` returns an error

### Desktop integration checks (manual)
- `Workspace` all-agent prompt → ACC routes to multiple agents with individual packets
- One team ask card visible when multiple agents have `needs_input` action requests
- One shared reply through the composer reaches the correct agents based on coordinator decomposition
- Focused-agent override path bypasses coordinator decomposition and sends directly
- App restart: `QUEUED` runs resume automatically; `WAITING_DEPENDENCY` agents resume when dependency resolves

### Smoke checks
- Planner recommendation persists into `CoordinationBriefRecord` and appears in agent briefs
- Planner execution order gates agents (agent 2 waits for agent 1 to publish findings)
- Shared findings appear in downstream agent briefs on their next turn
- Approval requests surface inline in `Workspace` coordination queue
- `command_request` finding creates a `CoordinationActionRequestRecord` of kind `approval`
- Handoff created via `create_handoff` tool immediately updates the dependency graph

### Phase 12: Code organization — split large files

Goal:
- make the three largest files maintainable by splitting each into focused modules with clear responsibilities

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/agents.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/routes/agents.ts) (~9k lines)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts) (1012 lines)
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src/App.tsx) (~10k lines)

Current state (read before coding)
- `agents.ts` registers all agent-related routes in one file. The concerns are: session lifecycle (start/stop/interrupt), run management (create/list runs), worktree operations (reset, status), mock scenarios, and agent CRUD.
- `coordination-state.ts` mixes: text classification, subscription derivation, signal collection, brief building, rendering, and the service factory.
- `App.tsx` mixes: all view state, data fetching hooks, event handlers, and every render function for every panel (workspace thread, inspector, planner, inbox, settings drawer, right sidebar, command palette).
- All three files are co-located with their current import paths — the split must be a rename-and-re-export, not a behavior change.

Step 1: Split `agents.ts` into 4 route files

Create these files inside `apps/control-plane/src/routes/`:
- `agent-session.ts` — `POST /agents` (create), `GET /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `POST /agents/:id/start`, `POST /agents/:id/stop`, `POST /agents/:id/interrupt`
- `agent-runs.ts` — `GET /agents/:id/runs`, `GET /agents/:id/events`, `GET /agents/:id/artifacts`
- `agent-worktree.ts` — `GET /agents/:id/worktree`, `POST /agents/:id/worktree/reset`
- `agent-mock.ts` — `POST /agents/:id/mock-run/:scenario`

In `agents.ts`, replace the body with imports and re-registration from the four new files. Or, if the router is registered at the app level, update the app router to import from the four new files directly and delete `agents.ts`.

No logic changes — only file reorganization.

Step 2: Split `coordination-state.ts` into 5 modules

Create these files inside `apps/control-plane/src/lib/`:
- `coordination-classification.ts` — `classifyFindingType`, `deriveFindingSubscriptions`, `extractActionRequestFromText`, `normalizeLabel`
- `coordination-signals.ts` — `collectCoordinationSignals`, `loadLatestRunContext`, `buildAgentBrief`, `buildCoordinationState`
- `coordination-rendering.ts` — `renderWorkspaceCoordinationContext`, `renderAgentCoordinationContext`, `renderRoleCoordinationContext`, `renderExecutionPacket`
- `coordination-service.ts` — `CoordinationService` interface, `createCoordinationService` factory, `refreshWorkspaceState`
- `coordination-state.ts` — keep as barrel re-export only: `export * from "./coordination-classification.js"; export * from "./coordination-signals.js"; ...`

All existing imports of `coordination-state.ts` continue to work without changes because the barrel re-exports everything. The split is purely internal.

Step 3: Split `App.tsx` into view components

Create these files inside `apps/desktop/src/`:
- `views/WorkspaceView.tsx` — `workspaceConversationGroups` memo, `submitWorkspaceInstruction`, `handleBroadcast`, workspace thread render, broadcast composer
- `views/InspectorPanel.tsx` — agent detail panel, run list, transcript viewer, tool calls, artifacts, right sidebar tabs
- `views/PlannerView.tsx` — planner thread, recommendation saving, advisor picker
- `views/InboxView.tsx` — handoff list, pending approvals, assign/create-agent flows
- `views/SettingsDrawer.tsx` — provider settings, runtime status panel

`App.tsx` becomes the top-level router/layout component: it holds global state (active workspace, selected agent, home thread kind) and renders the appropriate view. All data fetching hooks and mutations stay in the view components that use them.

This is the largest split. Do it incrementally: extract one view at a time, verify TypeScript and the UI still work before extracting the next. Do not move state that is shared between views into a view component — keep it in App.tsx or extract to a `useWorkspaceState` hook.

Acceptance
- Each new file is under 400 lines.
- TypeScript compiles without errors after each split step.
- No behavior changes — only file reorganization.
- All existing import paths that other files reference continue to work (use barrel re-exports where needed).

---

### Phase 13: Performance hardening and reliability cleanup

Goal:
- eliminate the N+1 coordination query, replace text heuristics with structured metadata, and unblock parallel tool execution

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/coordination-state.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/migrations.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/repositories.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/lib/run-orchestrator.ts)
- [/Users/ravindargujral/Downloads/ai-ace/packages/adapter-codex/src/index.ts](/Users/ravindargujral/Downloads/ai-ace/packages/adapter-codex/src/index.ts)

Current state (read before coding)
- `loadLatestRunContext` at coordination-state.ts line 427 does `runs.slice(0, 6)` then queries `transcript.listByRun(run.id)` for each, looking for an `assistant` or `error` entry. At 10 agents this is up to 60 DB reads on every 3s coordination refresh.
- `extractActionRequestFromText` at line 55 uses English-only regex heuristics. After Phase 2, agents can emit `findingType` in transcript metadata. The heuristic is now a fallback for legacy output only.
- `parallel_tool_calls: false` in `adapter-codex/src/index.ts` line 444 and tool loop serialization in `run-orchestrator.ts` line 330 mean Codex agents can only run one tool at a time. Claude agents also process tool calls serially (run-orchestrator's `for (const toolCall of toolCalls)` loop is sequential).

Step 1: Fix the `loadLatestRunContext` N+1 query

Add migration `0010_denormalize_latest_transcript.sql`:
```sql
ALTER TABLE agent_runs ADD COLUMN latest_transcript_type TEXT;
ALTER TABLE agent_runs ADD COLUMN latest_transcript_content TEXT;
ALTER TABLE agent_runs ADD COLUMN latest_transcript_metadata TEXT;
```
Use `ensureColumn` for each. No backfill is needed for historical runs — missing values are treated as "no transcript yet."

In `run-orchestrator.ts`, update `appendTranscript` (wherever it writes a transcript row) to also `UPDATE agent_runs SET latest_transcript_type = ?, latest_transcript_content = ?, latest_transcript_metadata = ? WHERE id = ?` when `entryType === "assistant"` or `entryType === "error"`. This keeps the denormalized columns in sync with zero extra queries on the read path.

In `repositories.ts`, add `latestTranscriptType`, `latestTranscriptContent`, `latestTranscriptMetadata` to `AgentRunRow`. Update `mapRun` to populate them.

In `coordination-state.ts`, rewrite `loadLatestRunContext`:
```typescript
async function loadLatestRunContext(repositories, agent) {
  const runs = await repositories.runs.listByAgent(agent.id);
  const latestRun = runs[0] ?? null;
  // Find the most recent run that has a denormalized transcript entry
  const runWithEntry = runs.slice(0, 6).find(
    (run) => run.latestTranscriptType === "assistant" || run.latestTranscriptType === "error"
  ) ?? null;
  return {
    latestRun,
    latestTranscriptEntry: runWithEntry
      ? { entryType: runWithEntry.latestTranscriptType, content: runWithEntry.latestTranscriptContent, metadata: runWithEntry.latestTranscriptMetadata }
      : null,
  };
}
```
This replaces up to 60 DB reads per refresh with 1 query per agent (the existing `listByAgent` call).

Step 2: Demote `extractActionRequestFromText` to a last-resort fallback

In `collectCoordinationSignals`, after Phase 2 is implemented, agents emit `findingType` in `transcriptMetadata`. Update the signal collection logic:
- If `latestTranscriptEntry.metadata.findingType` is set → use `classifyFindingType` with the structured short-circuit (Phase 2 path). Skip `extractActionRequestFromText` entirely.
- If `latestTranscriptEntry.metadata.needsInput === true` is set → use that as the action request signal directly.
- Only if neither metadata field is present → fall back to `extractActionRequestFromText` for legacy output.

Add a comment: `// TODO: remove extractActionRequestFromText fallback once all agents emit structured metadata`.

Step 3: Enable parallel tool execution in `run-orchestrator.ts`

Currently at line 330, parallel tool calls are rejected with an error. Replace this with actual parallel execution:

```typescript
// Phase 13: parallel tool execution
if (toolCalls.length > 1) {
  // Check if any tool requires approval — if so, fall back to serial (approval flow is per-tool)
  const anyRequiresApproval = toolCalls.some((tc) => toolBroker.requiresApproval(tc.name));
  if (anyRequiresApproval) {
    // Serial path: process approval-gated tools one at a time (existing behavior)
    for (const toolCall of toolCalls) { ... }
  } else {
    // Parallel path: execute all auto-approved tools concurrently
    const results = await Promise.all(
      toolCalls.map((tc) => executeToolCallWithTimeout(runId, tc, context))
    );
    toolResults = results;
  }
}
```

Add `requiresApproval(toolName: string): boolean` to `ToolBroker` interface — it returns `true` for any tool in `APPROVAL_REQUIRED_TOOLS`. This lets the orchestrator check without executing.

In `adapter-codex/src/index.ts`, remove the `parallel_tool_calls: false` override at line 444.

Note: parallel execution requires that tools are genuinely independent. The coordinator does not currently validate tool independence — add a TODO comment to track this for a future phase.

Acceptance
- Coordination refresh with 10 agents issues 10 DB reads (one `listByAgent` per agent), not up to 60.
- `extractActionRequestFromText` is called only when transcript metadata contains no `findingType` or `needsInput` signal.
- Multiple auto-approved tool calls from a single turn execute concurrently. Approval-required tool calls continue to execute serially.
- TypeScript compiles without errors. Existing tests continue to pass.

---

### Phase 14: Configuration and observability

Goal:
- eliminate configuration drift from the hardcoded port and add request tracing for cross-component debugging

Files
- [/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/src/main.rs](/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/src/main.rs)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/config.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/config.ts)
- [/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/app.ts](/Users/ravindargujral/Downloads/ai-ace/apps/control-plane/src/app.ts)

Current state (read before coding)
- Port 7711 is hardcoded in two places: `config.ts` default (`port: 7711`) and `main.rs` `control_plane_address()` function (line 101: `"127.0.0.1:7711"`). If the port is ever changed in `config.ts` via `ACC_PORT`, `main.rs` still polls 7711.
- `main.rs` already passes `ACC_PORT=7711` as an environment variable to the control-plane child process (line 460). The discrepancy is in the Rust health-check code that polls to confirm startup.
- No request IDs flow between the desktop, control-plane routes, and log output. When an error occurs in the frontend, there is no way to find the corresponding control-plane log line.

Step 1: Fix port synchronization in `main.rs`

The Rust `control_plane_address()` function hardcodes `127.0.0.1:7711`. Replace it with a function that reads from an environment variable at runtime:
```rust
fn control_plane_port() -> u16 {
    std::env::var("ACC_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(7711)
}

fn control_plane_address() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], control_plane_port()))
}
```
The `start_control_plane` function already sets `ACC_PORT` in the child's environment. After this change, both the child process and the Rust polling code use the same port source.

Also update the TypeScript `getBaseUrl()` in `api.ts` to read from `import.meta.env.VITE_CONTROL_PLANE_PORT` with a fallback of `7711`, and update the Vite config to expose this variable. This makes the port fully configurable for development overrides without touching source files.

Step 2: Add request tracing IDs to the control-plane

In the Fastify app setup (`app.ts`), add a request ID hook:
```typescript
fastify.addHook("onRequest", async (request) => {
  const incomingId = request.headers["x-request-id"];
  request.id = typeof incomingId === "string" && incomingId.trim()
    ? incomingId.trim()
    : `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

fastify.addHook("onResponse", async (request, reply) => {
  reply.header("x-request-id", request.id);
});
```
This respects an incoming `x-request-id` from the desktop (if provided) or generates one.

Step 3: Pass `x-request-id` from the desktop API client

In `api.ts`, update `requestJson` to include an `x-request-id` header on every request:
```typescript
headers.set("x-request-id", `desk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
```
Log this ID in the desktop when an error is thrown:
```typescript
throw new Error(`[${requestId}] ${parsedMessage ?? body}`);
```
This means every error surfaced to the user includes the request ID, which can be found in the control-plane logs.

Step 4: Include request ID in control-plane error logs

Update the Fastify error handler to log `request.id` alongside the error:
```typescript
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error({ requestId: request.id, err: error }, "request error");
  // ... existing response
});
```

Acceptance
- Changing `ACC_PORT` in the Tauri launch environment changes both the port the control plane binds to and the port Rust polls for startup, with no code change required.
- Every failed API request from the desktop logs a request ID that can be found in the control-plane log output.
- TypeScript and Rust both compile without errors.
- No behavior changes — only configuration and logging improvements.

## Recommended first coding slice

> **Important:** Phases 0–2 are hard prerequisites for the slices below. Phase 3 needs the expanded `CoordinationStateRecord` (dependency graph, coordinator decisions) from Phase 1 AND the `QUEUED` + `WAITING_DEPENDENCY` state additions from Phase 3 Step 0. Phase 4 needs the subscription model from Phase 2. Building Phases 3–5 before 0–2 are done means rewriting them once the foundation exists. Phases 0–2 have no visible behavior change but they are not optional.

Mandatory foundation (do first, in order):
1. Phase 0: coordinator boundary — extend existing `CoordinationService` interface, seal bypasses
2. Phase 1: durable state expansion — schema + migration safety
3. Phase 2: typed findings and subscriptions — structured signal model

Then the core behavior slice (can be done together once 0–2 are complete):
4. Phase 3: execution gating — add `QUEUED`/`WAITING_DEPENDENCY` states, `checkCanRun`, `buildExecutionPlan`, gating in `startRun`
5. Phase 4: team ask synthesizer — enrich team ask with blocked branches and response shape
6. Phase 5: reply decomposition — server-side packet routing, replace desktop per-agent loop

That gives us the core behavior change:
- ACC decides who runs
- ACC asks once
- user replies once
- ACC routes the answer correctly

In parallel with phases 4–9:
- Phase 10: tool execution timeout, Codex heartbeat, adapter retry logic
- Phase 11: Tauri path restriction, CORS tightening
