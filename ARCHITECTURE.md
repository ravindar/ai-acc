# Agent Command Center (ACC) — Architecture & Enhancement Roadmap

> Generated: 2026-04-08
> Codebase revision: `a9be287`

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Repository Structure](#2-repository-structure)
3. [Desktop Application (Tauri + React)](#3-desktop-application)
4. [Control Plane (Node.js / Fastify)](#4-control-plane)
5. [Database Schema](#5-database-schema)
6. [Adapter Layer](#6-adapter-layer)
7. [Packages](#7-packages)
8. [Key Data Flows](#8-key-data-flows)
9. [Agent Lifecycle State Machines](#9-agent-lifecycle-state-machines)
10. [Multi-Agent Coordination Engine](#10-multi-agent-coordination-engine)
11. [Security Model](#11-security-model)
12. [Enhancement Roadmap](#12-enhancement-roadmap)

---

## 1. System Overview

ACC is a **desktop-embedded multi-agent IDE** — a Tauri macOS application that ships its own local AI backend. A human operator uses a React UI to create workspaces, spawn AI agents (Claude or Codex), direct them with natural-language prompts, review and approve tool calls, and synthesize their collective status.

```
┌─────────────────────────────────────────────────────────────────┐
│  macOS Desktop (Tauri 2.x)                                      │
│                                                                  │
│  ┌────────────────────────┐    ┌────────────────────────────┐  │
│  │  React UI (App.tsx)    │◄──►│  Rust Shell (main.rs)      │  │
│  │  TanStack Query        │    │  Keychain IPC              │  │
│  │  WebSocket Client      │    │  Sidecar supervisor        │  │
│  │  Dark/Light theme      │    │  File tree / terminal      │  │
│  └───────────┬────────────┘    └──────────┬─────────────────┘  │
│              │ HTTP + WebSocket            │ spawn/supervise     │
│              │ 127.0.0.1:7711             │                     │
│  ┌───────────▼─────────────────────────────▼─────────────────┐  │
│  │  Control Plane (Node.js 22 + Fastify 4)                   │  │
│  │                                                           │  │
│  │  Run Orchestrator  │  Tool Broker  │  Runtime Manager     │  │
│  │  Coordination Engine│  Event Service│  Approval Gate      │  │
│  │                                                           │  │
│  │  SQLite (WAL mode)          Pricing Package               │  │
│  └──────┬────────────────────────────────────────────────────┘  │
│         │                                                        │
│  ┌──────▼──────────────────────────────────────────────────┐    │
│  │  AI Provider Adapters                                   │    │
│  │  adapter-claude ──► api.anthropic.com                   │    │
│  │  adapter-codex  ──► api.openai.com                      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**Key design constraints:**
- Fully local — no cloud backend, no telemetry
- Single-user, single-process (one Tauri window, one control-plane Node.js process)
- Synchronous SQLite with WAL mode (adequate for ≤10 concurrent agents)
- Providers accessed directly — API keys stored in macOS Keychain via Tauri IPC

---

## 2. Repository Structure

```
ai-ace/
├── apps/
│   ├── control-plane/          Node.js Fastify API + agent orchestration
│   │   └── src/
│   │       ├── index.ts        Bootstrap + shutdown
│   │       ├── app.ts          Fastify setup, CORS, WebSocket, route registration
│   │       ├── config.ts       Zod-validated env config
│   │       ├── services.ts     Dependency injection factory
│   │       └── lib/
│   │           ├── database.ts             SQLite async wrapper
│   │           ├── migrations.ts           15 embedded schema migrations
│   │           ├── repositories.ts         Full DAL (~3000 lines)
│   │           ├── events/bus.ts           In-memory EventEmitter pub-sub
│   │           ├── events/service.ts       Event persistence + side effects
│   │           ├── runtime-manager.ts      Adapter sessions, context loading
│   │           ├── run-orchestrator.ts     Run lifecycle, tool execution
│   │           ├── tool-broker.ts          Tool catalog, approval routing, sandbox
│   │           ├── coordination-state.ts   Multi-agent coordination engine
│   │           └── coordination-synthesizer.ts  Haiku team-ask synthesis
│   │       └── routes/
│   │           ├── workspaces.ts   health, workspace CRUD + team ask
│   │           ├── agents.ts       agent CRUD, start/stop/interrupt
│   │           ├── runs.ts         run start/stop, transcript, tool-calls
│   │           ├── approvals.ts    approve/deny pending tool calls
│   │           ├── handoffs.ts     assign/create-agent from handoff
│   │           ├── contexts.ts     context pack CRUD + mounting
│   │           ├── usage.ts        token/cost aggregation
│   │           ├── planner.ts      AI planning suggestions
│   │           └── stream.ts       WebSocket event stream
│   └── desktop/
│       ├── src/
│       │   ├── App.tsx             React monolith (~10,800 lines)
│       │   ├── styles.css          All CSS (~2500 lines)
│       │   └── lib/api.ts          30+ typed API fetch functions
│       └── src-tauri/
│           └── src/main.rs         Tauri commands, sidecar supervisor, keychain
├── packages/
│   ├── shared-types/               All TypeScript interfaces shared across packages
│   ├── adapter-sdk/                AgentAdapter interface + error types + SSE parser
│   ├── adapter-claude/             Anthropic Claude implementation
│   ├── adapter-codex/              OpenAI Codex implementation
│   ├── adapter-mock/               Deterministic mock for testing
│   ├── pricing/                    Model pricing + capabilities registry
│   └── event-schema/               Zod-validated agent event schemas
├── turbo.json                      Turborepo task graph
└── pnpm-workspace.yaml
```

---

## 3. Desktop Application

### 3.1 Tauri Shell (`src-tauri/main.rs`)

The Rust shell has two responsibilities:

**Sidecar management**: Spawns the control-plane Node.js process with `ACC_STORAGE_DIR` and `ACC_DATABASE_PATH` environment variables pointing to `~/Library/Application Support/com.acc.desktop/control-plane/`. A dedicated supervision thread checks the process every 5 seconds and auto-restarts it if it exits unexpectedly.

**Tauri commands exposed to React:**
| Command | Purpose |
|---------|---------|
| `get_provider_settings` / `save_provider_settings` | Read/write API keys from macOS Keychain |
| `read_file_tree` | Recursive directory listing (depth/width limited, skips node_modules/.git) |
| `read_file_content` | Read file text (size-limited) |
| `write_file_content` | Write file text |
| `open_terminal_at` | Open macOS Terminal.app at a path |

API keys are stored in the macOS Keychain under the `com.acc.desktop` service name — never written to disk as plaintext.

### 3.2 React Frontend (`App.tsx`)

**State management approach**: No external state manager (no Zustand, no Redux). All state is managed with `useState` / `useReducer` hooks at the single root component. TanStack Query handles server cache.

**Adaptive polling**: A `streamPollMs` variable gates background polling:
- WebSocket connected → `streamPollMs = 20,000ms` (queries are invalidated by stream events)
- WebSocket disconnected → `streamPollMs = 3,000ms` (fallback polling)

**Key query hooks (17 total):**

| Query Key | Endpoint | Interval |
|-----------|----------|----------|
| `health` | GET /health | 5s |
| `workspaces` | GET /workspaces | 5s |
| `workspace-overview` | GET /workspaces/:id | streamPollMs |
| `agent-events` | GET /agents/:id/events | streamPollMs |
| `workspace-events` | GET /workspaces/:id/events | streamPollMs |
| `agent-runs` | GET /agents/:id/runs | streamPollMs |
| `run-transcript` | GET /runs/:id/transcript | streamPollMs |
| `run-tool-calls` | GET /runs/:id/tool-calls | streamPollMs |
| `pending-approvals` | GET /approvals | streamPollMs |
| `workspace-inbox` | GET /workspaces/:id/inbox | streamPollMs |
| `control-plane-runtime-status` | GET /ready | 3s |

**WebSocket stream** (`/api/v1/stream?workspaceId=…`): Receives `{ kind: "agent_event", event }` messages. On receipt, selectively invalidates affected query keys. Reconnects with exponential backoff (1s → 2s → 4s → … max 30s).

**UI sections:**
- **Fleet**: Global agent activity feed + status indicators
- **Workspace thread**: Chronological conversation of all agent runs with tool call details
- **Agent thread**: Per-agent run history + transcript + artifacts
- **Team ask card**: "ACC needs your guidance" — surfaces when ≥1 agent is WAITING_INPUT
- **Planner**: AI task decomposition into recommended agent roster
- **Explorer**: File tree browser scoped to agent worktree or project root
- **Inspector**: Agent telemetry, events, runtime stats
- **Settings**: Provider keys, model selection, workspace config

**Theming**: `data-theme="dark"` attribute on `<html>`, CSS variable overrides, persisted to `localStorage("acc-theme")`. Zoom 50–200% via `document.documentElement.style.zoom`, persisted to `localStorage("acc-zoom")`.

---

## 4. Control Plane

### 4.1 Entry & Startup Sequence (`services.ts`)

```
createDatabase(config)
  → runMigrations(db)         FK enforcement disabled per migration
  → assertCoreSchema(db)      Verify all 22 tables exist
  → createEventBus()
  → createEventService(db, bus)
  → createRepositories(db)
  → createCoordinationService(repositories)
  → createRuntimeManager(repositories, eventService, coordinationService, adapters)
  → createWorktreeManager(config, repositories)
  → createToolBroker(config, repositories, coordinationService)
  → createRunOrchestrator(...)
  → toolBroker.bindOrchestrator(runOrchestrator)   ← breaks circular dep
  → runtimeManager.recoverDetachedSessions()
  → runOrchestrator.recoverInterruptedRuns()
  → coordinationService.setAutoSpawnCallback(...)
```

**Circular dependency**: `ToolBroker` needs `RunOrchestrator` for `spawn_agent`, but `RunOrchestrator` needs `ToolBroker` for tool execution. Resolved via a `bindOrchestrator()` call after both are created.

### 4.2 Event System

**Two-layer architecture:**

```
Agent Adapter ──► EventService.append()
                    ├─ INSERT into agent_events (with seq)
                    ├─ applySideEffects()
                    │    ├─ SESSION_STARTED  → update agent state = STARTING
                    │    ├─ STATUS_CHANGED   → update agent state
                    │    ├─ USAGE_TICK       → insert usage_ticks row
                    │    ├─ ERROR            → update agent state = ERROR
                    │    ├─ SESSION_COMPLETED→ final state + completed_at
                    │    └─ HEARTBEAT        → update heartbeat_at
                    └─ EventBus.publish(event)
                         └─ WebSocket route → all connected clients
```

The event bus is an in-memory `EventEmitter` — subscribers register at startup (WebSocket handler) or dynamically (runtime manager per agent session).

### 4.3 Runtime Manager

Bridges the control-plane to AI provider adapters. Each active agent has a `RuntimeHandle`:

```typescript
{
  agentId, workspaceId, provider,
  sessionId, adapter,
  unsubscribe: () => Promise<void>,   // stop event stream
  lastKnownState: AgentState
}
```

**Context loading** (`loadRuntimeContext`): Assembles the agent's initial context from 7 sources in priority order:

1. `workspace.sharedContext` — free-form shared instructions
2. Agent's private memory blocks (`scope=private`)
3. Workspace-scoped memory (`scope=workspace`)
4. Unread peer messages
5. Coordination execution packet (task + agent brief + dependencies)
6. Workspace KV store
7. Mounted context packs

Context is truncated to the model's context window (via `getContextWindow()` from the pricing package) with a priority drop order: workspace-memory → kv → coordination → private-memory → messages → shared-context.

**Recovery**: On startup, `recoverDetachedSessions()` restarts all agents in `{STARTING, READY, RUNNING, IDLE}` states (WAITING_INPUT intentionally excluded — preserves team ask card).

### 4.4 Run Orchestrator

Manages the full lifecycle of a single agent run. Limits: **12 tool iterations**, **60s tool timeout**, **3 retry attempts** with 5s/10s/20s backoff on network errors.

```
startRun(agentId, prompt)
  → create Run (CREATED)
  → append SYSTEM transcript entry
  → checkCanRun() → if gated: setRunState(QUEUED), emit STATUS_CHANGED
  → continueRun(iteration=0)

continueRun(iteration)
  → setRunState(RUNNING)
  → withSendRetry { runtimeManager.sendInput(tools) }
  → append ASSISTANT transcript entry
  → if no tool calls → COMPLETED, refreshCoordination, resumeUnblocked
  → if tool calls:
      → create ToolCallRecord entries
      → if any requires approval:
          → store deferredToolCallIds in PendingApprovalContext
          → setRunState(WAITING_APPROVAL)
      → else: executeToolCall() via Promise.allSettled()
      → continueRun(iteration+1, toolResults)

resumeAfterApproval(approvalId, decision)
  → execute primary tool (approved or denied result)
  → fetch deferred tool calls from DB
  → run auto-approved deferred via Promise.allSettled()
  → return error results for approval-required deferred (operator must re-approve)
  → continueRun(iteration, allResults)
```

### 4.5 Tool Broker

Defines and executes all 25+ agent tools.

**Approval classification:**

| Auto-Approved | Requires Approval |
|---------------|-------------------|
| list_tools, list_providers, suggest_model | write_file, apply_patch |
| read_file, list_tree, search_files | run_command, run_verification_command |
| git_status, git_diff | spawn_agent |
| write_memory, read_memory, delete_memory | |
| send_agent_message, mark_message_read | |
| read_peer_output, watch_peer_output | |
| create_handoff, update_shared_context | |

**Execution sandbox:**
- File operations bounded to agent's worktree or project root (`ensureWithinRoot()`)
- Max file read: 64 KB
- Max tree entries: 300
- Max search results: 40
- Command timeout: 30 seconds
- Spawn depth limit: max 2 levels (`spawn_agent` tracks depth via metadata)

**Provider catalog** (`PROVIDER_CATALOG`): Maps provider → default model + list of supported models. `list_providers` returns this with per-model capabilities (vision, tools, cache, context window). `suggest_model` uses heuristics: vision tasks → Opus, low-cost → Haiku/gpt-4o-mini, large-context → Opus, code → Codex.

---

## 5. Database Schema

### 5.1 Entity Relationship Diagram

```
workspaces (1)
  ├── agent_sessions (N)
  │     ├── agent_events (N)
  │     ├── agent_runs (N)
  │     │     ├── transcript_entries (N)
  │     │     ├── tool_calls (N)
  │     │     │     └── approval_requests (1)
  │     │     └── handoff_items (N, as source_run_id)
  │     ├── agent_worktrees (1)
  │     ├── agent_context_mounts (N) ──► context_packs (N)
  │     │                                     └── context_items (N)
  │     ├── agent_memory_blocks (N)
  │     ├── usage_ticks (N)
  │     └── artifacts (N)
  │
  ├── workspace_coordination_states (1)
  ├── handoff_items (N, as workspace_id)
  └── agent_messages (N, from_agent_id + to_agent_id)
```

### 5.2 Core Tables

| Table | Rows (typical) | Primary purpose |
|-------|---------------|----------------|
| `workspaces` | 1–20 | Workspace config, shared context, coordination brief |
| `agent_sessions` | 1–50 | Agent identity, provider, model, state machine |
| `agent_events` | 10k–1M | Append-only event log per agent |
| `agent_runs` | 10–1000 | Individual prompt→response runs |
| `transcript_entries` | 100–50k | Full LLM conversation history per run |
| `tool_calls` | 10–10k | Every tool invocation with status and output |
| `approval_requests` | 0–100 | Pending/decided approvals (1:1 with tool_calls) |
| `workspace_coordination_states` | 1 per workspace | All coordination state as JSON columns |
| `agent_memory_blocks` | 0–1000 | Persistent KV memory per agent with TTL |
| `agent_messages` | 0–500 | Async DMs between agents |
| `usage_ticks` | 100–100k | Token/cost accounting per API call |

### 5.3 Run State Machine

```
CREATED → QUEUED (coordination gate)
        → RUNNING → WAITING_APPROVAL → RUNNING (tool approved/denied)
                 → WAITING_INPUT (LLM asked human a question)
                 → COMPLETED
                 → ERROR
                 → STOPPED
```

### 5.4 Agent Session State Machine

```
CREATED → STARTING → READY → RUNNING → WAITING_INPUT
                           → WAITING_APPROVAL
                           → IDLE
                           → ERROR
                           → COMPLETED
                           → STOPPED
```

### 5.5 Migration History

| # | Migration | Key Change |
|---|-----------|-----------|
| 01 | initial | Baseline tables |
| 02 | project_context | workspaces.project_root, shared_context |
| 03 | production_alpha | agent_runs, transcript, tool_calls, approvals, handoffs, worktrees |
| 04 | provider_call_id | tool_calls.provider_call_id |
| 05 | repair_fk | Rebuild tables after 03 rename |
| 06 | coordination | workspace_coordination_states |
| 07 | findings | finding_summaries, action_requests columns |
| 08 | team_ask | team_ask column |
| 09 | coordinator_phase1 | dependency_graph, execution_plan, blocked_agents, decisions, packets |
| 10 | cross_agent_context | agent_memory_blocks, agent_messages, shared_context_kv |
| 11 | batch_indexes | idx_runs_agent_created, idx_transcript_run_seq |
| 12 | coordinator_usage | coordinator_usage column |
| 13 | memory_ttl | expires_at, version on memory blocks |
| 14 | queued_state | QUEUED + WAITING_INPUT in agent_runs CHECK |
| 15 | repair_agent_runs_fk | Repair child-table FKs broken by migration 14 |

---

## 6. Adapter Layer

### 6.1 Interface (`adapter-sdk`)

```typescript
interface AgentAdapter {
  startSession(req: StartSessionReq): Promise<{ sessionId: string }>
  sendInput(req: SendInputReq): Promise<SendInputResult>
  streamEvents(sessionId, listener): Promise<() => Promise<void>>
  interrupt(sessionId): Promise<void>
  stop(sessionId): Promise<void>
  getStatus(sessionId): Promise<AdapterStatus>
}
```

Both adapters implement the same interface; the runtime manager selects the adapter based on `agent.provider`.

### 6.2 Claude Adapter (`adapter-claude`)

- Streams via Anthropic SSE (`/v1/messages` with `stream: true`)
- `max_tokens` driven by `getModelCapabilities(model).maxOutputTokens` (not hardcoded)
- Uses `cache_control` for prompt caching on supported models
- Tool calling via Anthropic `tool_use` / `tool_result` blocks
- Heartbeat timer emits `HEARTBEAT` events every 10 seconds while streaming
- 3-attempt retry with exponential backoff for 429/network errors

### 6.3 Codex Adapter (`adapter-codex`)

- OpenAI function-calling format (not tool_use)
- Same session + streaming + retry pattern as Claude
- Models: `o4-mini`, `codex-mini-latest`, `gpt-5-codex`, `gpt-5.2-codex`

### 6.4 Model Capabilities Registry (`packages/pricing`)

4-tier lookup: exact match → prefix match → substring match → family regex fallback.

```typescript
interface ModelCapabilities {
  contextWindow: number        // max input tokens
  maxOutputTokens: number      // max output tokens per request
  supportsCache: boolean       // Anthropic prompt caching
  supportsTools: boolean       // function/tool calling
  supportsVision: boolean      // image inputs
}
```

---

## 7. Packages

| Package | Purpose | Key exports |
|---------|---------|------------|
| `shared-types` | All TypeScript interfaces | 30+ types: Agent, Run, Approval, Handoff, Coordination… |
| `adapter-sdk` | Adapter contract | `AgentAdapter`, error classes, SSE parser |
| `adapter-claude` | Anthropic integration | `ClaudeAdapter` class |
| `adapter-codex` | OpenAI integration | `CodexAdapter` class |
| `adapter-mock` | Deterministic testing | `MockAdapter` class (scenarios: planner/reviewer/idle/error) |
| `pricing` | Model pricing + capabilities | `getPricing()`, `getContextWindow()`, `getModelCapabilities()` |
| `event-schema` | Zod event validation | `validateAgentEvent()`, `createAgentEvent()` |

---

## 8. Key Data Flows

### 8.1 Agent Run (Happy Path)

```
User types prompt → POST /agents/:id/runs
  → Run created (CREATED)
  → continueRun(iteration=0)
    → runtimeManager.sendInput(prompt, tools=[25 tools])
    → LLM streams response
      → partial tokens → HEARTBEAT events
      → tool_use block → ToolCallRecord created
    → sendInput returns { assistantText, toolCalls }
    → append ASSISTANT transcript entry
    → if toolCalls (auto-approved):
        → executeToolCall() in parallel
        → append TOOL transcript entries
        → continueRun(iteration+1, results)
    → if no tool calls:
        → setRunState(COMPLETED)
        → coordinationService.refreshWorkspaceState()
```

### 8.2 Approval Gate

```
Tool call requires approval
  → create ApprovalRequestRecord (PENDING)
  → setRunState(WAITING_APPROVAL)
  → store PendingApprovalContext { primaryToolCallId, deferredToolCallIds }
  → WebSocket pushes event → UI shows approval card

User clicks Approve
  → POST /approvals/:id/approve
    → execute primary tool
    → execute deferred auto-approved tools (Promise.allSettled)
    → error-result for deferred approval-required tools
    → continueRun(iteration, allResults)
```

### 8.3 Multi-Agent Coordination + Team Ask

```
All agents respond to prompt
  → each hits WAITING_INPUT
  → each refresh fires coordinationService.refreshWorkspaceState()
  → Guard: skip synthesis if any agent still RUNNING/STARTING
  → Once all settled:
      → collectCoordinationSignals() builds waitingAgentInputs[]
      → synthesizeTeamStatus(teamAskId, agents, task):
          → check in-memory cache (teamAskId + agentSet key)
          → if miss: POST to Anthropic Haiku
              - System: coordinator role
              - User: per-agent transcript (last 8k chars) + task
              - Returns: { teamSummary, agentSummaries: { [title]: ask } }
          → cache result
      → overwrite heuristic summaries with synthesized summaries
      → persist as CoordinationTeamAskRecord in workspace_coordination_states
  → UI polls workspace-overview → shows "ACC needs your guidance" card
```

### 8.4 Handoff + Auto-Spawn

```
Agent creates handoff via create_handoff tool
  → HandoffItem(OPEN, autoSpawn=true) created
  → coordinationService.refreshWorkspaceState()
  → autoSpawnCallback fires:
      → create new AgentSession with handoff's recommended provider/model
      → start new Run with handoff's next_prompt
      → HandoffItem.status = ASSIGNED
```

---

## 9. Agent Lifecycle State Machines

### Run States

| State | Meaning | Next states |
|-------|---------|------------|
| CREATED | Row exists, not started | QUEUED, RUNNING |
| QUEUED | Coordination gate holding it | RUNNING (when unblocked) |
| RUNNING | LLM is processing | WAITING_APPROVAL, WAITING_INPUT, COMPLETED, ERROR, STOPPED |
| WAITING_APPROVAL | Operator must approve a tool | RUNNING (after decision) |
| WAITING_INPUT | LLM asked operator a question | RUNNING (after operator reply) |
| COMPLETED | Run finished successfully | — |
| ERROR | Run failed | — |
| STOPPED | Operator interrupted | — |

### Agent Session States

| State | Meaning |
|-------|---------|
| CREATED | Record exists, adapter not started |
| STARTING | Adapter session initializing |
| READY | Adapter ready, awaiting input |
| RUNNING | Actively processing a run |
| WAITING_INPUT | Run is WAITING_INPUT |
| WAITING_APPROVAL | Run is WAITING_APPROVAL |
| IDLE | Between runs |
| COMPLETED / ERROR / STOPPED | Terminal |

**Recovery on restart**: `{STARTING, READY, RUNNING, IDLE}` → adapter session restarted. `WAITING_INPUT` intentionally NOT recovered (preserves team ask card, no live stream to restore).

---

## 10. Multi-Agent Coordination Engine

### 10.1 Architecture

The coordination engine is a **reactive state machine** triggered on every transcript write. It has no independent timer — it piggybacks on the run orchestrator's natural event points.

```
Run orchestrator event
  │
  ▼
coordinationService.refreshWorkspaceState(workspaceId)
  │
  ├─ Load: agents, runs, handoffs, existing state
  ├─ Build: agentBriefs (status summaries per agent)
  ├─ Detect: findings (blockers, errors, decisions)
  ├─ Detect: dependency edges (depends_on_agent, depends_on_approval, etc.)
  ├─ Build: executionPlan (run_now / wait / blocked per agent)
  ├─ Stabilization guard: skip synthesis if any agent RUNNING
  ├─ Synthesize: Haiku team ask (if all agents settled + ≥1 WAITING_INPUT)
  └─ Persist: full state in workspace_coordination_states (single UPSERT)
```

### 10.2 Coordination State Fields

Stored as JSON columns in `workspace_coordination_states`:

| Field | Type | Purpose |
|-------|------|---------|
| `brief` | `CoordinationBriefRecord` | Task + constraints + recommended agent plan |
| `agentBriefs` | `[]` | Per-agent status summary |
| `teamAsk` | `CoordinationTeamAskRecord` | Current blocking request to operator |
| `teamAskHistory` | `[]` | Previous asks for carry-forward |
| `dependencyGraph` | `[]` | Which agents depend on which |
| `executionPlan` | `[]` | Current decision per agent |
| `blockedAgents` | `[]` | Agents waiting on dependencies |
| `coordinatorDecisions` | `[]` | History of coordinator decisions |
| `replyPackets` | `[]` | Rendered context packets sent to agents |
| `coordinatorUsage` | `{}` | Haiku synthesis cost tracking |

### 10.3 Team Ask Synthesis

**Stabilization guard**: Synthesis fires only when `waitingAgentInputs.length > 0 AND !anyAgentStillRunning`. This ensures all agents have finished their current generation before Haiku summarizes their collective ask.

**Caching**: `synthesisCache` (in-memory Map) keyed by `(teamAskId, sortedAgentIds)`. Cache hit returns stored result with 0 token cost. Cache misses on new prompt round or changed agent set.

**Carry-forward**: If no new `teamAsk` is computed (agents not waiting), the existing DB record is preserved unless:
- A new prompt round started (`currentPromptId` changed)
- The ask was explicitly dismissed (`dismissed=true`)

### 10.4 Dependency Types

```typescript
type CoordinationDependencyType =
  | "depends_on_finding"
  | "depends_on_agent"
  | "depends_on_approval"
  | "depends_on_user_input"
  | "depends_on_handoff"
```

---

## 11. Security Model

### 11.1 Current Controls

| Control | Implementation |
|---------|--------------|
| API key storage | macOS Keychain via Tauri IPC |
| File sandboxing | `ensureWithinRoot()` bounds file ops to worktree/project root |
| Tool approval | `APPROVAL_REQUIRED_TOOLS` set for destructive operations |
| Spawn depth | Max 2 levels for `spawn_agent` |
| CORS | Origin whitelist: `127.0.0.1:7711`, `localhost:7711`, `tauri://localhost` |
| Rate-limit errors | Friendly message + orange UI bubble, raw error in transcript metadata |
| Context truncation | Drops low-priority items before hitting context window |

### 11.2 Known Gaps

| Gap | Risk |
|-----|------|
| `ensureWithinRoot` doesn't resolve symlinks | Agent could escape sandbox via symlink |
| No per-user authentication | Any process on localhost can call the API |
| `run_command` executes arbitrary shell commands | High risk if an agent is compromised |
| No rate limiting on HTTP API | Potential DoS from buggy frontend |
| `fire-and-forget void continueRun(...)` | Unhandled errors don't surface |

---

## 12. Enhancement Roadmap

### Tier 1 — Critical / Production-readiness

#### 1.1 Fix Symlink Escape in File Sandbox
**File**: `tool-broker.ts` → `ensureWithinRoot()`
**Issue**: `realpathSync()` is not called before the path check. A symlink inside the project root pointing outside it bypasses the sandbox.
**Fix**: `const resolved = realpathSync(candidate); if (!resolved.startsWith(root)) throw ...`

#### 1.2 Catch Unhandled `continueRun` Errors
**File**: `run-orchestrator.ts`
**Issue**: `void continueRun(...)` is fire-and-forget. If it throws, the run hangs in RUNNING forever.
**Fix**: `.catch(err => setRunState(runId, "ERROR", String(err)))` on every `void continueRun(...)` call.

#### 1.3 Add HTTP API Rate Limiting
**File**: `app.ts`
**Issue**: No rate limiting on REST API — a buggy frontend loop could flood the control plane.
**Fix**: Add `@fastify/rate-limit` with per-IP limits (e.g., 100 req/10s).

#### 1.4 Persist Pending Approval State
**Issue**: If the app restarts while a run is in `WAITING_APPROVAL`, the approval is orphaned.
**Fix**: `recoverInterruptedRuns()` should detect WAITING_APPROVAL runs, re-populate `pendingApprovals` map from DB, or resume them with an error-result.

---

### Tier 2 — High-Value Features

#### 2.1 Conversation Memory & Long-Term Context
**Current gap**: Agents forget everything between runs. Memory blocks exist but must be written explicitly by the agent.
**Enhancement**: Auto-summarize completed runs into memory blocks (write a 3-sentence summary to `scope=private` memory on run completion). Add a `recall` tool that performs vector-like keyword search over memory blocks.

#### 2.2 Agent-to-Agent Real-Time Streaming
**Current gap**: `read_peer_output` / `watch_peer_output` tools exist but require the agent to poll. No push mechanism.
**Enhancement**: Allow an agent to subscribe to another agent's run transcript as a live feed. Implement via WebSocket or long-poll at the run level. This enables true parallel collaboration (reviewer agent watches implementer in real-time).

#### 2.3 Structured Output & Artifact Versioning
**Current gap**: Artifacts are written to disk but not diffed or versioned.
**Enhancement**: When an agent writes a file that was previously written in the same workspace, compute a diff and store it as a `patch` artifact. Surface file history in the Explorer panel. Add a "revert to version N" action.

#### 2.4 Workspace Snapshots & Run Replay
**Current gap**: No way to replay or branch from a specific point in history.
**Enhancement**: Add a "snapshot" feature that exports the full DB state + worktree commit to a ZIP. Add a "replay run" action that re-sends the original prompt with the same context. Useful for debugging agent behavior.

#### 2.5 Parallel Branch Execution
**Current gap**: The execution plan tracks `blockedAgents` but doesn't automatically parallelize independent branches.
**Enhancement**: When the coordination engine computes `executionPlan`, automatically start all agents marked `run_now` simultaneously (currently requires manual operator dispatch). Add a "run all ready agents" button and make it the default behavior when `coordinationBrief` is set.

#### 2.6 Richer Approval UX
**Current gap**: Approval cards show the tool name and raw payload (JSON). Operators often can't tell at a glance if a command is safe.
**Enhancement**:
- Syntax-highlight the `run_command` payload
- Diff view for `write_file` changes (current file vs proposed)
- "Edit before approving" for `write_file` — operator can tweak the content before approving
- Batch approve: "Approve all pending write_file for this run"

#### 2.7 Agent Roles & Capability Profiles
**Current gap**: All agents have access to all 25 tools. A "reviewer" agent shouldn't be able to write files.
**Enhancement**: Add a `capability_profile` to agent metadata: `reader` (read-only), `writer` (+ write ops), `commander` (+ run_command), `orchestrator` (+ spawn_agent). `tool-broker.ts` enforces the profile at tool execution time.

---

### Tier 3 — Architecture Upgrades

#### 3.1 Extract React Sub-Components
**Current gap**: `App.tsx` is 10,800 lines — a single React component with 169 hooks.
**Enhancement**: Extract into focused components:
- `<WorkspaceThread />` — workspace conversation view
- `<AgentThread />` — per-agent run history
- `<TeamAskCard />` — guidance card
- `<ApprovalGate />` — approval flow
- `<FleetPanel />` — activity feed
- `<PlannerPanel />` — task decomposition
- `<ExplorerPanel />` — file tree

Each component gets its own query hooks and mutation handlers. This eliminates prop drilling and makes the codebase maintainable.

#### 3.2 Replace Coordination State JSON Columns with Proper Tables
**Current gap**: All coordination state is stored as JSON blobs in one row per workspace. This prevents efficient querying (e.g., "find all agents with blockers across all workspaces").
**Enhancement**: Migrate to relational tables:
- `coordination_findings` — individual finding records
- `coordination_dependencies` — dependency graph edges
- `coordination_decisions` — per-agent decisions with timestamps
- `team_asks` — separate table with proper indexing

This enables analytics, cross-workspace search, and faster lookups.

#### 3.3 Multi-Provider Message Format
**Current gap**: Tool results are formatted differently per provider. The adapter layer has provider-specific logic scattered throughout.
**Enhancement**: Normalize to a canonical `ToolResult` format in the orchestrator, and let each adapter's `sendInput` translate to the provider's format. This makes adding new providers (Gemini, local Ollama) trivial.

#### 3.4 Streaming Tool Output
**Current gap**: Tool output is captured as a single string after the tool completes. Long-running commands (builds, tests) produce no feedback until done.
**Enhancement**: For `run_command`, stream stdout/stderr in real-time via the event bus. The transcript entry updates progressively. The UI shows a live command output panel.

#### 3.5 Agent Worktree Git Integration
**Current gap**: Worktrees are created but the system doesn't track commits, branches, or merge status.
**Enhancement**:
- Auto-commit after each run that writes files (commit message from agent run title)
- Show diff from `base_ref` in the Explorer panel
- Add a "merge to base" action that PRs the worktree branch
- Surface uncommitted changes as a warning before starting a new run

#### 3.6 Observability & Tracing
**Current gap**: Logs go to a file but there's no structured tracing or metrics.
**Enhancement**:
- OpenTelemetry traces for run lifecycle (spans: sendInput, tool execution, approval wait)
- Prometheus metrics endpoint (active runs, tool approval latency, tokens/s, error rate)
- Structured JSON log format for log aggregation
- Per-run trace artifact that reconstructs the exact sequence of LLM calls and tool executions

---

### Tier 4 — Product Vision

#### 4.1 Agent Marketplace / Templates
Pre-built agent configurations for common workflows:
- `code-reviewer` — reads PR diff, comments on patterns
- `test-writer` — reads implementation, generates test suite
- `documentation-agent` — reads code, writes markdown docs
- `dependency-auditor` — runs `npm audit` / `cargo audit`, summarizes findings

Stored as YAML templates, importable via the Planner panel.

#### 4.2 Multi-Workspace Coordination
Currently each workspace is isolated. Enable cross-workspace handoffs:
- An agent in workspace A can spawn a sub-workspace for an isolated task
- Results flow back via handoff
- Useful for large projects split across multiple repos

#### 4.3 Human-in-the-Loop Approval Policies
Currently approval is binary (approve / deny). Add:
- `auto-approve` rules (e.g., "auto-approve `run_command` if it matches `npm test`")
- `require-review` SLA (e.g., "if not approved in 5 minutes, pause and notify")
- Audit log of all decisions with timestamps and operator notes

#### 4.4 Local Model Support (Ollama)
Add `adapter-ollama` implementing the same `AgentAdapter` interface, pointing to a local Ollama endpoint. The `PROVIDER_CATALOG` and `list_providers` tool would surface local models. This enables fully air-gapped operation.

#### 4.5 Mobile Observer Mode
A read-only mobile companion app (React Native or web PWA) that connects to the same control plane over LAN/tailscale, showing the fleet status and team ask card. Operators can approve/deny tool calls from their phone while the agents work.

---

## Summary Table

| Layer | Tech | Lines | Role |
|-------|------|-------|------|
| Desktop shell | Rust / Tauri 2 | 843 | Sidecar, keychain, file IPC |
| UI | React 18 / TanStack Query | 10,800 | All user interaction |
| API | Node.js / Fastify 4 | ~3,500 | HTTP + WebSocket routes |
| Orchestration | TypeScript | ~2,500 | Run lifecycle, tool execution |
| Coordination | TypeScript | ~1,100 | Multi-agent state + synthesis |
| Database | SQLite (WAL) | 22 tables | All persistent state |
| Adapters | TypeScript | ~1,400 | Claude + Codex + Mock |
| Packages | TypeScript | ~1,000 | Shared types, pricing, events |
| **Total** | | **~21,000** | |

The system is architecturally sound for its current scale (1–10 concurrent agents, single operator). The enhancements above focus on three trajectories: **hardening** (security, error handling, observability), **capability** (richer collaboration, structured artifacts, streaming), and **scale** (component extraction, relational coordination store, multi-workspace).
