# ORCH-001: Session Orchestrator State Machine

## Goal

Implement the canonical agent lifecycle and enforce safe state transitions across session start, activity, idle detection, errors, and stop events.

## Scope

- state transition model
- heartbeat handling
- idle timeout checks
- error and stop semantics
- orchestration command execution boundary

## Deliverables

- state machine module with transition guards
- orchestrator worker loop
- persisted session state updates
- audit-friendly event emission for transitions

## Acceptance checks

- invalid transitions are rejected
- idle state is entered after the configured inactivity threshold
- missing heartbeat transitions a live session into error
- terminal states remain terminal

## Dependencies

- depends on `DB-001`
- benefits from `EVT-001` landing first or alongside

