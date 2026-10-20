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
