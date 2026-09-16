---
schemaVersion: 1
goal: >-
  Two players can join and sustain a shared real-time Evershift session together over a network, with one player's
  client acting as the authoritative host.
facts:
  - id: f-two-player-shared-session
    statement: Two players should be able to join and play a shared real-time Evershift session together.
    status: KNOWN
    source: human
    kind: product-intent
  - id: f-cross-platform-undecided
    statement: >-
      Whether cross-platform support (players on different platforms sharing one session) belongs in this increment is
      genuinely undecided product/architecture scope; only a recorded human decision settles its membership.
    status: UNKNOWN
    source: human
    kind: product-intent
  - id: f-prediction-approach-candidate
    statement: >-
      Client-side prediction with server reconciliation is a candidate synchronization approach for the shared session,
      not a committed one.
    status: KNOWN
    source: human
    kind: product-intent
  - id: f-prediction-feasibility
    statement: >-
      Whether client-side prediction with server reconciliation can actually meet the required latency/frame budget for
      real-time play has not been measured.
    status: UNKNOWN
    source: human
  - id: f-latency-budget-unspecified
    statement: >-
      The Objective left the concrete latency/frame budget for real-time play unspecified; a working default is adopted
      — guest input-to-photon latency at or under 100 ms (p95) and a stable 30 Hz simulation tick with no more than 5%
      of ticks exceeding their frame deadline over a sustained session — chosen as a reasonable networked action-game
      responsiveness default, revisitable once measured.
    status: ASSUMED
    source: investigation
    kind: product-intent
  - id: f-replicated-subset
    statement: >-
      The subset of game state requiring authoritative replication was unspecified; a working default is adopted —
      player avatar kinematic state, world-affecting player actions/events, and shared session and shape-state are
      replicated, while purely cosmetic, particle, and locally-derived visual state stays client-local.
    status: ASSUMED
    source: investigation
  - id: f-host-authority
    statement: >-
      The topology adopted for this scope is host-authoritative replication: the hosting player's client is the single
      authority for shared simulation state, requiring zero new server infrastructure; a reversible-later choice inside
      the authorized two-player outcome.
    status: ASSUMED
    source: investigation
  - id: f-determinism-unknown
    statement: >-
      Whether the Evershift simulation is bit-deterministic across clients is unverified and explicitly not required for
      this bounded scope: the host-authoritative replication model does not depend on determinism, and only the excluded
      lockstep approach would.
    status: DEFERRED
    source: investigation
    kind: repository-claim
  - id: f-repo-tree-discrepancy
    statement: >-
      A discrepancy exists between the repository's actual tree and the layout expected from earlier investigation; it
      is carried as a standing risk, verified at work time by whichever task first depends on the affected paths.
    status: KNOWN
    source: investigation
    kind: repository-claim
constraints:
  - description: >-
      The shared simulation runs under exactly one authority — the hosting player's client — with zero new dedicated
      server infrastructure.
    type: must
  - description: >-
      Client-side prediction with server reconciliation must not be locked in as the synchronization approach until the
      bounded latency measurement confirms it meets the adopted budget; if the budget proves unreachable, the approach
      is revisited rather than silently accepted.
    type: must
  - description: No lockstep peer-to-peer synchronization in this increment.
    type: must_not
  - description: No dedicated-server deployment, matchmaking, or always-on infrastructure in this increment.
    type: must_not
  - description: >-
      Keep transport, serialization, and platform-facing networking choices neutral so that adding cross-platform
      support later remains cheap regardless of how the undecided membership question resolves.
    type: prefer
  - description: >-
      Prefer reversible implementation choices in the networking layer, since the host-authority topology may be
      revisited in a later increment.
    type: prefer
requirements:
  - >-
    A player can host a session from their running game and a second player can join that same session from a separate
    machine over a network.
  - >-
    The hosting player's client is the single authority for shared simulation state; the joining player's client applies
    inputs locally and reconciles against authoritative state.
  - >-
    World-affecting state changes initiated by either player (movement, interactions, shape-state changes) become
    visible to the other player within the adopted latency budget.
  - >-
    The shared session sustains continuous two-player play: joins, movement, world interaction, and shape-shifting
    remain mutually consistent for both players.
  - >-
    Player disconnect is detected and handled without corrupting shared state: a guest leaving degrades or ends the
    session cleanly, and host departure ends it predictably.
