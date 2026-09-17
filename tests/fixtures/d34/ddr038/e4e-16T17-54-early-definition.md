---
schemaVersion: 1
goal: >-
  Two players can join one shared, real-time Evershift session — one creating it, one joining — and play it together
  over a synchronized simulation, while the existing single-player game keeps working unchanged.
facts:
  - id: f-multiplayer-intent
    statement: Two players should be able to join and play a single shared real-time Evershift session together.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective success criteria
  - id: f-prediction-candidate
    statement: >-
      Client-side prediction with server reconciliation is a candidate synchronization approach for the shared session —
      a candidate, not a mandated approach.
    status: KNOWN
    source: human
    kind: product-intent
  - id: f-crossplatform-undecided
    statement: >-
      Cross-platform play is excluded from this multiplayer increment as a deliberate non-goal: only the current single
      target platform is in scope, and platform interoperability between distinct clients (e.g., web and native desktop)
      is deferred to a future increment with no new constraint attached.
    status: DECIDED
    source: decision
    kind: product-intent
    decisionRef: fed2443f-1ff1-4669-a219-b824a9f0aebb
  - id: f-prediction-budget-unmeasured
    statement: >-
      Whether client-side prediction with server reconciliation can actually meet the latency/frame budget required for
      real-time play has not been measured; no such measurement exists anywhere yet.
    status: UNKNOWN
    source: human
  - id: f-no-netcode
    statement: >-
      There is no network transport, session management, or multiplayer state-replication code anywhere in this
      repository.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md; full src/ listing
  - id: f-tick-stub
    statement: >-
      The only source file in the repository is src/physics/tick.ts, whose step(dtMs) is an empty no-op; the subsystem
      paths listed in docs/architecture.md (src/render/, src/input/, src/persistence/, src/inventory/, src/ai/) do not
      exist, so the core simulation itself is unimplemented.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: f-latency-budget-default
    statement: >-
      No explicit latency/frame budget is stated in the Objective or repository; adopted working default so acceptance
      is testable: 60 Hz fixed simulation tick, session playable at up to ~100 ms round-trip between the two players, no
      visible rubber-banding below 150 ms RTT. Rationale: standard action-game real-time budget; a safe default a
      reviewer can tighten, recorded rather than silently assumed.
    status: ASSUMED
    source: investigation
  - id: f-topology-default
    statement: >-
      Adopted default topology: host-authoritative sessions — one player creates the session and is the simulation
      authority, the second player joins; no dedicated global server fleet in this increment. Rationale: smallest
      faithful realization of 'two players join and play'; reversible in code and does not commit infrastructure.
    status: ASSUMED
    source: investigation
  - id: f-transport-default
    statement: >-
      Adopted default transport: a thin transport abstraction with the first implementation over a reliable ordered
      channel (WebSockets); unreliable/UDP-like delivery is deferred unless measurement shows head-of-line blocking
      breaks the budget. Rationale: simplest correct channel first, abstracted so the swap is cheap.
    status: ASSUMED
    source: investigation
constraints:
  - description: >-
      Solo play must remain intact and fully functional — the single-player experience is unchanged by the addition of
      shared-session multiplayer.
    type: must
  - description: >-
      A shared session is exactly two players reached by direct join; the increment must not grow beyond the two-player
      direct-join fence.
    type: must
  - description: >-
      The synchronization strategy must remain isolated behind an interface so it can be swapped (the bounded pivot path
      if client-side prediction fails its budget measurement).
    type: must
  - description: >-
      The session must run host-authoritative on one player's machine; no dedicated or managed server infrastructure may
      be introduced.
    type: must_not
  - description: >-
      Responsiveness under the adopted budget should be verified as a testable property: 60 Hz fixed tick maintained, up
      to 100 ms RTT tolerated, no visible rubber-banding below 150 ms (adopted default, challengeable by the human).
    type: prefer
requirements:
  - >-
    A player can create (host) a session and a second player can join it via a direct join mechanism (invite code or
    address); no matchmaking is required.
  - >-
    Both players act simultaneously in the same session; each player's controlled entity is visible to, and consistent
    for, both players.
  - >-
    Both peers advance the same fixed-timestep simulation from the same ordered input stream, so shared state converges
    without transmitting full world state every tick.
  - >-
    Each player's own input applies immediately on their client without waiting for a network round-trip, and
    authoritative corrections converge state without visible stutter within the adopted latency budget
    (f-latency-budget-default).
  - >-
    At least one representative player-controlled gameplay action (e.g., movement of the player entity) is synchronized
    end-to-end, so 'playing together' is demonstrable and testable.
  - Solo play with no session and no network active continues to function exactly as before.
  - If either peer disconnects, the other side receives a clear session-ended outcome — no hang, no silent desync.
