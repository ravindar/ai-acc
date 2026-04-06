# Decisions

## Repository

- Monorepo toolchain: `pnpm` workspaces + `turbo`
- Language: TypeScript across apps and packages
- Desktop shell: Tauri host with React renderer
- Backend: local Node.js control plane

## Backend assumptions

- Fastify-style API scaffold chosen for a lightweight local service footprint
- SQLite is the source of truth for the standalone desktop path
- Redis is no longer part of the local desktop runtime path and remains only a future option for externalized orchestration
- Baseline persistence uses runtime-native drivers (`node:sqlite` locally) rather than adding an ORM before the domain model settles
- Migrations are raw SQL files tracked via a lightweight `schema_migrations` table
- The control plane can auto-run migrations on startup in local development

## Frontend assumptions

- The initial desktop shell should communicate product intent immediately, even before live data exists
- A high-signal operations dashboard is more useful for early alignment than a blank app frame
- Zustand and React Query are the likely state boundaries for v1
- The desktop shell should default to a local control plane URL and degrade gracefully when the backend is offline
- A deterministic mock agent loop is the fastest way to exercise the real UI, event stream, and usage surfaces before live provider adapters are ready
- The standalone desktop installer should carry its own local control-plane runtime instead of assuming separately installed infrastructure
- Live provider adapters should be normalized behind a lightweight runtime-event contract so persistence envelopes remain a control-plane concern
- The embedded desktop runtime should treat provider API keys as configuration inputs, but not bake secrets into the installer image
- If the desktop app spawned the local control plane itself, it is responsible for supervising and restarting that process after crashes
- The desktop app must not crash if the embedded control plane fails to start; backend startup errors should be surfaced in-app while the supervisor keeps retrying
- Provider settings must be reachable even when no workspace is loaded so operators can recover from startup and configuration issues without leaving the app
- Provider key persistence now uses macOS Keychain-backed Tauri commands, with one-time migration from the legacy app-local JSON file for existing installs
- The local Tool Broker remains the source of truth for tool execution and approvals; provider-native tool calling is used only as the transport layer for OpenAI and Anthropic
- Production Alpha tracked runs currently favor correctness and persistence over incremental streaming, so native provider tool turns are executed as durable request/response steps before richer streaming is added back

## Delivery assumptions

- We are optimizing for a local-first single-operator v1
- Ticket docs are implementation-ready, not just product placeholders
- Blueprint remains the source document; context files only track execution state and decisions
- macOS distribution should be handled through Tauri's standard signing and notarization environment variables so local builds and CI use the same path
- A self-contained local install is more important than preserving the earlier service-split dev architecture
- Universal macOS packaging must validate the architecture of the bundled Node runtime explicitly rather than assuming the current Node process is safe to copy
