---
schemaVersion: 1
goal: >-
  Two players can join one shared, real-time Evershift session over a network and play it together on a single
  authoritative simulation, with responsiveness and state consistency held to a measurable real-time budget.
facts:
  - id: F1
    statement: Two players must be able to join and play one shared, real-time Evershift session together.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F2
    statement: >-
      Whether cross-platform support belongs in this increment is genuinely undecided; it is an open
      product/architecture question and no constraint is adopted in either direction.
    status: UNKNOWN
    source: human
    kind: product-intent
  - id: F3
    statement: >-
      Client-side prediction with server reconciliation is the candidate synchronization approach under consideration
      for the shared session.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F4
    statement: >-
      Whether client-side prediction with server reconciliation can meet the latency/frame budget required for real-time
      two-player play is unmeasured; no answer exists yet.
    status: UNKNOWN
    source: human
    kind: repository-claim
  - id: F5
    statement: Evershift is currently a single-player action game.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: README.md
  - id: F6
    statement: >-
      The repository contains no network transport, session management, or multiplayer synchronization code; src/
      contains only src/physics/tick.ts.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md; src/ directory listing
  - id: F7
    statement: >-
      The only simulation code present, src/physics/tick.ts, is a fixed-timestep local step with no network or authority
      awareness.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: src/physics/tick.ts
  - id: F8
    statement: >-
      The repository contains no tests or benchmarks at all, including none that measure latency or synchronization
      behavior.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: repository tree listing (root, docs/, src/, .sle/)
  - id: F9
    statement: >-
      docs/architecture.md describes rendering, input, physics, persistence, inventory, and AI systems, but only physics
      exists in the repository; the documented architecture is partly aspirational.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: docs/architecture.md; src/ directory listing
  - id: F10
    statement: >-
      Working latency/frame budget adopted as an engineer default (industry-standard for real-time action games), not
      human-ratified: fixed-timestep simulation at ~60 Hz; each player's own input visible locally within ~1 frame under
      normal conditions; end-to-end interaction latency ≤ ~100 ms with reconciliation settling divergence within a few
      ticks under ≤ 50 ms round-trip conditions.
    status: ASSUMED
    source: investigation
    kind: product-intent
  - id: F11
    statement: >-
      Working topology assumption: one of the two players' processes acts as the authoritative simulation
      (host-authoritative session); no dedicated server infrastructure is required for this increment. Chosen as the
      reversible default consistent with a two-player increment; not human-ratified.
    status: ASSUMED
    source: investigation
  - id: F12
    statement: >-
      Working default for peer disconnect: the shared session ends cleanly with a notice to the remaining player;
      automatic mid-session reconnection with full state restore is excluded. Rationale: cheapest graceful behavior that
      avoids hangs and corrupted state.
    status: ASSUMED
    source: investigation
  - id: F13
    statement: >-
      Support for more than two concurrent players per session is acknowledged later-phase work outside this increment's
      bounded scope.
    status: DEFERRED
    source: human
    kind: product-intent
  - id: F14
    statement: >-
      Matchmaking, lobby browsing, friends/presence services, and invite infrastructure beyond a minimal join mechanism
      are acknowledged later-phase work outside this increment's bounded scope.
    status: DEFERRED
    source: human
    kind: product-intent
constraints:
  - description: >-
      The shared session must be playable from two separate client instances over a network (no shared-process or
      same-screen simulation).
    type: must
  - description: >-
      Exactly one authoritative simulation must resolve inputs; both clients must converge to identical authoritative
      world state after reconciliation settles — persistent divergence (desync) is not acceptable.
    type: must
  - description: >-
      Each player's own input must be visible locally within the working budget (F10) under representative network
      conditions.
    type: must
  - description: >-
      Unresolvable divergence must surface explicitly (error or notice to both players); the system must never present
      divergent world states as consistent.
    type: must_not
  - description: Existing single-player local play behavior must not regress as a result of this increment.
    type: must
  - description: >-
      Prefer client-side prediction with server reconciliation (F3) as the synchronization mechanism, contingent on the
      measurement requirement confirming the working budget (F10); prefer retaining the existing fixed-timestep
      simulation model rather than replacing it.
    type: prefer
  - description: Prefer not to require dedicated server infrastructure for this increment (host-authoritative default, F11).
    type: prefer_not
requirements:
  - >-
    A player can create a shared session and a second player can join it from a separate client instance over a network
    via a minimal join mechanism (e.g., session code or direct address).
  - >-
    Initial join delivers a consistent starting world state to both clients, and both players observe the same shared
    world evolving in real time.
  - >-
    Each player's inputs act on the shared world with local responsiveness per the working budget (F10): own input is
    reflected immediately under the candidate prediction scheme, and both clients converge to identical authoritative
    state after simultaneous or conflicting inputs.
  - >-
    Exactly one authoritative simulation (per the working topology assumption, F11) deterministically resolves
    simultaneous inputs.
  - >-
    If either peer disconnects mid-session, the session ends cleanly with a notice to the remaining player — no hang,
    crash, or corrupted state (default per F12).
  - >-
    The candidate synchronization approach's end-to-end interaction latency and reconciliation settle time are measured
    under representative network conditions (e.g., simulated ~50 ms RTT) and recorded against the working budget (F10),
    closing the measurement gap (F4) before the approach is ratified as final.
  - Existing single-player local play continues to function unchanged.
