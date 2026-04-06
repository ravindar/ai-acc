# Current Status

## Completed

- Created the ACC monorepo skeleton with `apps/`, `packages/`, `infra/`, `docs/`, and `context/`
- Added a baseline control plane scaffold with typed REST routes and an initial SQL migration
- Implemented `CP-001` backend bootstrap foundations: env loading, structured Fastify logging, readiness checks, centralized error handling, and graceful shutdown
- Implemented `DB-001` baseline persistence: Postgres connection lifecycle, migration runner, repository layer, and DB-backed workspace/agent/context routes
- Installed the local desktop build toolchain: Node, pnpm, Rust, and Tauri prerequisites
- Produced a standalone macOS desktop bundle and `.dmg` installer through Tauri
- Wired the desktop shell to live control-plane queries for health, workspace lists, workspace overviews, and websocket-driven refresh
- Implemented `EVT-001` normalized event infrastructure: shared schemas, event persistence, usage tick ingestion, and websocket fanout
- Implemented `ADP-001` deterministic mock adapter and mock runner, including demo workspace bootstrap flows for seeded agent activity
- Added macOS release automation for signed/notarized builds through `scripts/release-macos.sh` and `.github/workflows/release-macos.yml`
- Pivoted the local standalone path away from Postgres/Redis to an embedded SQLite-backed control plane using Node's built-in `node:sqlite`
- Added desktop resource preparation to bundle the control-plane runtime and a local Node binary for standalone execution
- Added shared contracts packages for types, event schema, adapter SDK, and provider adapter stubs
- Added the first implementation ticket set under `docs/tickets/`
- Added verification notes in `context/verification.md`

## Current state

- The repo is scaffolded and organized around the v1 blueprint
- The control plane persists workspace, agent, context pack, and mount records in SQLite for the standalone desktop path
- The migration runner exists both as a script and an optional startup step
- The control plane now emits normalized agent events, records usage ticks, and streams workspace events over websockets
- The desktop shell is connected to the control plane and can seed a demo workspace backed by deterministic mock scenarios
- The desktop host now launches and owns the bundled local control plane for the standalone installer path
- Live Codex and Claude adapters now exist behind the shared adapter SDK and use the OpenAI Responses API and Anthropic Messages API respectively
- The control plane now owns a live runtime manager that can start, interrupt, stop, and recover provider-backed sessions through the normalized event pipeline
- The agent routes now expose live `start`, `input`, `interrupt`, and `stop` behavior instead of placeholder responses
- The Tauri host now supervises the embedded control plane and restarts it if the app-owned local backend process exits unexpectedly
- The universal standalone macOS release path now validates the bundled runtime architecture and verifies the generated `.app` and `.dmg` artifacts after packaging
- The Docker Compose stack is now optional and reserved for future externalized or multi-user deployment modes
- The desktop shell now includes an in-app provider settings surface for OpenAI and Claude API keys
- The packaged macOS app no longer aborts during Tauri setup when the embedded control plane misses startup; it stays open, reports backend state, and keeps retrying in the background
- The desktop shell now supports workspace rename and delete actions against the embedded control plane
- Agent tiles are now clickable and open an agent detail panel with event/output history plus title editing
- The desktop request helper now sends `Content-Type: application/json` only when a request body exists, which fixes `Seed demo board` from the UI
- The desktop shell now includes a compact workspace strip on Home instead of the oversized command-deck hero
- The desktop shell now includes a workspace-wide broadcast composer plus a per-agent chat composer in the inspector
- The inspector now exposes agent operations and observability, including start, interrupt, stop, event counts, usage, latest error, and latest tool activity
- A new planner screen can use a selected live model to recommend how many agents a task needs and which provider/model mix to assign
- Planner recommendations can now be saved into workspace shared-context history, reloaded later, and turned into created or created-and-launched agents from the UI
- Workspaces now persist a `projectRoot`, and the desktop shell can discover repo files, browse a docked file tree, and preview file contents from the bound project
- The desktop shell now has a more IDE-like layout with a resizable left rail, resizable fleet/inspector split, a docked explorer/terminal/artifacts panel, and a command palette for workspace and agent actions
- The inspector is now session-first, combining latest output and transcript-style events into one conversation-oriented view
- Production Alpha persistence is now live in SQLite for tracked runs, transcript entries, tool calls, approval requests, worktree records, handoff inbox items, and run-linked artifacts
- The control plane now provisions one persistent Git worktree per agent, validates Git-backed workspace roots, and supports explicit worktree reset
- The tool broker now enforces approval gating, safe worktree path resolution, verification-command discovery, command timeouts, artifact persistence, and structured handoff creation
- The run orchestrator now owns tracked-run execution, approval pauses/resume, transcript persistence, tool-call persistence, and restart recovery for interrupted runs
- A deterministic `mock` provider is now wired into the live runtime path so Production Alpha approval and handoff flows can be smoke-tested without live provider credentials
- Tracked live runs no longer rely on the JSON-only prompt protocol; the runtime now uses native provider tool calling contracts in the shared adapter SDK
- The Codex adapter now uses OpenAI Responses API function tools plus `function_call_output` continuations, and the Claude adapter now uses Anthropic Messages API tools plus `tool_result` continuations
- The live Codex and Claude adapters now restore incremental streaming on top of the native tool-calling loop, emitting `OUTPUT_DELTA` events during live turns while still returning structured tool calls/results for the run orchestrator
- Tool calls now persist the provider-native call identifier so approvals can resume correctly after operator action
- The selected-run desktop UX now foregrounds pending approvals, tool loop inputs/outputs, diff/log artifacts, and run-scoped inbox follow-ups in the inspector and Inbox view
- The selected-run inspector now includes a run-scoped live telemetry feed that surfaces streaming output deltas, tool events, usage ticks, heartbeats, and recent event payloads alongside the durable transcript
- Provider secrets now migrate from the legacy app-local JSON file into the macOS Keychain service `com.acc.desktop.providers`
- The real packaged macOS `.app` bundle now has a smoke script that launches the app with a clean temporary home directory and verifies the embedded backend, worktree flow, approval flow, and inbox handoff persistence
- The repo now includes explicit `desktop:open` and `desktop:restart` macOS scripts that prefer normal Launch Services bundle opening and fall back to direct executable launch if the local build bundle is temporarily rejected
- The docked Explorer now behaves more like a current-folder IDE navigator with typed path entry, breadcrumbs, lightweight filtering, and a clearer list/preview split
- The Home fleet grid now uses a denser compact tile layout so more agent cards fit alongside the inspector
- Apple signing/notarization verification is still blocked in this shell because no `APPLE_*` credentials or Developer ID signing identity are currently available

## Next recommended steps

1. Add richer run controls around diff preview, artifact opening, and follow-up creation directly from selected run cards.
2. Extend the native streaming path with deeper reasoning/tool timing telemetry and, if desired, streamed tool-argument previews.
3. Complete signed/notarized release verification once Apple credentials and a Developer ID signing identity are available.
