# Worklog

## 2026-03-14

- Converted the ACC concept spec into a detailed engineering blueprint
- Scaffolded the monorepo root config and workspace layout
- Added control plane, desktop shell, shared packages, and local infra files
- Created implementation ticket docs for the first milestone backlog
- Added durable context files so later sessions can resume quickly
- Implemented control plane bootstrap with config loading, readiness checks, and graceful shutdown
- Replaced the in-memory backend with Postgres repositories and a migration runner
- Installed Node/pnpm and Rust toolchains needed for local development and desktop packaging
- Generated Tauri icon assets and produced the first macOS `.dmg` bundle
- Reworked the desktop shell from static mock tiles to live control-plane queries plus websocket-driven refresh
- Added a demo bootstrap route that seeds context packs, mock agent sessions, and deterministic activity for the desktop UI
- Implemented the normalized event pipeline, including persisted agent events, usage ticks, and websocket fanout
- Added the deterministic mock adapter package and connected it to the control plane through a mock runner
- Added a macOS release script and GitHub Actions workflow for signed/notarized universal distribution
- Fixed the release wrapper so Tauri CLI flags are not accidentally forwarded to Cargo
- Verified monorepo `typecheck` and `build` successfully after the desktop, event, and release changes
- Recorded the current verification envelope and environment blockers in `context/verification.md`
- Pivoted the local standalone path from Postgres/Redis to SQLite using the built-in `node:sqlite` runtime
- Rewrote the control-plane database, migrations, repositories, and event service for SQLite semantics
- Added a desktop-side preparation script that bundles the control plane with esbuild and stages a local Node runtime inside Tauri resources
- Started wiring the Tauri host to spawn and own the local control plane against an app-local SQLite file
- Verified the bundled standalone runtime by launching the staged Node binary plus bundled control-plane resource on `127.0.0.1:7722`
- Verified bundled API behavior in standalone mode: `/health`, workspace creation, demo bootstrap, and persisted workspace overview all succeeded without Postgres or Redis
- Replaced Tauri's failing generated DMG wrapper with a direct `hdiutil` packaging script for the standalone installer path

## 2026-03-16

- Refactored the adapter SDK so live providers emit lightweight runtime events instead of pre-enveloped persisted agent records
- Replaced the Codex adapter stub with a live OpenAI Responses API integration, including streaming output, usage accounting, and heartbeat emission
- Replaced the Claude adapter stub with a live Anthropic Messages API integration, including streaming output, usage accounting, and heartbeat emission
- Added a runtime manager to the control plane to own live sessions, mount shared context into provider starts, and recover stale runtime-backed agents after backend restarts
- Wired `/api/v1/agents/:id/start`, `/input`, `/interrupt`, and `/stop` to the live runtime path
- Extended the Tauri host with crash supervision so app-owned embedded control-plane processes are restarted automatically after unexpected exit
- Hardened standalone packaging by validating that the bundled Node runtime matches the requested target architecture
- Added a dedicated macOS release verifier that checks the packaged `.app` and `.dmg` layout and validates universal architecture expectations
- Verified the embedded control-plane bundle serves live routes and returns explicit missing-credential errors for both Codex and Claude start requests when provider keys are absent
- Verified the full universal macOS release script now completes successfully through bundle, DMG creation, and post-build artifact verification in the no-credentials case

## 2026-03-18

- Added desktop-side provider settings commands in the Tauri host so the app can read and persist OpenAI and Claude API keys locally
- Added a provider settings panel to the React shell and moved it out of the workspace-only path so it remains available during degraded startup
- Added a desktop runtime status command and UI card so the shell can explain whether the embedded control plane is reachable, app-managed, or retrying after an error
- Traced the packaged-app crash to the Tauri `setup` hook returning an error when the embedded control plane failed to become reachable in time
- Changed the Tauri host to record embedded-backend startup errors, keep the app open, and let the supervisor retry instead of aborting the entire macOS app on launch
- Rebuilt the packaged `.app` bundle and verified that the packaged binary stays alive on the real macOS startup path that previously crashed immediately
- Reproduced the `Seed demo board` complaint and confirmed the backend bootstrap route was working while the UI gave almost no visible feedback
- Updated the desktop shell so workspace creation and demo seeding now show explicit in-progress, success, and error banners, plus immediate workspace refresh after a successful seed
- Prevented reseeding a workspace that already contains demo content by turning the button into an explicit `Demo already loaded` disabled state
- Fixed the frontend request helper so POST routes without a body no longer send `Content-Type: application/json`, which was breaking `Seed demo board`
- Added workspace rename and delete routes in the control plane plus matching actions in the desktop toolbar
- Added agent title update support in the control plane and exposed it through a clickable agent detail panel in the desktop UI
- Added desktop-side agent event loading so selected tiles now show outputs, errors, and event timelines instead of static preview-only cards

## 2026-03-19

