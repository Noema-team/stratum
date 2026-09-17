---
schemaVersion: 1
goal: >-
  Two players can join and play a shared real-time Evershift session together — a working networked multiplayer session
  between exactly two clients with synchronized game state.
facts:
  - id: F1
    statement: Two players should be able to share a real-time Evershift session together (Objective intent).
    status: KNOWN
    source: human
    kind: product-intent
  - id: F2
    statement: >-
      Whether cross-platform support belongs in this increment is genuinely undecided — an open product/architecture
      question, not yet a constraint.
    status: UNKNOWN
    source: human
    kind: product-intent
  - id: F3
    statement: >-
      Client-side prediction with server reconciliation is a candidate synchronization approach; whether it can meet the
      required latency/frame budget for real-time play has not been measured.
    status: UNKNOWN
    source: human
    kind: product-intent
  - id: F4
    statement: >-
      Evershift is currently single-player only: there is no network transport, session management, or multiplayer
      synchronization code anywhere in the repository.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md
  - id: F5
    statement: >-
      Every existing system (rendering, input, physics, persistence, inventory, AI) assumes a single local player and a
      single local simulation tick; there is no concept of a remote peer, server authority, or state replication.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md
  - id: F6
    statement: The simulation advances via a fixed-timestep local tick function with no network awareness.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: F7
    statement: >-
      The required latency/frame budget for real-time play (acceptable input-to-display latency and tick rate) is not
      yet defined; a reasonable working budget is needed to evaluate any synchronization approach.
    status: ASSUMED
    source: investigation
  - id: F8
    statement: >-
      The simulation is driven from a single fixed-timestep step function, which is a plausible single integration point
      for introducing server-authoritative or replicated ticking.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: F9
    statement: >-
      Session topology: Evershift's two-player multiplayer is built on a dedicated authoritative server — a small
      always-on server process runs the authoritative fixed-timestep simulation, and both players connect as remote
      clients with no authority on either player's machine.
    status: DECIDED
    source: decision
    decisionRef: 6f83236f-dddc-4036-99af-32efd981ff5e
  - id: F10
    statement: >-
      Session discovery/join flow (matchmaking, invite links, LAN discovery) is not specified by the Objective; a
      minimal direct-join flow is assumed sufficient for this increment.
    status: ASSUMED
    source: human
    kind: product-intent
constraints:
  - description: >-
      The existing single-player experience and all current systems (rendering, input, physics, persistence, inventory,
      AI) must continue to work unchanged when multiplayer is not in use.
    type: must
  - description: >-
      Multiplayer support must not require a rewrite of every game system in this increment; it may be introduced behind
      a session/transport layer that existing systems consume.
    type: prefer
  - description: >-
      Cross-platform support must NOT be assumed in this increment — it is a genuinely undecided product/architecture
      question and must not be silently settled as a constraint or non-goal.
    type: must_not
  - description: >-
      Client-side prediction with server reconciliation must NOT be committed to as the synchronization approach until
      the latency/frame-budget feasibility question is resolved.
    type: must_not
  - description: Prefer deterministic shared simulation state between the two clients so divergence is detectable and correctable.
    type: prefer
requirements:
  - Two distinct clients can establish a shared Evershift session, each controlling their own player.
  - >-
    Game state relevant to both players (positions, physics results, interactions) is synchronized between the two
    clients during play.
  - Both players observe the shared session in real time, within the latency/frame budget agreed for this increment.
  - A session can be started, joined, and ended without corrupting or degrading the existing single-player game.
  - >-
    Divergence between the two clients' views of shared state is detected and corrected (or prevented) by the chosen
    synchronization mechanism.
  - The synchronization approach adopted must be justified against the measured latency/frame budget, not assumed.
nonGoals:
  - Matchmaking, lobbies, or player discovery beyond a minimal direct join flow
  - Spectator mode or more than two simultaneous players
  - Persistence of multiplayer session state or multiplayer save/load semantics
  - Anti-cheat, security hardening, or hostile-client defenses
  - Cross-platform support — explicitly undecided (F2), neither promised nor excluded
acceptance:
  - description: Two clients can join the same session and both see each other's player in real time.
    met: false
  - description: >-
      Shared game state (player positions and physics-relevant outcomes) remains synchronized during play within the
      agreed latency/frame budget.
    met: false
  - description: The synchronization approach has been measured against the required latency/frame budget and meets it.
    met: false
  - description: The existing single-player game still runs correctly with multiplayer code unused.
    met: false
  - description: A session can be started and ended cleanly by either player without leaving the other client in a broken state.
    met: false
---

## Decision: Dedicated authoritative server (F9)

The session-topology question is resolved: Evershift's two-player multiplayer is built on a **dedicated authoritative server**. A small always-on server process runs the authoritative fixed-timestep simulation; both players connect as remote clients. Neither player's machine holds authority.

### What this settles

- **Trust model.** Authority lives outside both clients. Client-side prediction with server reconciliation (the candidate synchronization approach, F4) is now the natural — and expected — synchronization design: clients predict locally, the server's tick is the reconciling authority.
- **Symmetric latency and platform neutrality.** Both players experience the same client role, so the topology decouples the cross-platform question (F2) from the server role: no supported player platform doubles as a server platform. F2 remains open on its own merits.
- **Infrastructure commitment.** The increment now includes deploying, running, and operating a small server. This is accepted as part of the bounded scope; it is not a hidden cost. Transport, hosting environment, and deployment specifics remain implementation work, not further product decisions, unless a constraint emerges that materially changes cost or scope.

### What this leaves open

- **F2 (cross-platform membership in this increment)** — still a HUMAN_DECISION gap. The dedicated-server choice makes inclusion cheaper (no host-platform constraint), but membership in the increment is still the human's call.
- **F4 (feasibility of prediction/reconciliation under the latency/frame budget)** — still EXPLORE_AS_WORK. The topology is now concrete enough to run the measurement against: a minimal dedicated-server loop with prediction and reconciliation, measured against an explicit latency/tick budget. Its answer can still falsify the real-time-playability requirement.
- Hosting, session discovery (join flow mechanics), and server lifecycle details remain design work downstream of this decision.

### Implications carried forward

Requirements should be re-derived around server authority: the server owns the authoritative tick, clients send inputs and render reconciled state, and single-player behavior remains untouched behind the session/transport layer. The existing must-constraint protecting single-player behavior is unaffected. No non-goal changes — matchmaking, spectators, persistence, and security remain excluded; "no server infrastructure" was never a recorded non-goal, so excluding the dedicated server is not contradicted by this resolution.
