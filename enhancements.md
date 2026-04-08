  Enhancement tiers:

  Tier 1 — Critical (fix now):
  1. Symlink escape in file sandbox (realpathSync missing)
  2. void continueRun(...) fire-and-forget — stuck runs on crash
  3. No HTTP rate limiting on the API
  4. Pending approval state not recovered on restart

  Tier 2 — High-value features:
  - Conversation memory (auto-summarize runs into memory blocks)
  - Real-time agent-to-agent streaming (push, not poll)
  - Artifact versioning with diffs
  - Workspace snapshots + run replay
  - Auto-start all run_now agents simultaneously
  - Richer approval UX (diffs, syntax highlight, edit-before-approve)
  - Agent capability profiles (reader / writer / commander / orchestrator)

  Tier 3 — Architecture upgrades:
  - Extract App.tsx into focused components (10,800-line monolith)
  - Replace coordination JSON blobs with proper relational tables
  - Streaming command output (live terminal in transcript)
  - Auto-commit worktree changes after each run

  Tier 4 — Product vision:
  - Agent template marketplace
  - Local model support (Ollama adapter)
  - Mobile observer mode (read-only companion app)
  - Auto-approval policies with SLA timeouts