- Replaced the oversized Home command deck with a compact workspace strip so workspace editing and jump points no longer dominate the grid
- Added an explicit workspace-wide broadcast composer above the grid for sending one instruction to all visible agents or the full fleet
- Added an explicit per-agent chat composer in the inspector so selected agents can receive follow-up instructions directly
- Added a new planner route in the control plane that can call a selected live Codex or Claude model and return a structured multi-agent fleet recommendation
- Added a new desktop planner screen that captures task + constraints and renders suggested agent count, role split, provider/model mix, coordination notes, and risks
- Expanded the inspector with an ops tab for agent observability: start, interrupt, stop, event counts, token usage, heartbeat timing, latest error, and latest tool activity
- Verified `pnpm --filter @acc/control-plane typecheck`, `pnpm --filter @acc/desktop typecheck`, and `pnpm --filter @acc/desktop tauri build --bundles app`
- Rebuilt and reopened the macOS desktop app bundle from `apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app`
- Added planner follow-through so saved recommendations can be reloaded from workspace history and instantiated as created or created-and-launched suggested fleets
- Added project-backed repo exploration in the desktop shell through new Tauri commands for project tree browsing, file preview, and docked terminal execution
- Added a docked bottom panel with Explorer, Terminal, and Artifacts tabs so repo context and agent traces stay in the same app shell
- Refactored the shell toward a more IDE-like layout with a resizable left navigation rail, resizable fleet/inspector split, command palette, and session-first inspector transcript view
- Added control-plane artifact listing support for agents and surfaced that data in the new docked artifacts panel
- Verified the rebuilt app boots cleanly and the embedded control plane still reports healthy after the shell refactor
- Added Production Alpha schema and repository support for tracked runs, transcript entries, tool calls, approval requests, inbox handoffs, per-agent worktrees, and run-linked artifacts
- Added a worktree manager that inspects Git-backed workspace roots, provisions one persistent worktree per agent, and resets worktrees back to workspace `HEAD`
- Added a tool broker with approval-aware tool cataloging, safe worktree path enforcement, verification-command discovery, command timeouts, artifact persistence, and structured `create_handoff` support
- Added a run orchestrator that drives tracked runs, pauses for approval, resumes after approval or denial, records transcripts/tool calls, and marks interrupted runs after restart
- Added new control-plane routes for runs, approvals, inbox handoffs, and worktree reset
- Wired a deterministic `mock` adapter into the runtime manager so Production Alpha approval and handoff flows can be smoke-tested without live API keys
- Added `scripts/smoke-production-alpha.mjs` coverage for worktree provisioning, approval gating, approval resume, transcript persistence, and handoff creation against the bundled control-plane runtime
- Added `scripts/smoke-packaged-app.mjs` coverage for the same Production Alpha flow against the built `Agent Command Center.app` bundle with a clean temporary home/app-data directory
- Updated macOS release verification so packaged-app smoke can run as part of artifact verification unless explicitly skipped
- Migrated provider secret storage to macOS Keychain-backed Tauri commands and added legacy JSON import/delete behavior

## 2026-03-20

- Replaced the tracked-run JSON prompt protocol with a native tool-calling contract in `@acc/adapter-sdk`, adding structured tool definitions, tool calls, and tool results
- Reworked the live Codex adapter to use OpenAI Responses API function tools and `function_call_output` continuations instead of asking the model to emit JSON tool requests in plain text
- Reworked the live Claude adapter to use Anthropic Messages API tools and `tool_result` continuations instead of the prompt-driven JSON tool loop
- Updated the deterministic mock adapter so Production Alpha smoke tests still exercise approvals and handoffs through the new structured tool-call contract
- Updated the runtime manager and run orchestrator so tracked runs execute native provider tool calls, persist provider-native call IDs, and resume approval-gated steps without the old `toolResultPrompt`/`toolDeniedPrompt` scaffolding
- Extended the tool-call schema and migrations with `provider_call_id` persistence so approval resume uses the provider's real call handle
- Tightened the desktop run UX so the selected-run inspector now foregrounds pending approvals, tool inputs/outputs, diff/log artifacts, and run-scoped inbox follow-ups
- Tightened the Inbox view so approvals and handoffs can jump directly back to the source run
- Re-verified the Production Alpha flow after the protocol cutover with package typechecks, full monorepo build, standalone smoke, desktop bundle build, and packaged-app smoke
- Restored streaming Responses API handling in the Codex adapter while keeping native OpenAI function tools and `function_call_output` continuations
- Restored streaming Messages API handling in the Claude adapter while keeping native Anthropic tool use and `tool_result` continuations
- Added a run-scoped live telemetry section in the selected-run inspector so streaming output deltas, tool activity, usage ticks, heartbeats, and recent payloads are visible alongside the durable transcript
- Re-verified the streaming/telemetry slice with adapter/control-plane/desktop typechecks, full monorepo build, standalone smoke, desktop bundle build, and packaged-app smoke
- Fixed the planner suggestion card layout so long role names and provider/model controls stay inside each card
- Clarified the created-agent status by relabeling `CREATED` from `Queued` to `Ready to launch`
- Added per-agent working-directory editing in the inspector meta view, with blank-to-reset behavior back to the workspace root and backend validation that custom paths stay inside the workspace project root
- Updated Explorer to respect the selected agent's custom `cwd` when no worktree has been provisioned yet
- Traced the intermittent macOS `open`/Launch Services failure on the local built `.app` bundle, revalidated that the rebuilt bundle now opens normally again, and added repo-level `desktop:open` / `desktop:restart` scripts that prefer Launch Services and fall back to direct executable launch if macOS rejects the bundle path
- Tightened the desktop UI again by turning the docked Explorer into a current-folder navigator with filterable entries, breadcrumbs, typed path navigation, and a cleaner split list/preview layout
- Compressed the agent fleet tiles so more agents fit on screen at once, with smaller cards, denser spacing, and line-clamped previews instead of the earlier dashboard-style treatment
