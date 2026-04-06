# ACC Codex-Style Shell Redesign Plan

## Goal

Reorganize Agent Command Center so it feels closer to the Codex desktop app:

- conversation-first
- fewer competing panels on first open
- scope-aware chat that can target the workspace, the planner, or a specific agent
- workspace/project tools moved into a contextual right sidebar
- live activity, approvals, artifacts, and terminals available without taking over the main surface

The redesign should simplify the shell without losing the Production Alpha functionality we already have.

## Why change the shell

The current Home view is functionally rich, but it asks the operator to parse too many surfaces at once:

- workspace strip
- broadcast bar
- filter row
- fleet table
- inspector
- docked explorer / terminal / artifacts

This creates two UX problems:

1. There is no single primary interaction model.
   The operator is not clearly pushed toward one core action such as "chat with the workspace" or "inspect one run".

2. High-value panels compete vertically.
   Broadcast, fleet, inspector, and explorer all fight for height, which makes the UI break down quickly as the workspace gets busier.

The target redesign solves this by making **threads and scopes** the main organizing principle instead of stacked dashboard panels.

## Current functionality that must be preserved

### Workspace and project

- create / rename / delete workspace
- set `projectRoot`
- browse repo files
- read and edit project files
- import shared context from repo files
- manage shared context centrally

### Agents and runs

- create agents
- create and launch agents
- per-agent title, provider, model, task, `cwd`
- per-agent worktree lifecycle
- start / interrupt / stop agent
- start / stop tracked runs
- per-run transcript
- per-run tool calls
- per-run artifacts
- per-run approvals
- per-run handoffs

### Workspace-wide coordination

- broadcast instruction to visible or all agents
- planner-generated suggested fleet
- save/load planner recommendations
- create agents from planner recommendations

### Observability and operations

- fleet status filtering
- live event stream / polling fallback
- latest activity per agent
- usage/cost telemetry
- runtime health
- provider status
- pending approvals
- inbox / handoffs

### Dock tools

- Explorer
- Terminal
- Artifacts

### Desktop shell

- command palette
- left navigation
- workspace selection
- restart/open app scripts

## Target product model

### Primary object: thread

The app should behave like a multi-scope conversation workspace.

A thread can be:

- `Workspace thread`
  - default conversation for the whole workspace
  - equivalent to the current broadcast surface
- `Planner thread`
  - chat with a planning model
  - can recommend fleet composition, revisit plans, and spin out agents
- `Agent thread`
  - chat scoped to one specific agent
  - selecting an agent switches the conversation and the related feed/context to that agent
- `Live thread`
  - operational stream for merged workspace activity
  - not the default first screen, but always one click away
- `Inbox thread`
  - handoffs and approvals

### Primary interaction: scope-aware composer

The center of the app should be a Codex-style conversation area with one main composer.

The composer has a scope selector:

- `Workspace`
- `Planner`
- `Selected agent`
- optionally `Visible agents` / `All agents` for multi-agent commands

This keeps the mental model simple:

- type into the same composer
- change scope when needed
- the app routes the instruction appropriately

## Target layout

### Left sidebar

Use the left side primarily for navigation and threads, not for dense operational cards.

Suggested structure:

- workspace switcher
- `Home`
- `Planner`
- `Live`
- `Inbox`
- thread list
  - workspace thread
  - planner threads
  - agent threads
  - recent runs / recent conversations

The agent list should live here as a thread/source list, not as the main content of Home.

### Center panel

The center panel becomes the main conversation surface.

It should show:

- conversation transcript
- tool call summaries inline
- approvals inline
- run status markers inline
- artifacts/diffs as inline cards when relevant

When the user is in:

- `Workspace thread`
  - show workspace-wide conversation and broadcast actions
- `Planner thread`
  - show planning conversation and recommended fleet blocks
- `Agent thread`
  - show that agent's conversation, latest run transcript, tool activity, and approvals
- `Live`
  - show merged fleet feed with jump links into agents/runs
- `Inbox`
  - show handoffs and approvals in a list optimized for triage

### Right sidebar

Move workspace/project controls to the right, similar to Codex's contextual utility pane.

Suggested tabs:

- `Context`
  - workspace shared context
  - mounted packs
  - planner recommendation snapshots
- `Files`
  - project tree
  - open file preview/editor
  - selected agent worktree scope if applicable
- `Run`
  - selected run metadata
  - usage
  - model/provider
  - cwd/worktree
- `Ops`
  - runtime status
  - provider status
  - agent controls

The right sidebar content changes depending on the selected thread/scope.

### Bottom panel

Keep the bottom panel optional and collapsible.

It should hold:

- terminal
- artifacts
- diff
- telemetry

The bottom panel should not be required for normal navigation. It should expand when the operator wants deeper inspection or active tooling.

## How current functionality maps into the new shell

