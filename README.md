# Agent Command Center

This repository contains Agent Command Center (ACC), a desktop-first local agent IDE and operations console for supervising multiple AI coding agents across providers such as Codex and Claude.

## Workspace layout

```text
apps/
  control-plane/    Local API, websocket stream, orchestration entrypoint
  desktop/          Tauri + React desktop shell
packages/
  adapter-sdk/      Provider-agnostic adapter contracts
  adapter-codex/    Live Codex adapter
  adapter-claude/   Live Claude adapter
  adapter-mock/     Deterministic smoke-test adapter
  event-schema/     Normalized event validators
  shared-types/     Shared DTOs and domain types
  ui-kit/           UI constants and shared presentation helpers
infra/
  docker-compose.yml
docs/
  acc-v1-engineering-blueprint.md
  tickets/
context/
  decisions, status, and worklog notes
```

## Quick start

1. Install dependencies with `pnpm install`.
2. Copy `.env.example` to `.env` if you want to override the built-in defaults.
3. Run the desktop shell with `pnpm --filter @acc/desktop dev`.
4. Create a workspace from the desktop UI and point it at a Git repo if you want Production Alpha worktree execution.
5. Run the bundled-runtime Production Alpha smoke test with `pnpm smoke:alpha`.
6. Build a standalone macOS app bundle with `pnpm --filter @acc/desktop tauri build --bundles app`.
7. Run the packaged-app smoke test with `pnpm smoke:packaged`.
8. Open the latest local app bundle with `pnpm desktop:open`.
9. Restart the local app bundle with `pnpm desktop:restart`.
10. Build a standalone macOS installer with `pnpm desktop:bundle`.
11. Use `docker compose -f infra/docker-compose.yml up -d` only if you want the legacy external-service dev stack for comparison or future multi-user work.

## Notes

- The local standalone path uses SQLite through Node's built-in `node:sqlite` module and does not require Postgres or Redis for the desktop install flow.
- The desktop app bundles a local Node runtime plus a bundled control-plane entry, starts that control plane automatically on launch, and points the UI at `http://127.0.0.1:7711`.
- The control plane now supports Production Alpha execution primitives: per-agent Git worktrees, tracked runs, transcripts, tool calls, operator approvals, artifacts, and workspace inbox handoffs.
- The desktop shell now exposes run-first views, approvals, inbox handoffs, docked explorer/terminal/artifacts panels, and command-palette actions around tracked runs.
- Provider adapters for live Codex and Claude execution are real. The repo also includes a deterministic `mock` adapter used for smoke coverage of approvals and handoffs without live API keys.
- Provider secrets now migrate from the legacy app-local JSON file into the macOS Keychain service namespace `com.acc.desktop.providers`.
- The packaged app is smoke-tested through the built `.app` bundle in addition to the bundled control-plane runtime.
- The desktop app packages through Tauri into a macOS `.dmg` installer. For signed/notarized builds, use `pnpm desktop:release:macos` after configuring Apple credentials.
- The Docker Compose stack in `infra/` is optional and represents a future externalized deployment mode rather than the default local desktop path.
- The latest bundle artifacts land under `apps/desktop/src-tauri/target/release/bundle/`.
- `pnpm desktop:open` and `pnpm desktop:restart` prefer normal Launch Services bundle opening and fall back to direct executable launch only if macOS refuses the local build bundle.
- Release automation and Apple credential setup notes live in [docs/release/macos-signing-and-notarization.md](/Users/ravindargujral/Downloads/ai-ace/docs/release/macos-signing-and-notarization.md).
- The v1 blueprint lives at [docs/acc-v1-engineering-blueprint.md](/Users/ravindargujral/Downloads/ai-ace/docs/acc-v1-engineering-blueprint.md).
- The first implementation tickets live in [docs/tickets/README.md](/Users/ravindargujral/Downloads/ai-ace/docs/tickets/README.md).
