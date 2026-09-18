---
schemaVersion: 1
goal: >-
  Two players can join and play one shared real-time Evershift session over a network, driven by a single authoritative
  fixed-timestep simulation whose synchronization approach is measured against a stated real-time latency budget.
facts:
  - id: f-intent-shared-session
    statement: >-
      Two players should be able to join and play a shared real-time Evershift session together; the Objective's
      declared success criterion is that two players can join and play a shared real-time session.
    status: KNOWN
    source: human
    kind: product-intent
  - id: f-xplat-undecided
    statement: >-
      Whether cross-platform support belongs in this increment is genuinely undecided; it is an open
      product/architecture question, not yet a constraint or non-goal.
    status: UNKNOWN
    source: human
    kind: product-intent
  - id: f-csp-candidate
    statement: >-
      Client-side prediction with server reconciliation is a candidate synchronization approach for the shared session
      (a candidate, not a chosen approach).
    status: KNOWN
    source: human
    kind: product-intent
  - id: f-csp-unmeasured
    statement: >-
      It has not been measured whether client-side prediction with server reconciliation can actually meet the
      latency/frame budget required for real-time play; no measurement exists.
    status: UNKNOWN
    source: human
  - id: f-repo-single-player
    statement: >-
      The repository is a single-player action game: there is no network transport, session management, or multiplayer
      synchronization code anywhere in it.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md; README.md
  - id: f-repo-local-assumption
    statement: >-
      Every existing system assumes a single local player and a single local simulation tick; there is no concept of a
      remote peer, a server authority, or state replication.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md
  - id: f-repo-tick
    statement: >-
      src/physics/tick.ts implements a fixed-timestep local simulation step (step(dtMs)) with no network awareness and
      no state serialization/snapshot hooks.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: f-repo-arch-discrepancy
    statement: >-
      docs/architecture.md lists rendering, input, persistence, inventory, and AI systems under src/render/, src/input/,
      src/persistence/, src/inventory/, and src/ai/, but src/ currently contains only src/physics/; the other listed
      systems are not present at those paths.
    status: KNOWN
    source: investigation
    kind: repository-claim
    evidenceRef: directory listing of src/ vs docs/architecture.md
  - id: f-assume-server-authority
    statement: >-
      Working default: an authoritative client-server topology is adopted — one session authority owns the shared
      simulation and both clients connect to it — because the candidate approach (client-side prediction with server
      reconciliation) presupposes server authority; peer-to-peer lockstep would contradict the stated candidate.
    status: ASSUMED
    source: investigation
  - id: f-assume-latency-budget
    statement: >-
      Working default: 'real-time' play is taken to require sustained peer round-trip time of 150 ms or less with local
      input-to-render latency of 100 ms or less at a 60 Hz render rate, because the Objective references a required
      latency/frame budget but states no number; this default is to be validated by measurement before the
      synchronization approach is declared final.
    status: ASSUMED
    source: investigation
  - id: f-assume-disconnect
    statement: >-
      Working default: when one player disconnects, the session degrades gracefully — the surviving player is notified,
      nothing crashes, and the session converts to a defined local single-player state — chosen as the least destructive
      default since the Objective does not specify disconnect behavior.
    status: ASSUMED
    source: investigation
  - id: f-assume-transport
    statement: >-
      Working default: the networking layer is implemented in the repository's existing TypeScript stack over WebSocket
      transport for this increment, chosen for broad deployability; this is reversible and does not preclude a later
      transport change.
    status: ASSUMED
    source: investigation
  - id: f-defer-persistence
    statement: >-
      Integration of the existing save/load system with shared multiplayer sessions (persistent shared-session state) is
      understood to be later-phase work and is not required for this bounded scope of joining and playing a shared
      real-time session.
    status: DEFERRED
    source: investigation
constraints:
  - description: >-
      Exactly one authority (the session server/authority) advances the authoritative shared simulation; clients must
      not advance conflicting authoritative state (see f-assume-server-authority).
    type: must
  - description: >-
      The existing single-player experience must remain playable without an active network session —
      'multiplayer-capable' adds capability and does not replace it.
    type: must
  - description: >-
      The synchronization approach must not be declared final until measured input-to-observation latency and frame cost
      are recorded against the working budget (see f-assume-latency-budget; the measurement gap is tracked by
      f-csp-unmeasured).
    type: must
  - description: >-
      The shared simulation must not run at a second, conflicting timestep — prefer reusing the existing fixed-timestep
      tick (f-repo-tick) as the authoritative heartbeat rather than introducing a parallel simulation loop.
    type: prefer
  - description: >-
      Prefer not to couple rendering, inventory, persistence, or AI internals to transport details; keep netcode behind
      a session/replication seam so later systems can adopt it without rewrite.
    type: prefer_not
requirements:
  - >-
    A player can create a shared session and a second player can join it over a network from a separate client instance
    using a simple join mechanism (e.g. code/URL), with no manual state copying.
  - >-
    Both players' inputs are delivered to and applied by a single authoritative simulation; neither client independently
    produces conflicting authoritative state.
  - >-
    Each client renders the other player's state via replicated updates sufficient for real-time play, meeting the
    working latency budget in f-assume-latency-budget.
  - >-
    The authoritative simulation advances on the existing fixed timestep and is the single source of shared truth for
    the session.
  - >-
    A player disconnecting mid-session is handled gracefully: the remaining player is notified, no crash occurs, and the
    session reaches a defined state per f-assume-disconnect.
  - >-
    Measured input-to-observation latency and frame cost for the shipped synchronization approach are recorded against
    the working budget, closing the gap tracked by f-csp-unmeasured.
