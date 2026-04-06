# Verification

## 2026-03-14

### Passed

- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter @acc/control-plane build`
- `pnpm --filter @acc/desktop build`
- `pnpm --filter @acc/control-plane typecheck` after the SQLite pivot
- `pnpm --filter @acc/control-plane build` after the SQLite pivot
- `pnpm --filter @acc/desktop prepare:standalone`
- `pnpm --filter @acc/desktop build` after the standalone resource bundling changes
- `cargo check` in `apps/desktop/src-tauri` after the embedded launcher changes
- Bundled standalone runtime smoke test on `127.0.0.1:7722`:
  - `GET /health`
  - `POST /api/v1/workspaces`
  - `POST /api/v1/workspaces/ws_gtisk8jj/bootstrap-demo`
  - `GET /api/v1/workspaces/ws_gtisk8jj`

### Packaging

- Previously verified native macOS bundle output:
  - `apps/desktop/src-tauri/target/release/bundle/dmg/Agent Command Center_0.1.0_aarch64.dmg`
- Current standalone installer artifact:
  - `apps/desktop/src-tauri/target/release/bundle/dmg/Agent Command Center_0.1.0_aarch64.dmg`
- Universal release wrapper bug fixed in `scripts/release-macos.sh` by passing Tauri CLI flags directly instead of forwarding them through Cargo.
- `rustup target add x86_64-apple-darwin` was installed locally so universal builds can be attempted on this machine.

### Environment limitations

- Docker Desktop can run locally, but Docker is no longer required for the standalone desktop path.
- No standalone Postgres client/server is installed: `psql --version` failed with `command not found`.
- No local Redis server is installed: `redis-server --version` failed with `command not found`.
- In this Codex environment, localhost port binding and DMG creation required sandbox escalation even though the app/runtime logic itself worked.

### Notes

- The universal macOS release script now reaches the real Tauri build path and warns correctly when notarization credentials are absent.
- A local universal bundle run entered the native compile/link phase but did not produce an artifact within the available verification window, so signed/notarized release should be treated as CI-verified configuration until a machine with the full Apple release toolchain is available for a longer local run.
- The local desktop path now targets SQLite and an embedded control-plane runtime rather than external Postgres/Redis services.
- Tauri's generated `bundle_dmg.sh` failed in this environment, so the repo now uses a direct `hdiutil` wrapper for the standalone DMG step.

## 2026-03-16

### Passed

- `pnpm install --no-frozen-lockfile`
- `pnpm typecheck`
- `pnpm build`
- `cargo check` in `apps/desktop/src-tauri` after the Tauri supervision changes
- Embedded control-plane smoke test on `127.0.0.1:7722` using the bundled runtime:
  - `GET /health`
  - `POST /api/v1/workspaces`
  - `POST /api/v1/agents` for Codex and Claude agents
  - `POST /api/v1/agents/:id/start` returns `400` with explicit provider credential errors when `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` are absent
- `TARGET=universal-apple-darwin ./scripts/verify-macos-release.sh`
- `TARGET=universal-apple-darwin ./scripts/release-macos.sh`

### Packaging

- Verified universal standalone artifact:
  - `apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Agent Command Center_0.1.0_universal.dmg`
- Verified universal app bundle:
  - `apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Agent Command Center.app`
- Verified the packaged embedded Node runtime is included under Tauri's actual resource layout:
  - `apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Agent Command Center.app/Contents/Resources/resources/bin/acc-node`

### Environment limitations

- No `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` were present in the active shell, so live provider completions themselves were not exercised.
- No `APPLE_SIGNING_IDENTITY` or notarization credentials (`APPLE_API_KEY`/`APPLE_API_ISSUER` or `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`) were present in the active shell.
- Because of the missing Apple credentials, signing verification and notarization validation were intentionally skipped by the release verifier even though the universal packaging flow completed.
- In this Codex environment, localhost binding and localhost smoke-test HTTP calls required sandbox escalation.

### Notes

- The universal packaging path originally failed because `process.execPath` inside the Tauri `beforeBuildCommand` resolved to an arm64-only Node image; the standalone preparation step now resolves and bundles a target-compatible Node binary instead.
- The post-build release verifier originally assumed the embedded resources lived directly under `Contents/Resources`; it now inspects Tauri's actual `Contents/Resources/resources/...` layout.

## 2026-03-18

### Passed

- `pnpm typecheck`
- `cargo check` in `apps/desktop/src-tauri` after the non-crashing startup changes
- `pnpm --filter @acc/desktop tauri build --bundles app`
- `pnpm --filter @acc/control-plane typecheck` after workspace/agent update route additions
- `pnpm --filter @acc/desktop typecheck` after workspace actions and agent detail UI additions
- `pnpm --filter @acc/desktop tauri build --bundles app` after the request-helper, workspace-action, and clickable-agent-detail changes
- Direct packaged-binary launch with backtraces enabled:
  - `RUST_BACKTRACE=1 apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app/Contents/MacOS/acc-desktop`
  - Result: process remained alive for more than 20 seconds with no Rust panic output, which replaces the prior immediate `embedded control plane did not become reachable in time` abort path

### Packaging

- Rebuilt native macOS app bundle:
  - `apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app`

### Notes

- The packaged-app crash was caused by propagating embedded control-plane startup failure out of the Tauri `setup` hook, which aborts the process during `did_finish_launching`.
- The desktop shell now degrades gracefully when the embedded backend is unavailable: the app stays open, exposes backend status, and continues supervising retries.
- Provider settings are currently stored in an app-local JSON file with restrictive file permissions on Unix; this is acceptable for local testing but should be replaced with OS keychain storage before broader distribution.
- The demo bootstrap backend route was verified directly against the embedded control plane: `POST /api/v1/workspaces/:id/bootstrap-demo` creates agents and context packs as expected.
- The seed-button fix is in the desktop shell layer: the UI now surfaces mutation progress/success/errors and forces an immediate workspace refresh after bootstrap.
- The desktop toolbar now exposes workspace rename/delete actions, and agent tiles now open a detail panel that loads `/api/v1/agents/:id/events`.

## 2026-03-19

### Passed

- `pnpm --filter @acc/adapter-mock typecheck`
- `pnpm --filter @acc/event-schema typecheck`
- `pnpm --filter @acc/control-plane typecheck`
- `pnpm --filter @acc/desktop typecheck`
- `pnpm build` after the Production Alpha run/worktree/approval/handoff changes
- `pnpm --filter @acc/desktop tauri build --bundles app` after rebuilding the packaged macOS bundle with the updated Production Alpha backend resource bundle
- `node scripts/smoke-production-alpha.mjs`
  - verified workspace creation
  - verified Git worktree reset/provisioning
  - verified tracked run creation
  - verified approval request persistence
  - verified operator approval resume
  - verified transcript persistence
  - verified structured handoff creation
- `node scripts/smoke-packaged-app.mjs "apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app"`
  - verified the real packaged `.app` boots with a clean temporary home directory
  - verified the embedded control plane becomes healthy on `127.0.0.1:7711`
  - verified workspace/agent creation against the packaged app backend
  - verified worktree creation, approval flow, transcript persistence, and inbox handoff creation through the packaged app

### Notes

- The new smoke suite surfaced a real schema mismatch: `WAITING_APPROVAL` had been added to shared types and persistence, but `packages/event-schema` still rejected that state in status-change payloads. This is now fixed.
- The new smoke suite also surfaced a real tool-runner bug: `run_command` accepted `command` + `args` input but only executed the bare command string, which could launch long-lived processes such as the Node REPL. The tool broker now supports `args` and enforces command timeouts.
- The packaged-app smoke script intentionally refuses to run if another ACC instance is already bound to port `7711`, so release verification should run in a clean local or CI session.

## 2026-03-20

### Passed

- `pnpm --filter @acc/adapter-sdk typecheck`
- `pnpm --filter @acc/adapter-mock typecheck`
- `pnpm --filter @acc/adapter-codex typecheck`
- `pnpm --filter @acc/adapter-claude typecheck`
- `pnpm --filter @acc/control-plane typecheck`
- `pnpm --filter @acc/desktop typecheck`
- `pnpm build`
- `node scripts/smoke-production-alpha.mjs`
  - verified the native tool-calling run path still creates a worktree, pauses for approval, resumes after approval, persists transcript/tool calls, and creates a handoff
- `pnpm --filter @acc/desktop tauri build --bundles app`
- `node scripts/smoke-packaged-app.mjs "apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app"`
  - verified the packaged app still boots, creates a workspace and agent, completes a tracked run, persists transcript, and creates an inbox handoff
- `pnpm --filter @acc/adapter-codex typecheck` after restoring streaming Responses API event handling on top of native function tools
- `pnpm --filter @acc/adapter-claude typecheck` after restoring streaming Messages API event handling on top of native tool use
- `pnpm --filter @acc/control-plane typecheck` after the live-telemetry UI wiring
- `pnpm --filter @acc/desktop typecheck` after adding the run-scoped live telemetry feed
- `pnpm build`
- `node scripts/smoke-production-alpha.mjs`
  - verified the tracked native tool loop still creates a worktree, pauses for approval, resumes, persists transcript/tool calls, and creates a handoff after the streaming adapter changes
- `pnpm --filter @acc/desktop tauri build --bundles app`
- `node scripts/smoke-packaged-app.mjs "apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app"`
  - verified the packaged app still boots and completes the Production Alpha tracked-run smoke path after the streaming/telemetry changes
- `open "apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app"`
  - verified the current local macOS bundle opens successfully through Launch Services again
- `osascript -e 'quit app "Agent Command Center"' ; open -a "/Users/ravindargujral/Downloads/ai-ace/apps/desktop/src-tauri/target/release/bundle/macos/Agent Command Center.app"`
  - verified the normal quit-and-reopen flow succeeds and the embedded backend returns healthy on `http://127.0.0.1:7711/health`

### Environment limitations

- `node scripts/smoke-production-alpha.mjs` required sandbox escalation in this Codex environment because binding the temporary localhost smoke port (`127.0.0.1:7731`) is blocked inside the default sandbox.

### Notes

- The new verification envelope proves the Production Alpha smoke path still works after removing the old JSON-only tool protocol.
- The live provider adapters now complete non-streaming native tool-call turns for tracked runs; future UX work can add richer incremental output on top of this stable baseline.
- The live provider adapters now stream assistant deltas again while preserving the stable native tool-calling loop and approval/resume behavior.
