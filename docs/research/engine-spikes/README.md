# Engine spike harnesses — Goose (ACP) and Pi (TS SDK)

Provenance: [`docs/ideas/collaborative-agent-workspace-platform-proposal.md`](../../ideas/collaborative-agent-workspace-platform-proposal.md) §6.6 (Revision 2, DISCUSSION status).
Evidence-gathering only — these harnesses authorize nothing and contain no Stratum runtime code.

## Safety rules (binding)

1. **Isolation.** Spikes run only in an isolated scratch directory under the system temp path, `git init`-ed so stray commits land there, never in an active development repository.
2. **Secrets.** Harnesses read no configuration files and print no environment. Transcript lines are passed through a redaction pass (`sk-…` keys, `Bearer …` tokens) before being written. Provider credentials live in the engine's own config (`~/.config/goose`); the harness never copies or commits them.
3. **Cost & time limits (set before any model call).** Tasks are deliberately tiny (file creation, counting, quoting). Per-request timeout `SPIKE_TIMEOUT_MS` (default 240 s); any timeout fails the phase and the sequence stops. Expected spend per full run: ≤ 6 short model turns on the engine's configured provider. If usage events are observable in the stream they are recorded; no other budget mechanism is assumed.
4. **Phased, gated execution.** Non-destructive paths must pass before destructive ones:
   `basic` → `restart` → `cancel` → `sigkill`. Each phase is a separate process invocation (so restarts are genuinely cold).
5. **Findings, not workarounds.** An unsupported capability (e.g. no `session/list`, no detached reconnection over stdio) is recorded as a finding. The harness never works around a failed gate.
6. **Classification.** Every gate result is labeled **protocol** (proves the wire works) or **runtime** (proves the engine's lifecycle behavior survives the harness's abuse).

## Tested versions and configuration assumptions

| Component | Version | Status |
| --- | --- | --- |
| Goose CLI | 1.54.0 (`goose acp`, stdio; round 2 spawned with `GOOSE_MODE=approve`) | round 1 + round 2 exercised 2026-10-20 — see findings file |
| Pi (`@earendil-works/pi-coding-agent`) | global install exercised; SDK binding via `PI_PKG` env | **blocked: no provider credentials on machine** (`pi /login` needed) |
| Node | v20.19.2 (Goose harness; zero deps) / v22.23.2 (Pi SDK, needs ≥ 22.19) | |

Assumptions: the engine's provider is pre-configured and authenticated by the user (`goose` config under `~/.config/goose`); ACP mode is `goose acp` (override with `GOOSE_BIN` / `GOOSE_ACP_ARGS`); Pi sessions persist under a spike-owned sessions dir.

## Acceptance criteria

| Gate | Phase | Assertion | Kind |
| --- | --- | --- | --- |
| G1 handshake | basic | `initialize` (+`authenticate` if required) and `session/new` succeed; capabilities recorded | protocol |
| G2 task | basic | `spike.txt` contains exactly `SPIKE_OK_2026_10_19` + `<ENGINE>_RESUME`; codeword absent from workspace files; event stream recorded (update-type inventory) | runtime |
| G3 permission | basic | `session/request_permission` round-trips under the restrictive profile and is granted **only** as `allow_once` (refuse via `reject_once` if unavailable — never fall back to another option); every selection recorded | runtime |
| G4 cancel | cancel | cancel fires only after **observed activity** (any streamed output or tool call) **and** an existing side effect; requires terminal `cancelled` outcome and side effects **frozen at cancel-time value** in a post-cancel window (1..499 lines) | runtime |
| G5 cold restart + resume | restart | clean process exit → fresh process → `initialize` + `session/load` → conversation replayed (events counted **before** any new prompt); conversation-only codeword recalled **and verified absent from the workspace by scan**; file mtime unchanged; no duplicated turns | runtime |
| G6 crash resilience | sigkill | `SIGKILL` fires only with the session/prompt request **structurally pending** and an in-flight side effect; fresh process (new PID) → `session/load` → coherent partial state, side effects stable across the reload window, no fabricated completion (phrasing check informational); work-completed-before-kill is recorded as **INCONCLUSIVE**, not a pass | runtime |

Provenance note: the conversation-only codeword lives in operator-side harness state and the protocol transcript (outside the test workspace); the asserted claim is its **absence from the test workspace**, verified by scan — never "absent from disk" in the absolute.

**Primary gate: G5.** A failed or unsupported cold restart is a documented finding that re-opens the engine-binding direction — not something to engineer around.

## Run

```bash
cd docs/research/engine-spikes/harness
export SPIKE_OUT=/tmp/stratum-spike-out          # output + scratch workspace (outside any repo)

node spike-a-goose-acp.mjs basic
node spike-a-goose-acp.mjs restart               # requires basic PASS
node spike-a-goose-acp.mjs cancel                # requires restart PASS
node spike-a-goose-acp.mjs sigkill               # requires cancel PASS

# Pi (separate engine, native SDK binding; needs node >= 22.19)
~/.nvm/versions/node/v22.23.2/bin/node spike-b-pi-sdk.mjs stage1
~/.nvm/versions/node/v22.23.2/bin/node spike-b-pi-sdk.mjs stage2
~/.nvm/versions/node/v22.23.2/bin/node spike-b-pi-sdk.mjs stage3
```

Transcripts: `$SPIKE_OUT/goose-acp.jsonl` (one JSON object per protocol event, redacted) plus a per-phase gate summary on stdout. Distilled findings go in dated `*-findings.md` files next to this README.
