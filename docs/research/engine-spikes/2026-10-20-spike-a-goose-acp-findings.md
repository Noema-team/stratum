# Spike A findings — Goose over ACP (2026-10-20)

Provenance: proposal PR #54 §6.6 (Revision 2, DISCUSSION). Harness: [`harness/spike-a-goose-acp.mjs`](harness/spike-a-goose-acp.mjs), protocol per [`README.md`](README.md).
**Status: complete. All gates exercised. Spike B (Pi) intentionally not run.**

## Environment and isolation

| Item | Value |
| --- | --- |
| Goose | 1.54.0, ACP mode (`goose acp`, stdio), provider pre-configured by user under `~/.config/goose` |
| Harness runtime | Node v20.19.2, zero dependencies |
| Workspace | `/tmp/stratum-spike-out/goose-work` — isolated, `git init`-ed scratch repo; no active development repo touched |
| Cost/time limits | Bounded tasks only (file create, count-to-500, quoting); per-request timeout 240 s (never hit); ~6 short model turns total |
| Secrets | Harness reads no config/env; transcript passed through redaction (0 substitutions needed); 527 protocol events recorded in `/tmp/stratum-spike-out/goose-acp.jsonl` |

## Results

| Gate | Phase | Result | Kind | Evidence |
| --- | --- | --- | --- | --- |
| G1 handshake | basic | **PASS** | protocol | `protocolVersion=1`, `agentCapabilities.loadSession=true`, `sessionId=20261020_1` |
| G2 task | basic | **PASS** | runtime | `spike.txt` exact contents; engine created file via its own tools |
| G3 permission | basic | **N/A — unexercised (see L1)** | — | No `session/request_permission` ever emitted; goose runs pre-authorized (`permission.yaml` present) |
| G4 cancel | cancel | **PASS** | runtime | `stopReason=cancelled`; `count.txt` never created — work actually stopped |
| G5 cold restart + resume | restart | **PASS** (primary gate) | runtime | Clean client exit → fresh process → `initialize` + `session/load` → replay + correct answer quoting both markers; `spike.txt` mtime unchanged; no duplicated turns |
| G6 SIGKILL resilience | sigkill | **PASS** | runtime | Engine killed mid-turn → fresh process → `session/load` succeeded; no fabricated completion; agent correctly reported the interrupted state |