nonGoals:
  - Supporting more than two concurrent players in one session (F13).
  - >-
    Matchmaking, lobby browsing, friends/presence services, or rich invite infrastructure beyond a minimal join
    mechanism (F14).
  - Automatic mid-session reconnection with full state restore (a clean session end is in scope; restore is not).
  - Competitive-grade anti-cheat or security hardening of the network protocol.
  - Generalizing the netcode into a reusable networking library or engine-level feature.
  - Persisting multiplayer sessions or shared-session progression across restarts.
acceptance:
  - description: >-
      Two separate client instances (different processes/machines): one creates a session, the second joins, and both
      present the same shared starting world state.
    met: false
  - description: >-
      During continuous simultaneous play, each player's own input is visible locally within the working budget (F10),
      and after simultaneous/conflicting inputs both clients hold identical authoritative state within a bounded number
      of ticks.
    met: false
  - description: >-
      A sustained session (≥ 5 minutes of continuous two-player interaction under simulated ~50 ms RTT) completes with
      no desync, hang, or crash; a mid-session disconnect of either peer ends the session cleanly with a notice.
    met: false
  - description: >-
      A recorded measurement of end-to-end interaction latency and reconciliation settle time under representative
      conditions exists and is compared against the working budget (F10); the candidate approach is either confirmed
      within budget or the shortfall is escalated as a Decision before the approach is ratified.
    met: false
  - description: Single-player local play still functions as before the increment.
    met: false
---

## Design thinking

**Where we actually are.** This is greenfield netcode, not a retrofit. Verified directly: the repository ships one simulation file (`src/physics/tick.ts`, a network-unaware fixed-timestep step) and nothing else under `src/`; the six systems the architecture doc describes exist only on paper. That cuts both ways. The integration surface is tiny, so the authority model and session boundaries can be designed *before* gameplay systems accrete around them — the cheapest moment to make a game multiplayer-capable. But the docs are aspirational, so any plan that leans on `src/render/` or `src/ai/` existing is leaning on fiction; verify against code as work proceeds, not against the doc.

**The core design bet.** The human named client-side prediction with server reconciliation as the candidate approach, and it is the right leading candidate for an action game: it masks input latency for the local player, which is the thing "real-time" actually means here. But its feasibility against the frame/latency budget is an open measurement question (F4), not a settled property of the technique. So the increment treats it as a *candidate to be validated*, not a *decision to be implemented*: the measurement harness is first-class work, and the constraint expresses preference rather than commitment. If the measurement comes back short, fallback families exist (simple lockstep, snapshot interpolation) without reopening product scope — swapping the sync mechanism is an internal redesign, not a change to what the human authorized.

**Topology default.** Host-authoritative (one player's process acts as the server) is adopted as the working default because it delivers a two-player shared session with zero new infrastructure. It is recorded as an assumption, not a constraint: if the review or the human wants dedicated-server semantics (different trust model, different lifecycle), that is a genuine product call and the assumption should be escalated rather than hardened.

**Why a concrete budget at all.** "Real-time" is untestable as written. The adopted working budget (60 Hz fixed timestep, ~1 frame local input visibility, ≤ ~100 ms end-to-end under ≤ 50 ms RTT) is an industry-standard default chosen so acceptance is measurable — it is a bar to test against, not a ratified SLA. If the human has a sharper expectation, correcting the number costs nothing structurally.

**Disconnect handling** takes the safe default (clean end with a notice, no auto-reconnect-with-restore): robustness for a degenerate condition, cheap to change later, and it keeps reconnection machinery out of a first increment.

## Named risks

- **Unvalidated feasibility (F4)** — the highest-probability failure of this increment is building prediction/reconciliation and *then* discovering the budget doesn't hold. *Mitigation:* the measurement requirement is a gate on ratifying the approach, sequenced early; a shortfall routes to a Decision rather than a silent scope reduction.
- **The cross-platform question stays open (F2).** This Definition deliberately adopts no constraint, non-goal, or requirement in either direction — settling it here would be guessing at product scope. The only engineering posture taken is that transport/session code should be written as an ordinary module boundary, which is good hygiene regardless of the eventual answer. Review should classify this fact; it is a human call.
- **Docs-vs-reality drift (F9)** — plans anchored to the documented architecture may not compile against the actual tree. *Mitigation:* scope work against observed code; treat the architecture doc as intent, not inventory.
- **Scope creep into platform features** — matchmaking, lobbies, N players are fenced off as later-phase work precisely because they attach naturally to "multiplayer" and would swallow the increment.
- **Single-player regression** — threading authority through the existing tick is exactly the kind of change that quietly breaks the solo path; it carries its own acceptance check rather than good intentions.

## Tradeoffs

- *Prediction+reconciliation complexity vs. input latency:* the technique buys local responsiveness at the cost of reconciliation machinery and divergence handling. The constraint that divergence must surface explicitly (never present divergent worlds as consistent) is the honesty clause that makes the complexity safe.
- *Fixed timestep retained vs. replaced:* keeping the existing tick model preserves the one real asset in the tree and keeps the netcode additive; the cost is that the network layer must adapt to the tick, not the reverse.
- *Bounded two-player design vs. premature generality:* data structures are not required to generalize to arbitrary N now — deferring that generality is cheaper than carrying speculative abstraction through an unvalidated approach.