nonGoals:
  - Support for more than two concurrent players in one session (the stated goal is exactly two).
  - >-
    Deciding the cross-platform question — this Definition neither includes nor excludes cross-platform support; that
    decision is carried open as fact f-xplat-undecided.
  - Matchmaking, public session discovery, lobbies beyond a single shared session, or player accounts.
  - >-
    Persistent shared-session state and integration of multiplayer sessions with the existing save/load system
    (deferred, f-defer-persistence).
  - New gameplay content or feature changes beyond enabling the shared real-time session.
acceptance:
  - description: >-
      Two client instances on separate network hosts: player A creates a session, player B joins via the provided join
      mechanism, and both play together in the shared session.
    met: false
  - description: >-
      During a sustained shared session, each player observes the other's movement/actions within the working latency
      budget, and the authoritative simulation remains the single source of truth (no divergent final states between
      clients).
    met: false
  - description: >-
      A recorded measurement shows input-to-observation latency and frame cost for the shipped synchronization approach
      against the working budget, with a pass/fail result.
    met: false
  - description: >-
      Disconnecting one client mid-session leaves the other client in a defined, non-crashed state with a user-visible
      notification.
    met: false
  - description: With no active session, the game starts and plays single-player as it did before this increment.
    met: false
---

## Scope reading: what "multiplayer-capable" means here

The Objective authorizes one outcome: two people, two clients, one shared real-time session. Everything in this Definition is scoped to that. Capability is additive — the game keeps working offline as it does today.

The deep obstacle is not "add networking" but **the single-authority assumption baked into every existing system**. Today there is one local player, one local tick, one local truth. A shared session requires introducing, for the first time: a session identity, an authority that owns the simulation, input routing from two sources, and state replication back out. None of those concepts exist yet, so this increment is a **new session/authority/replication layer** in front of the existing simulation — not netcode threaded through each system individually.

## Synchronization approach and its measurement gate

Client-side prediction with server reconciliation is a *candidate*, not a commitment, and the Objective is explicit that nobody has measured whether it fits the latency/frame budget. I treat that honestly: the working latency budget is an explicit default (recorded as an assumption with rationale, not as fact), and the Definition requires the approach to earn its place by measurement before being declared final. If prediction-with-reconciliation measures poorly, the fallback ordering is: snapshot interpolation (simpler, more latency-tolerant, more visual lag), then hybrid. Lockstep P2P was not considered a live option because it contradicts the candidate approach the Objective names, and it is brittle for action play.

The authoritative topology default follows directly from the candidate approach: prediction-with-reconciliation *presupposes* server authority, so a client-server session authority is the working shape. This is a reversible engineering choice inside authorized intent, recorded as an assumption — not a product decision I am making on anyone's behalf.

## Architecture reality check — a discrepancy that shapes planning

Inspecting the repository surfaced something the architecture doc does not admit: `docs/architecture.md` lists five systems (render, input, persistence, inventory, AI) under `src/`, but `src/` contains **only** `src/physics/tick.ts`. The doc also claims there is no network/session/replication code anywhere — that part checks out. Practical consequences:

- The surface this increment actually touches is smaller than the doc implies: one fixed-timestep tick and whatever thin shell drives it.
- The tick has no serialization or snapshot hooks — retrofitting input routing and state snapshotting onto it is real work, and the "replication seam" constraint exists so that work lands in one place rather than scattered.
- Planning must not assume the other systems exist; if they appear mid-increment, the seam keeps them from forcing a netcode rewrite.

## Key risks

- **R1 — Unproven netcore premise.** The named candidate approach has zero measurements behind it (tracked as an open fact). Mitigation: the measurement acceptance criterion is a gate, not a nicety; budget default is stated so "real-time" cannot silently drift.
- **R2 — Cross-platform undecided.** This genuinely open product question can influence transport choice, input abstraction, and testing matrix. Per the Objective, it is carried as an open fact — *not* settled here by a constraint or non-goal — so a human decides it before it quietly constrains architecture.
- **R3 — Retrofit cost on the tick.** The existing tick is a synchronous, network-blind step; making it the authoritative heartbeat for two players means adding determinism, input sequencing, and snapshot serialization. Underestimated often; the single-seam constraint keeps the blast radius bounded.
- **R4 — Disconnect semantics are a default, not intent.** The graceful-degradation behavior is a safe engineering default, but if the product expects the session to hard-end (or to invite a rejoining player), that is a cheap correction — flagged rather than guessed at scale.

## Tradeoffs and rationale

- **Authoritative server vs. P2P:** chose the former (as an assumption) — it matches the candidate approach, simplifies anti-desync reasoning, and the two-player scale makes a lightweight authority cheap. Cost: a hosted/one-player-hosts authority exists at all.
- **Bounded scope vs. completeness:** persistence integration and matchmaking are explicitly excluded/deferred; each is separable and would otherwise inflate the critical path behind the unmeasured netcode risk.
- **Stated defaults over silent ones:** latency budget, disconnect behavior, and transport are all recorded assumptions with rationale — wrong-by-default is recoverable; wrong-by-silence is not.