nonGoals:
  - >-
    Matchmaking and session discovery beyond direct join — no lobby browsing, matchmaking queues, or invite flows; the
    second player reaches the session by direct join only
  - Player accounts, authentication, and persistent identity — no sign-in, profiles, or cross-session player records
  - Presence and social features — no online status, friends lists, or chat
  - >-
    Dedicated or managed server infrastructure — the session runs host-authoritative on one player's machine; no match
    servers are built or operated
  - >-
    Cross-platform play — interoperability between distinct platform clients (e.g., a web client and a native desktop
    client) in one shared session. Only the current single target platform is in scope this increment; platform
    interoperability is deferred to a future increment, deliberately with no new constraint attached
acceptance:
  - description: >-
      Two players join one shared real-time session (one creates, one joins by direct join) and both observe the same
      simulation state.
    met: false
  - description: >-
      At least one representative player-controlled action is synchronized end-to-end between the two players within the
      same fixed tick, observable by both — not merely an established connection or a synchronized stub.
    met: false
  - description: >-
      The latency/frame budget is measured against the minimal client-side prediction with server reconciliation path on
      the target platform: 60 Hz fixed tick maintained, up to 100 ms RTT tolerated, no visible rubber-banding below 150
      ms.
    met: false
  - description: >-
      Solo play remains intact and fully functional with the multiplayer changes present (no network dependency
      introduced for single-player sessions).
    met: false
---

## Human Decision applied: cross-platform membership — excluded as a deliberate non-goal

The human settled the one scope-membership question this Definition refused to guess: cross-platform play does **not** belong in this increment. It is recorded as an explicit non-goal; only the current single target platform is in scope, and platform interoperability is deferred to a future increment. The option chosen was plain exclusion — deliberately *not* the "exclude but preserve the option" variant — so **no new constraint is attached**: this Definition demands no forward-compatibility or platform-neutrality discipline going forward.

**What this settles.** The bounded scope now has an actual edge on the cross-platform axis. The readiness review's Boundary failure existed precisely because this member was neither in nor out; that state is gone, and the increment remains what it was designed to be — the smallest faithful multiplayer slice: one player creates a session, one joins by direct join, both share a real-time fixed-tick simulation over WebSocket behind an abstraction, with solo play intact. The schedule-stretch branch of the cross-platform risk (R2) can no longer occur, and the undecided-member half of that risk is retired with it. No requirement, constraint, or acceptance criterion changes: acceptance gains no cross-platform pairings, and the latency-budget runs remain single-platform on the current target.

**What the plain exclusion costs — accepted, not accidental.** The door is left unpropped. In practice the adopted defaults (host-authoritative topology, WebSocket behind an interface, interface-isolated sync strategy) already happen to be platform-neutral, so a future cross-platform increment would likely build on them — but that neutrality is now *incidental*, not guaranteed by anything this Definition enforces. Named risk: a future increment adding platforms may find the transport and input abstractions have drifted target-platform-specific, and the cost of that discovery is rework in *that* increment. The human accepted that exposure knowingly by choosing plain exclusion over the constraint-attached variant; it is a deliberate deferral of cost, not an oversight, and it is not a defect of this scope.

**What this decision leaves open — the sole remaining blocker.** The prediction-budget question is untouched by this resolution and remains the only thing between this Definition and authorization. Client-side prediction with server reconciliation is still a *candidate*, not a commitment: whether it holds the adopted budget (60 Hz fixed tick, up to 100 ms RTT tolerated, no visible rubber-banding below 150 ms) is unmeasured, and no amount of reading or deciding substitutes for building the minimal prediction/reconciliation path and measuring it. That is bounded exploratory work inside this increment with a recorded pivot path — if the measurement fails, the interface-isolated sync strategy is swapped in without reopening the goal. Note also that the latency budget itself is still an adopted ASSUMED default, explicitly challengeable: the human may retune it, but nothing in this cross-platform decision touched it, and a reasonable recorded default inside authorized intent is not itself a human question.

With this decision recorded, the scope fence is closed on every axis the Objective left open except the measurement — and that one is work, not a question.