Streamed update-type inventory (observed over ACP): `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `user_message_chunk`, **`usage_update`**, `available_commands_update`, `session_info_update`.

## Findings

1. **L1 — Permission mediation is unproven.** Goose never emitted `session/request_permission` because this install is pre-authorized. The G3 mechanism (host-brokered approvals over ACP) remains untested and must be re-run against a restricted permission profile before any claim that Stratum can mediate engine permissions over ACP. This is the most important open item.
2. **L2 — stdio couples engine lifetime to the client.** Killing the client kills the engine; "detached reconnection" is not exercisable over this binding. For Stratum this is **acceptable by design**: the Stratum host runtime is the engine's parent and owner of its lifecycle; browser disconnects are handled at the Stratum layer, not ACP. A server-mode binding would only matter if an engine had to outlive the host runtime (out of scope for the single-host slice).
3. **L3 — `session/list` is supported** (not guaranteed by all ACP implementations). Lost-reply reconciliation ("did my create/prompt land?") can therefore be resolved by enumeration, though host-side intent records remain necessary per §5.
4. **L4 — Token usage is streamable.** `usage_update` events arrive per turn, so cost accounting can live in the Stratum host log without engine-side instrumentation.
5. **L5 — Transcript of record is the engine's.** After `session/load`, the engine replays a compact projection (2 events) and re-derives context from its own persisted store — it even re-read `spike.txt` via tools to answer the resume question. Confirms §5's rule: the host runtime must append its own durable event log; the engine store is a recovery source, not the platform record.
6. **L6 — Cancellation is early and clean.** `stopReason=cancelled` with zero side effects (file never written). Runtime behavior, not just protocol echo.
7. **L7 — Crash behavior is honest.** After SIGKILL mid-planning, resume produced a coherent session with no fabricated completion; the agent described the interruption truthfully.

## Protocol vs runtime classification

G1 demonstrates ACP protocol behavior. G2, G4, G5, G6 demonstrate **engine runtime behavior** (real tool effects, real cancellation, real process death and re-derivation from persisted state). G3 was not exercised.

## Implications for Stratum

- **The §6.6 gate holds:** reconnect recovery with zero duplicate turns works over the Goose/ACP binding. Nothing observed breaks the engine-neutral `EngineConnector` shape sketched in §6.1 — the observed surface (initialize/new/prompt/stream/cancel/load/list + usage) maps onto it directly.
- **Goose remains a suitable foundation candidate** for the Stratum-owned host runtime: honest lifecycle behavior under cancellation and SIGKILL is exactly the property §6.7's recovery rules need.
- **Before Phase 1 can rely on tool brokering**, a follow-up G3 run with a restricted permission profile is required (L1). If Goose cannot emit `request_permission` under restriction, the tool broker must wrap tools at the engine-configuration level instead — a design input, not a blocker.
- **Host-owned session log is mandatory** (L5); engine store handles resume but cannot serve as Stratum's evidence/projection record.
- **Idempotency stays host-side** (§5): ACP provides none; `session/list` + intent records are the reconciliation path.

## Next steps (not started, per scope)

1. G3 rerun with restricted goose permissions (permission profile experiment).
2. Spike B — Pi via native SDK, same gates.
3. Ratification DDR for the pivot; only then Phase 1 scoping.

## Review addendum (2026-10-20) — evidence-strength limitations

External review correctly identified that several pass conditions were weaker than the gates they claim to demonstrate. Recorded here so Round 1 is preserved honestly, with Round 2 below tightening each one:

- **R1 — G5 under-determined:** the resume question asked Goose to quote `spike.txt`; the transcript confirms it re-read the file with tools. G5 Round 1 proves session reattachment, **not** conversation restoration from persisted state. A conversation-only nonce is required.
- **R2 — G4 under-determined:** `count.txt` was absent, which satisfies "<500" even if work never started. Cancellation needs evidence an operation was active before the cancel, and a partially-written file as the success signature.
- **R3 — G6 under-determined:** SIGKILL fired after a fixed 5 s wait with no verification that generation/tool execution was active; post-reload side-effect stability was not asserted.
- **R4 — G3 unexercised:** no permission request was ever emitted (pre-authorized profile). Mediation remains unproven.
- **R5 — budget/isolation honesty:** per-request timeouts are not a token budget; the git-init scratch dir is not a filesystem/process sandbox. Both are documentation-level mitigations only at spike maturity.

Round 1 results stand as a **feasibility experiment** (protocol wiring, reattachment, honest crash behavior), not runtime qualification.

## Round 2 (2026-10-20) — strengthened evidence

Harness rewritten to address R1–R4: conversation-only nonce for G5 (codeword spoken once, never written to disk — asserted), activity + side-effect gating before G4 cancel and G6 SIGKILL, restrictive permission profile (`GOOSE_MODE=approve` in the spawn env) for G3, prompt-count budget (`SPIKE_MAX_PROMPTS`, default 12) on top of timeouts, PID-change assertion and post-reload file-stability + fabricated-completion checks for G6, and `allow_always` never auto-selected by the harness. Fresh session, fresh scratch repo (`/tmp/stratum-spike-v2`); round 1 transcript retained at `/tmp/stratum-spike-out`.

| Gate | Round 2 result | Evidence |
| --- | --- | --- |
| G1 | **PASS** (protocol) | `sessionId=20261020_2` |
| G2 | **PASS** (runtime) | exact file contents; **nonce confirmed absent from disk** |
| G3 | **PASS** (runtime) | 1 `session/request_permission` round-trip emitted under `GOOSE_MODE=approve` and mediated via `allow_once` — **resolves R4/L1: permission interception over ACP works** |
| G4 | **PASS** (runtime) | activity observed (3 tool calls) AND `count.txt` at 1 line before cancel; `stopReason=cancelled`; file froze at 1 (require 1..499) — **resolves R2: cancellation demonstrably stopped in-flight work** |
| G5 | **PASS** (runtime) | 11 events replayed on `session/load`; codeword recalled from conversation; file untouched — proves conversation restoration, not file rereading. *(Provenance correction from review: the codeword was present in operator-side harness state (`goose-session.json`) and the protocol transcript; the precise claim is **absent from the test workspace** — see Round 3, where this became an asserted scan.)* |
| G6 | **PASS** (runtime) | PID 742690→743579; killed mid-write (1 line); reload OK; file stable across reload window (no zombie writes); agent reported the interruption honestly, no fabricated completion — **resolves R3** |

Additional observations:

- The restrictive profile is settable by the *host* at process-spawn time via environment (`GOOSE_MODE=approve`). For Stratum this is the natural hook: the tool broker launches engines pre-restricted instead of trusting their defaults.
- Cost telemetry: every turn emitted `usage_update`; combined with the prompt-count budget, spend is now observable post-hoc and bounded structurally. A true token-denominated budget would still require host-side enforcement (documented limitation, R5).
- OS sandboxing remains out of scope for the spike (R5); the git-init scratch dir isolates *commits*, not filesystem/process access.

## Spike B status (2026-10-20)

Harness rewritten to equivalent Round 2 conditions (nonce restoration, activity-gated abort, 1..499 side-effect assertion, message-count check before any resume prompt, `allow_always` n/a by design). **Run blocked: Pi has no provider credentials on this machine** (no stored login; no API-key environment variables). Establishing credentials is a user action (`pi /login` or an env key); per the findings policy this is recorded rather than worked around. Round 2 conclusion for Goose therefore stands **without** the Pi comparison; engine-choice ratification should wait for it.

## Qualification status after Round 2

Goose 1.54.0 over ACP has now passed a **runtime qualification experiment** for: protocol wiring, permission mediation, conversation restoration, effective cancellation, and crash-resilient resume — the load-bearing behaviors for §6.7's recovery rules. Still unproven and out of spike scope: multi-session concurrency, long-session transcript growth, multi-host transport, sandbox integration, and the Pi comparison (blocked on credentials).

## Round 3 (2026-10-20) — final correctness pass (strict assertions)

Third review pass tightened the harness predicates themselves; full sequence re-run fresh (`/tmp/stratum-spike-v3`). Assertion changes: G3 grants **only** `allow_once` (refuses via `reject_once`, else fails — no fallback to the first option), with every selection recorded; G4 requires `activityObserved`, terminal `stopReason=cancelled`, and side effects **frozen at their cancel-time value** across a post-cancel window; G5 adds a workspace-wide codeword scan (structural proof no tool-based recovery path exists); G6 requires the session/prompt request to be **structurally pending at kill** and distinguishes an invalid test (atomic execution) from a resume failure; the model-phrasing check is downgraded to informational.

Round 3 run: G1 PASS · G2 PASS · G3 PASS (1 mediated selection, `allow_once` asserted) · G5 PASS (11 replayed events, codeword absent from workspace by scan, recalled from conversation) · G4 PASS (active, `cancelled`, frozen at 1 line).

Two notable events during the pass — both harness/test-design lessons, not engine defects, but directly relevant to host-runtime design:

1. **G4 gate initially refused (correct behavior):** the engine streamed 1,626 `agent_thought_chunk` events while the gate waited for tool calls or message chunks. Streaming thought output *is* in-flight activity; the activity predicate was too narrow and was fixed. Lesson for Stratum: "is a turn active?" must be derived from *any* streamed engine output, not a whitelist of event types.
2. **G6 first run INCONCLUSIVE:** with the original task text, Goose batched "append 2..500 one at a time" into a **single atomic `seq` command** — `promptPendingAtKill=true` but `count.txt` already had 500 lines when killed. No mid-operation window existed; the run was recorded as inconclusive (invalid test, not a resume failure) and the task was redesigned with explicit per-append, no-shortcuts instructions. Lesson for Stratum: engines collapse naive "incremental" work into atomic operations, so crash-recovery design **cannot assume long partial states exist** — idempotency and outcome-unknown handling must not depend on partial-progress observation.

G6 then passed under the full strict predicate: prompt structurally pending at SIGKILL, PID 1030728→1032165, `count.txt` frozen at 1 line across the reload window, honest non-completion report.

**Provenance (all rounds):** the codeword exists in operator-side harness state and the protocol transcript on the operator's machine; the asserted and scanned claim is its **absence from the test workspace** — never "absent from disk" in the absolute. Per the review's recommendation, the experiment is now frozen: no further refinement unless a genuine runtime defect surfaces.
