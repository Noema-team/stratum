---
schemaVersion: 1
goal: >-
  Two players can join and play a shared real-time Evershift session together, with one authoritative session whose
  player state is replicated to both clients, while existing single-player offline play remains intact.
facts:
  - id: F1
    statement: The intended outcome is that two players can join and play a shared real-time Evershift session together.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective success criteria
  - id: F2
    statement: >-
      Cross-platform play — a shared session with clients running on more than one target platform — is out of scope for
      this increment: recorded as a deliberate non-goal by human decision, not an oversight. The bounded scope remains
      the minimal two-process authoritative session (direct join, localhost/LAN); reversibility toward a future
      cross-platform increment is carried only by the standing preference against transport/serialization choices that
      would make it materially costlier, and cross-platform play is re-opened as its own increment when prioritized.
    status: DECIDED
    source: decision
    kind: product-intent
    decisionRef: d4618d31-212e-4cbc-82ab-31330d90fbe7
  - id: F3
    statement: >-
      Client-side prediction with server reconciliation is a candidate synchronization approach only; the Objective does
      not mandate it.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F4
    statement: >-
      Whether client-side prediction with server reconciliation can actually meet the required latency/frame budget for
      real-time play has not been measured; no empirical answer exists.
    status: UNKNOWN
    source: human
  - id: F5
    statement: >-
      Working default adopted so acceptance is testable: a shared session counts as real-time when player-state updates
      propagate between clients within ~100ms RTT-equivalent latency without breaking play continuity; rationale:
      standard genre-typical budget for responsive shared play, chosen as a reversible engineering default inside the
      already-authorized 'real-time' intent, not as a settled product commitment.
    status: ASSUMED
    source: investigation
  - id: F6
    statement: >-
      The repository contains no network transport, session management, or multiplayer synchronization code; every
      existing system assumes a single local player and single local simulation tick, with no concept of a remote peer,
      server authority, or state replication.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md
  - id: F7
    statement: >-
      The physics simulation advances through a fixed-timestep local tick (src/physics/tick.ts step(dtMs)) with no
      network awareness.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: F8
    statement: Evershift is documented and positioned as a single-player action game today.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: README.md
  - id: F9
    statement: >-
      The source tree currently contains only src/physics/; the other systems named in docs/architecture.md
      (src/render/, src/input/, src/persistence/, src/inventory/, src/ai/) are not present in the repository, so the
      architecture document is ahead of the actual tree.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/
constraints:
  - description: >-
      Preserve existing single-player offline behavior: the local fixed-timestep simulation path (F7) must keep working
      unchanged when no session is joined.
    type: must
  - description: Single-player play must not require any network connectivity or a running session authority.
    type: must_not
  - description: Limit a shared session to at most two concurrent players in this increment (F1).
    type: must
  - description: >-
      Do not present client-side prediction with server reconciliation as a settled architecture decision without
      measurement evidence against the latency budget (F3, F4).
    type: must_not
  - description: >-
      Instrument the session/synchronization layer with per-tick latency and tick-consistency diagnostics so F4 can be
      answered empirically from real sessions.
    type: prefer
  - description: >-
      Avoid transport and serialization choices that would foreclose or make materially costlier a later answer to the
      cross-platform question (F2).
    type: prefer_not
requirements:
  - >-
    A player can create (host) a session from one client process, and a second player can join that same session from a
    separate client process via a direct address or join identifier.
  - >-
    Player-controlled state — at minimum each player's inputs and resulting entity position/movement — is replicated
    between the two clients of a session.
  - >-
    Exactly one authority (the hosting session) resolves concurrent/conflicting state, and its authoritative result
    propagates to both clients.
  - >-
    The shared session advances on a common fixed timestep so both clients observe consistent authoritative session
    state for the same tick.
  - >-
    The existing single-player local simulation path continues to function with no network connectivity and unchanged
    behavior.
  - >-
    Joining or leaving a session is handled explicitly (session lifecycle), including the case of the second player
    disconnecting mid-session.
