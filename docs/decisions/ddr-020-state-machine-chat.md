# DDR-020 — Chat is orthogonal to system state

**Date:** 2026-04-17 · **Status:** accepted
**Resolves:** G20, G13

## Context

SLE-024 §2 contradicts itself: it opens with "The system is always in exactly one state. States are mutually exclusive" but its notes state "chatting and cycling can overlap. Chat is always available." This makes the state machine unimplementable as drawn — if states are mutually exclusive, `chatting` and `cycling` cannot coexist.

Additionally, G13 (SLE-012 vs SLE-024) creates a secondary contradiction: SLE-012 says "conversation mode is always available, regardless of system state" but SLE-024's state machine treats `chatting` and `discovering` as mutually exclusive states.

## Options considered

| Option | Pros | Cons |
|--------|------|------|
| A: Chat is a system state | Simple model, one state to track | Cannot be available during other states; contradicts SLE-012; gates/blocking states create UX confusion |
| B: Chat is orthogonal (session layer) | Always available regardless of system state; matches user expectation; resolves G13 as side effect | Requires separate tracking from system state |

## Decision

Chat is not a system state. It is an orthogonal session layer with its own state (`open` / `closed`), independent of whatever the system is doing (`idle`, `discovering`, `cycling`, `halted`).

## Consequences

- System states become: `idle | discovering | cycling | halted` (plus `complete` as terminal)
- `chatting` is removed from the state machine entirely
- `map.yaml` tracks chat via `chat.session_open: boolean`, not via `meta.status`
- Chat availability during `discovering`, `cycling`, or `idle` is no longer a contradiction (G13 resolved)
- The Facilitator becomes the interface layer with two modes:
  - **Chat mode** — freeform Q&A with project + cycle context
  - **Decision mode** — triggered by pending actions (gates, sharding approval, halt); user can act immediately, ask clarifying questions, or add context before deciding
- The context manager assembles different slices depending on Facilitator mode
- Full Facilitator design (mode switching, prompts, context assembly) is specified in `specs/conversation.md`
