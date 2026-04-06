# Codebase and ACC Coordinator Plan Review

## Codebase Review

### What's Well-Built

**Architecture is sound.** The adapter pattern is correctly applied — `AgentAdapter` is a clean provider-agnostic interface, and the Claude/Codex adapters implement it consistently. The separation between `RuntimeManager` (adapter lifecycle), `RunOrchestrator` (turn loop), `ToolBroker` (execution), and `CoordinationService` (state) is appropriate for this domain.

**Event system is solid.** Immutable, sequenced event log in SQLite with a bus for real-time broadcast is the right model. It gives you replay, audit, and streaming without a separate queue infrastructure.

**Mock adapter is a good engineering decision.** Having a deterministic `adapter-mock` with named scenarios (`planner`, `reviewer`, `idle`, `error`) means you can test end-to-end flows without API keys. Most projects skip this.

**Shared types are well-defined.** The `AgentState` machine (9 states), `AgentRunState`, and all the coordination record types in `shared-types` are thorough. The Zod schemas in `event-schema` add runtime safety on top of TypeScript.

---

### Issues and Gaps

**1. `CoordinationService` is not yet a real coordinator.**
The current `coordination-state.ts` is a collection of pure functions (`buildCoordinationState`, `renderAgentCoordinationContext`, etc.) assembled ad-hoc. There is no single service object with a defined interface that the rest of the system calls. The plan correctly identifies this — Phase 0 exists for exactly this reason.

**2. `RunOrchestrator` does not check coordination state before dispatching.**
The run loop in `run-orchestrator.ts` loops through tool steps but there's no gating point where it asks "should this agent be running right now?" before sending input. If a workspace broadcast fans out to all agents simultaneously, there's nothing preventing the wrong order. Phase 3 is the direct fix.

**3. `App.tsx` is doing too much coordination work.**
Based on the referenced functions (`submitWorkspaceInstruction`, `handleBroadcast`, `workspaceConversationGroups`), the desktop is composing per-agent reply packets and routing workspace replies. That logic belongs in the control plane. Phases 5 and 8 address this, but it's a significant refactor risk if the desktop accumulates more of this logic before the server-side seams exist.

**4. No test harness yet.**
The plan mentions adding tests but there's no test infrastructure in place. Before Phase 3 introduces stateful gating logic, you need at least a unit test setup for `coordination-state.ts` pure functions — otherwise debugging execution gating issues will be very difficult.

**5. `WorktreeManager` + SQLite concurrency.**
If multiple agents run simultaneously and each one writes findings/events, there are potential write contention issues on SQLite. The current `Database` wrapper has transaction support, but it's worth verifying that concurrent tool executions go through serialized writes.

**6. No retry or backoff on adapter API calls.**
The Claude and Codex adapters call provider APIs without retry logic. Network blips or transient 429s will surface as hard errors. For a desktop tool used on flaky connections this matters.

---

## Implementation Plan Review

### What's Right

The hidden-coordinator model is the correct mental model. Making `ACC Coordinator` a control-plane service rather than a visible agent avoids the common failure mode where a "meta-agent" becomes a single point of prompt failure and costs tokens every turn.

The phase breakdown is logical. Phases 0–2 are pure infrastructure (no visible behavior change), Phases 3–5 are the core behavior change, and 6–9 are integration/polish. The separation is clean.

The acceptance criteria per phase are specific and testable. That's rare in implementation plans and very useful here.

---

### Concerns with the Plan

**1. The "recommended first coding slice" (Phases 3+4+5) conflicts with the delivery order.**
The plan says phases should go 0→1→2→3→4→5 but then recommends jumping to 3+4+5 as the first slice. Phase 3 (`buildExecutionPlan`) needs the expanded `CoordinationStateRecord` from Phase 1 (dependency graph, blocked agents, coordinator decisions). Phase 4 (team ask synthesizer) needs the finding subscription model from Phase 2. Skipping 0–2 means you're building Phase 3–5 on top of the existing ad-hoc shape, which will require a rewrite once 0–2 are done. **Stick to the delivery order or merge Phases 0–2 into a single "foundation" sprint.**

**2. Phase 7 (transcript pattern detection) is fragile.**
Detecting `"please run"` / `"can you execute"` / `"I need shell access"` from raw transcript text is brittle. Agent models phrase things differently by provider. A Claude agent and a Codex agent will phrase the same intent differently, and this approach will produce false positives/negatives. A better approach: teach agents to emit a structured `COMMAND_REQUEST` or `ACCESS_REQUEST` finding type, and have the coordinator handle that typed signal rather than doing NLP on prose output.

**3. Phase 6 (handoffs/blockers as live signals) needs a triggering mechanism.**
The plan says "when a handoff is created... update dependency graph." But who calls that? The current handoff route (`POST /handoffs`) likely just writes a record. You need to define the trigger points — likely hooks in `run-orchestrator.ts` after a run completes, or in the handoff route itself — and those hooks need to call back into the coordinator. The plan doesn't specify this wiring.

**4. Reply decomposition (Phase 5) needs a fallback.**
`POST /workspaces/:id/coordination/replies` returns per-agent packets. What happens if the coordinator can't determine which agents to route to? (Empty agent list, all agents blocked, coordinator state stale.) The plan doesn't specify a fallback path. The desktop needs to know whether to wait, show an error, or fall back to a direct broadcast.

**5. No migration strategy for in-flight state.**
When Phases 1 and 2 extend `CoordinationStateRecord` with new fields (`dependencyGraph`, `executionPlan`, etc.), existing persisted records in SQLite won't have those fields. The migrations plan should include nullable-with-default columns and a `refreshWorkspaceState` backfill pass on startup.

---

### Recommended Adjustments

| Issue | Suggestion |
|---|---|
| Phase 0-2 skipped | Make them a mandatory "coordinator foundation" prerequisite before any Phase 3-5 work |
| Phase 7 transcript parsing | Define a structured `COMMAND_REQUEST` finding type agents emit; coordinator handles typed signals |
| Phase 6 trigger wiring | Explicitly name the hooks in `run-orchestrator.ts` and the handoff route that call coordinator |
| Phase 5 fallback | Define what `POST /coordination/replies` returns when routing is ambiguous |
| Migrations | Ensure Phase 1 schema changes use nullable columns with defaults; add backfill logic |
| Test harness | Add a minimal unit test setup for `coordination-state.ts` before Phase 3 |

---

### Summary

The codebase is architecturally sound and the coordination primitives are already partially built. The implementation plan is well-scoped and has good acceptance criteria. The biggest risks are: (1) building Phases 3–5 before the Phase 0–2 seams exist, (2) the fragility of text-based transcript detection in Phase 7, and (3) the lack of a test harness before stateful gating logic is introduced. Address those and the delivery path is solid.