nonGoals:
  - >-
    Dedicated-server deployment, matchmaking, or any new always-on infrastructure — host authority covers this
    increment.
  - >-
    Lockstep peer-to-peer synchronization, and with it any requirement for cross-client simulation determinism in this
    scope.
  - Support for more than two concurrent players in a single session.
  - >-
    Deciding cross-platform membership: it is neither included nor excluded here — that question is routed to a recorded
    human decision, not settled by this Definition.
acceptance:
  - description: Two players on separate machines over a real network join the same Evershift session and play it together.
    met: false
  - description: >-
      The shared session is sustained for at least five continuous minutes with both players observing consistent shared
      world state — no desync, no unrecoverable disconnect, and no host-overload failure.
    met: false
  - description: >-
      During that sustained session the guest player's input-to-photon latency satisfies the adopted budget (per the
      feasibility measurement), so 'real-time' is demonstrated rather than asserted.
    met: false
---

## Design shape

The increment stands on host-authoritative replication: the hosting player's client is the single authority for shared simulation state, the joining player's client applies inputs locally and reconciles against authoritative state. This is the cheapest topology that satisfies "two players share a session" with zero new infrastructure, and it deliberately avoids lockstep — which would drag a cross-client determinism requirement in behind it. Client-side prediction with server reconciliation is treated as a *candidate*, not a commitment: a measurement gate sits in front of approach lock, because the one thing this Definition cannot settle by reading or reasoning is whether that approach actually fits the latency budget.

## Defaults adopted this round, and why

**Latency budget.** "Real-time" needed numbers before it could be measured or accepted. The adopted working budget — guest input-to-photon at or under 100 ms (p95) with a stable 30 Hz simulation tick (no more than 5% of ticks exceeding their frame deadline) over a sustained session — is a conventional responsiveness ceiling for networked action games and a tick rate that balances smoothness against bandwidth. It is a stated default, not a measured or human-confirmed fact: it gives the feasibility spike a target and the acceptance criteria teeth, and it is cheap to revisit if the spike shows the budget is unreachable or trivially beatable.

**Replicated subset.** Only shared truth crosses the wire: player avatar kinematic state, world-affecting actions/events, and shared session and shape-state. Cosmetics, particles, and other locally-derived effects stay client-local. This minimizes bandwidth, keeps the spike honest (it exercises exactly the state where disagreement matters), and leaves nothing gameplay-visible ambiguous about who owns what.

**Host authority.** Chosen because it needs no server, no matchmaking, and no deployment story for a two-player session. It is reversible later — a dedicated-authority topology can replace it without changing the client contract much — which is why it is recorded as an adopted default rather than an escalated product decision.

## Deferred: determinism

Whether the simulation is bit-deterministic across clients is explicitly not required here. Only a lockstep model would depend on it, lockstep is excluded from this increment, and authoritative replication tolerates divergence by construction (the authority's state wins). The question stays open for the wider Objective but no longer shadows this scope.

## Named risks and tradeoffs

- **R4 — Platform neutrality as cheap optionality.** The undecided cross-platform question is not settled here, and nothing in this scope should make it expensive to answer either way. Keeping transport, serialization, and platform-facing choices neutral preserves a cheap path to "yes" and costs little if the answer is "no".
- **R5 — Repository tree discrepancy.** A discrepancy between the repository tree and what earlier investigation expected is carried as a standing risk. The mitigation is verify-before-dependence: whichever task first relies on the affected paths verifies them at work time rather than trusting the recorded layout.
- **R6 — Host-authority costs, accepted with rationale.** Host authority buys zero infrastructure at the price of host-side latency advantage (fairness), a host-hostage session (the host leaving ends it), and host machine load. These are recorded, accepted for this increment, and surfaced rather than hidden: the sustained-session acceptance criterion is what would expose host overload, and the topology is reversible later if the costs stop being acceptable.
- **Measurement gate vs. early commitment.** Locking prediction-with-reconciliation before measuring risks building on an approach that cannot meet the budget; the gate trades a bounded spike up front for the ability to revisit the approach with evidence instead of sunk cost.

## Open items — routed, not decided here

Two gaps are deliberately left open, each with its own next step. Cross-platform membership in this increment is a genuine product scope choice that only a recorded human decision settles — no constraint, non-goal, or "does not block" judgment is offered here in its place. Whether prediction-with-reconciliation can meet the budget is unmeasured feasibility; it closes only through bounded measurement work, and that work should measure input-to-photon latency and tick stability against the budget numbers adopted above, resolving to evidence — or forcing the approach constraint and its fallback to be revisited rather than silently accepted.