| Current capability | Current location | Target location |
| --- | --- | --- |
| Workspace rename / project root | Home workspace strip | Right sidebar `Context` / `Ops` tab |
| Broadcast | Home broadcast bar | Workspace thread composer scope |
| Agent chat | Inspector | Agent thread in center panel |
| Planner screen | Separate page | Planner thread |
| Fleet table | Home center panel | Left thread/source list + optional compact Home summary |
| Live feed | Home toolbar / separate page | Dedicated `Live` thread/page |
| Approvals | Inbox + inspector | Inline in thread + Inbox thread |
| Handoffs | Inbox | Inbox thread + inline follow-up cards |
| Explorer | Dock | Right sidebar `Files` tab, with optional bottom diff/editor |
| Terminal | Dock | Bottom panel |
| Artifacts | Dock | Bottom panel + inline run cards |
| Run telemetry | Inspector | Agent thread inline + bottom telemetry panel |
| Provider settings | Separate page | Right sidebar `Ops` or dedicated settings modal |
| Runtime status | Separate page | Right sidebar `Ops` + small global status in top chrome |

## Proposed behavior changes

### 1. Home becomes much smaller

`Home` should stop being the operational dashboard.

Instead it becomes a lightweight landing view with:

- workspace summary
- quick resume actions
- recent threads
- recent agent activity

It should not own the full workspace strip + broadcast + fleet + dock stack.

### 2. Broadcast becomes a thread, not a panel

The workspace-wide instruction surface should live in the center conversation area.

Behavior:

- open workspace thread
- choose target scope:
  - selected agents
  - visible agents
  - all agents
- send the instruction
- see per-agent run request/activity inline in the same thread

### 3. Selecting an agent switches context

When the operator clicks an agent:

- the center panel becomes that agent's thread
- the right sidebar switches to that agent's files/run/context
- the activity feed narrows to that agent by default

This should feel like switching from one Codex thread to another, except each thread is bound to an ACC agent.

### 4. Planner becomes a first-class chat mode

Planner should feel like another conversation, not a form-first page.

Behavior:

- start a planner thread
- ask for a plan in natural language
- planner replies with suggested fleet, sequencing, and roles
- operator can:
  - save the recommendation
  - create agents
  - create and launch agents
  - revisit and refine the plan in the same thread later

### 5. File browsing becomes contextual

The file tree should primarily live in the right sidebar `Files` tab and follow the current scope:

- workspace thread -> workspace root
- planner thread -> workspace root
- agent thread -> that agent's `cwd` or worktree root

This is less visually heavy than a permanent bottom explorer and keeps the currently relevant files close to the conversation.

### 6. Live feed becomes a real operational page

The live feed should no longer compete with the fleet table.

The `Live` page/thread should show:

- merged live feed
- latest by agent
- click-to-focus on agent/run
- filtering by:
  - all
  - errors
  - approvals
  - running
  - workspace vs specific agent

## Suggested target information architecture

### Top chrome

Keep top chrome minimal:

- workspace name
- connected / polling / streaming
- command palette
- maybe provider/runtime indicators

Do not repeat operational summaries here.

### Left column

- navigation
- workspace/thread tree
- recent agent threads
- recent planner threads

### Center column

- one active thread
- one composer
- one transcript surface

### Right column

- contextual utilities
- files
- context
- run metadata
- ops

### Bottom panel

- optional tools only
- terminal / artifacts / diff / telemetry

## Data and UX model alignment

This shell redesign should **not** require a large backend rewrite.

We can preserve:

- workspaces
- agents
- runs
- transcript entries
- tool calls
- artifacts
- approvals
- handoffs
- planner suggestions

What changes is mostly the presentation layer and the thread abstraction on top of existing run/agent/workspace entities.

## Migration phases

### Phase 1: shell simplification

- reduce Home to a light landing view
- add left thread list
- add dedicated Live page
- move workspace/project/context controls into right sidebar
- keep existing backend data and actions

### Phase 2: conversation-first center panel

- make workspace thread the default center view
- make agent click open agent thread
- make planner a chat thread instead of a form page
- embed broadcast/agent messaging into the same composer model

### Phase 3: contextual right sidebar

- move file tree into right sidebar
- move shared context / packs into right sidebar
- move run metadata / ops into right sidebar
- keep bottom panel for terminal/artifacts only

### Phase 4: operational polish

- richer live feed filters
- agent pinning / favorites
- open file tabs
- better diff review
- planner-to-agent transitions that feel seamless

## Recommended first implementation slice

To move toward this shell safely, start with the smallest slice that changes the mental model:

1. Introduce a `thread` concept in the UI layer only.
2. Add three thread types:
   - workspace
   - planner
   - agent
3. Make the center view conversation-first for those threads.
4. Move files/context into a right sidebar.
5. Keep terminal/artifacts in the bottom panel.

This gets the app much closer to the Codex feel without risking the backend functionality we already have.

## Success criteria

The redesign is successful when:

- a new user understands the main interaction in under 10 seconds
- the default screen has one obvious place to type
- selecting an agent clearly changes the scope of the conversation and side context
- the workspace/project tools are available, but not shouting
- the live operational stream is visible when needed without crowding the default conversation view
- we preserve approvals, handoffs, worktrees, transcripts, artifacts, and planner flows

## Recommended next action

Implement the redesign in this order:

1. thread model in the desktop UI
2. new left thread list
3. conversation-first center panel
4. right sidebar for files/context/workspace
5. planner as chat mode
6. bottom panel reduction to tools only

That gives us a clean path from the current dashboard-heavy shell to a Codex-like operator experience without throwing away the Production Alpha feature set.