nonGoals:
  - >-
    Cross-platform play — a shared session with clients running on more than one target platform — is excluded from this
    increment as a deliberate scope decision, not an oversight; it is re-opened as its own increment when prioritized,
    with reversibility carried only by the standing preference against transport/serialization choices that would make
    that later increment materially costlier.
  - >-
    Matchmaking or session-discovery services: joining is direct (host/join by address) on localhost or a local network;
    no discovery infrastructure is built in this increment.
  - >-
    Internet-scale deployment concerns — NAT traversal, relays/TURN, or public backend infrastructure — are outside this
    increment; the transport is exercised only within a local network.
  - "Sessions with more than two concurrent players: the bounded scope is exactly two players."
acceptance:
  - description: >-
      Two client processes join the same session by direct address (host/join) on localhost or a local network, and both
      observe identical shared session state after each interaction.
    met: false
  - description: >-
      In the shared session, a state-changing action by one player becomes visible on the other client within the
      working latency budget recorded for this increment (currently the safe-default budget, pending the F4
      measurement).
    met: false
  - description: >-
      Given the same ordered inputs, a shared-tick run of the session produces bit-identical authoritative state on both
      clients, with a single authoritative resolution of concurrent inputs.
    met: false
  - description: >-
      Single-player play continues to work fully offline, with no regression against existing single-player behavior,
      while the multiplayer code paths exist in the build.
    met: false
---

## Decision record — cross-platform membership (F2)

**Resolved: exclude as a deliberate non-goal.** The genuinely open product question the Objective carried — whether cross-platform play belongs inside this multiplayer increment — is now settled by human decision: it does not. The bounded scope stands at the minimal authoritative two-player session: two client processes, direct join by address, localhost or a local network. Cross-platform play is re-opened as its own increment when it is prioritized.

### What this settles

- The boundary now has a real edge where it previously had only honest openness. The F2 gap the readiness review raised on the Boundary dimension closes on this decision's authority: the scope is *decidedly* local, not merely *not yet decided* to be otherwise.
- The increment's cost and test surface stay as scoped: no work is added to make the chosen transport/serialization run on multiple target platforms, and no cross-platform two-client join scenario enters the acceptance model. The four existing acceptance slices are unchanged.

### What it deliberately does not do

- The existing preference — avoid transport/serialization choices that would make a later cross-platform increment materially costlier — remains a **preference**, not a hard constraint. Elevating it to a verifiable platform-neutrality constraint was the middle option, and it was not chosen. Nothing in this increment mechanically enforces platform neutrality; that is accepted, not overlooked.
- No groundwork is claimed. This decision records exclusion, not a head start on the future feature.

### The accepted tradeoff

Reversibility toward the future cross-platform increment is now carried *only* by soft preference. Named risk: if the first transport/serialization choice drifts toward something platform-locked in practice, the cost of the eventual cross-platform increment grows, and nothing in this increment's constraints will catch that drift at review time. The mitigation is deliberate and thin: choose the first transport for replaceability, not permanence, and revisit that choice whenever the transport is touched. This is a conscious trade of enforcement now for scope minimization now.

### What remains open

- **F4 is untouched by this decision.** Whether client-side prediction with server reconciliation can meet the required latency/frame budget is still this scope's own feasibility question, still routed for isolation as bounded exploration work (an instrumented two-client session measuring input-to-propagation latency against the F5 working budget). Excluding cross-platform removes one axis of coupling to that measurement — it need not run across heterogeneous platforms, only two clients on localhost/LAN — but it does not narrow, answer, or defer the measurement itself.
- **F5** (the working latency budget) remains a safe-default assumption standing in for that measurement, with its recorded fallback: revisit with instrumentation data rather than defend it.
- **F6** (single-player coupling depth) and **F9** (stale documentation vs. actual tree) remain work-time concerns, unchanged in status.

With the scope edge settled, the one remaining blocker to authorization is the F4 feasibility measurement.
