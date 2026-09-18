---
schemaVersion: 1
goal: >-
  Two players can create, join, and play a single shared real-time Evershift session in which both players' inputs drive
  one authoritative simulation whose state both observe within a real-time latency budget.
facts:
  - id: F-GOAL-SESSION
    statement: Two players must be able to join and play a single shared real-time Evershift session together.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective 'Make Evershift multiplayer-capable' — success criteria
  - id: F-REPO-SINGLEPLAYER
    statement: Evershift is documented as a single-player action game today.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: README.md
  - id: F-REPO-NO-NETCODE
    statement: The repository contains no network transport, session management, or multiplayer synchronization code of any kind.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: repository tree (root contains only README.md, docs/architecture.md, src/physics/tick.ts)
  - id: F-REPO-TICK
    statement: The only simulation code present is src/physics/tick.ts, a fixed-timestep local step() with no network awareness.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: F-REPO-DOC-DRIFT
    statement: >-
      docs/architecture.md names render/, input/, persistence/, inventory/, and ai/ systems whose directories do not
      exist in the repository — the doc overstates the code present.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md vs. src/ tree
  - id: F-SYNC-CANDIDATE
    statement: >-
      Client-side prediction with server reconciliation is the leading candidate synchronization approach — a candidate,
      not a commitment.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F-SYNC-FEASIBILITY
    statement: >-
      Whether client-side prediction with server reconciliation can meet the required latency/frame budget for real-time
      play has not been measured; no measurement exists anywhere in the repository.
    status: UNKNOWN
    source: human
  - id: F-CROSSPLATFORM-SCOPE
    statement: >-
      Cross-platform play — the two players joining one shared real-time session from different platforms/OSes — is out
      of scope for this increment by recorded decision: a deliberate non-goal deferred to a named future increment, with
      cross-platform reached additively later through the netcode's retained platform-agnostic transport preference
      rather than re-architecture.
    status: DECIDED
    source: decision
    kind: product-intent
    decisionRef: 38736558-0bed-4cf0-83b6-97628d4e43b9
  - id: F-LATENCY
    statement: >-
      No numeric latency/frame budget has been stated. Working default adopted for this Definition: end-to-end
      shared-state convergence within ~150 ms round-trip and local input-to-display latency not materially worse than
      current single-player play. Rationale: standard action-genre real-time thresholds; reversible default that makes
      'real-time' testable.
    status: ASSUMED
    source: investigation
  - id: F-TRANSPORT
    statement: >-
      Working default adopted for this Definition: sessions are created and joined directly by address on a local
      network (peer-hosted), with no matchmaking infrastructure. Rationale: the smallest mechanism that satisfies 'two
      players join a shared session'; excludes nothing the success criterion asks for.
    status: ASSUMED
    source: investigation
  - id: F-DISCONNECT
    statement: >-
      Working default adopted for this Definition: when one player disconnects mid-session, the remaining player is
      notified and the session ends cleanly rather than hanging. Rationale: safe default for a degenerate input,
      reversible, no product tradeoff required.
    status: ASSUMED
    source: investigation
constraints:
  - description: >-
      Real-time play stays within the F-LATENCY budget: input-to-acknowledged-state latency and divergence must meet the
      recorded latency/frame budget during sustained two-player play (R2).
    type: must
  - description: >-
      One canonical shared session state exists; divergence between client-side views and the authoritative state must
      be detected and surfaced loudly, never silently absorbed (R4).
    type: must
  - description: >-
      No single-player regression: existing single-player behavior and tests must keep passing after the netcode work
      (R5).
    type: must
  - description: >-
      The candidate synchronization approach (client-side prediction with server reconciliation) must be isolated behind
      a seam so that pivoting to the named fallback (lockstep or server-authoritative-without-prediction) stays cheap if
      the F-SYNC-FEASIBILITY measurement fails the budget (R3).
    type: must
  - description: >-
      Do not couple the netcode to platform-specific transport or input APIs; keep it platform-agnostic so a future
      cross-platform increment is additive rather than a re-architecture — retained deliberately as a preference (not
      promoted to a hard constraint by the cross-platform scope decision).
    type: prefer_not
  - description: >-
      Avoid building cross-platform verification machinery in this increment: no platform build targets or cross-OS
      acceptance matrix, per the resolved cross-platform scope decision.
    type: prefer_not
requirements:
  - >-
    Two players can each join the same shared real-time session directly (host/join by address) on a local network, on
    the single platform this increment targets.
  - >-
    Each player's inputs visibly drive the single canonical shared session state within the existing fixed-timestep
    simulation loop.
  - >-
    Client divergence from the authoritative shared state is detected and surfaced loudly (observable/logged), per the
    divergence-visibility constraint.
  - >-
    The synchronization approach is implemented behind an isolation seam so the named fallback (lockstep or
    server-authoritative-without-prediction) can be pivoted to without re-architecture.
  - "Existing single-player behavior is preserved: no regression to the current single-player experience or its tests."
nonGoals:
  - >-
    Rebuilding the full single-player feature set on the shared-session path: this increment demonstrates the shared
    real-time session on the existing simulation's demonstrated feature subset, not feature parity for every
    single-player feature.
  - >-
    Sessions with more than two players: the increment is scoped to exactly two players joining one session; N-player
    scaling, teams, and larger-session concerns are out.
  - >-
    Matchmaking and internet-scale session discovery: no lobby/matchmaking service, public-internet NAT traversal, or
    account/identity infrastructure — joining is direct (host/join by address) on a local network.
  - >-
    Cross-platform play (settled by F-CROSSPLATFORM-SCOPE): two players joining the same session from different
    platforms/OSes is a deliberate non-goal for this increment. No cross-platform build targets and no cross-OS
    acceptance matrix are added; cross-platform is a named future increment, kept additive by the retained
    platform-agnostic transport preference (prefer_not coupling to platform-specific APIs), which this decision
    deliberately leaves as a preference rather than promoting to a hard constraint.
acceptance:
  - description: >-
      Both players' inputs visibly drive the shared canonical session state (each player can observe the other's actions
      affecting the same simulation within the tick loop).
    met: false
  - description: >-
      Divergence between client-predicted state and server-authoritative state is detected and surfaced loudly
      (visible/logged divergence events), per R4.
    met: false
  - description: >-
      Single-player mode shows no regression: existing single-player tests pass and the demonstrated single-player
      feature subset behaves as before the netcode work (R5).
    met: false
  - description: >-
      Latency-budget-verified convergence: measured input-to-acknowledged-state latency and client/server divergence
      during sustained two-client play fall within the F-LATENCY budget — contingent on the F-SYNC-FEASIBILITY
      measurement spike (EXPLORE_AS_WORK) confirming the budget is meetable.
    met: false
---

## Decision applied: cross-platform scope (F-CROSSPLATFORM-SCOPE)

The human resolved the first blocking gap (readiness dimension 2, Boundary): cross-platform support is **excluded as a deliberate non-goal** for this increment (option `exclude-non-goal`, Decision `38736558-0bed-4cf0-83b6-97628d4e43b9`). The scope edge the review failed on is now settled: this increment demonstrates two players joining and playing **one shared real-time session on the single platform this increment targets**. Cross-platform play — two players joining the same session from different platforms/OSes — becomes a named future increment.

### What the choice changes

- **nonGoals** gains the explicit cross-platform entry (full revised list submitted). This is the only section the resolution edits.
- **Requirements and acceptance are untouched.** No cross-platform join criterion, no cross-OS acceptance matrix, no new platform build targets — those belonged to the `include-acceptance` path and are deliberately not taken.
- **Constraints are untouched, by choice.** The platform-agnostic transport hedge stays a *prefer_not* (no coupling to platform-specific APIs) rather than being promoted to a hard *must_not* — that promotion was the separate `include-constraint-only` path. The selected option retains the soft preference so the future cross-platform increment is additive rather than a re-architecture, but nothing in this increment's contract *enforces* platform-agnosticism.

### Tradeoff accepted

This is the narrowest, fastest path to a demonstrated shared real-time session: no extra build targets, no widened test matrix, no cross-platform transport verification. The cost is that the capability is unverified now and the "additive later" property rests on a preference enforced only by review vigilance rather than by a hard constraint. If implementation drifts into platform-specific coupling, the future cross-platform increment becomes a re-architecture — that retrofit risk is accepted, not eliminated. Nothing in this increment produces a verified cross-platform claim, and the Definition must not imply one.

### What this decision does not settle

- **F-SYNC-FEASIBILITY remains the sole blocking gap** (dimension 7, routed EXPLORE_AS_WORK). Whether client-side prediction with server reconciliation can meet F-LATENCY is still unmeasured; the readiness verdict requires it to be isolated as bounded measurement work — the two-simulated-client spike at the repository's tick rate measuring input-to-acknowledged-state latency and divergence against the budget — or resolved KNOWN before this scope is eligible to pass. Its failure path (fallback to lockstep or server-authoritative-without-prediction) changes latency feel and cheat resistance and may itself warrant a further human decision on accepted product feel.
- **F-TRANSPORT and F-DISCONNECT remain ASSUMED** with recorded safe defaults inside already-authorized intent; this decision neither confirms nor disturbs them.
- The softness of the transport preference is now a deliberate, accepted posture rather than an open question: promoting it to a hard constraint was offered and not chosen.
