# OpenRouter streaming transport — behavioral distinctions

Transport-hardening PR context: pilot-a attempts 20/21 lost long non-streaming
completion requests to mid-flight connection termination (8.8 and 13.1 minutes
into generation; cause unattributed — see pilot evidence
`transport-investigation/`). The multi-turn wire (`completeMultiTurn` on
`OpenAICompatibleMultiTurnProvider`, used by the `openrouter` provider kind)
now streams (`stream: true`, SSE). This document pins the behavioral
distinctions between the four transport regimes. Scope is the provider
transport boundary only — `MultiTurnResult` semantics and everything above
them are unchanged.

## 1. Non-streaming legacy transport (all other wires)

One HTTP request; zero response bytes until the entire generation completes.
The connection is byte-idle for the full generation time, exposed to
idle-flow termination anywhere on the client→provider→upstream path. Success
requires the full JSON body; failure at any point (connect, mid-body,
malformed JSON) throws — no partial result exists.

## 2. Streaming OpenRouter transport (the new multi-turn regime)

Response bytes flow continuously during generation (SSE deltas; measured
largest inter-chunk gap 0.28 s on the pilot route — the flow is never
byte-idle mid-generation). The SSE accumulator assembles text deltas,
tool-call deltas (identity + fragmented arguments, keyed by `index`),
`finish_reason`, and trailing usage chunks. Success requires a
`finish_reason`; `data: [DONE]` is accepted but not required.

**Comparability boundary:** this regime change is NOT transport-neutral.
An experiment that switches wires between regimes 1 and 2 changes the
transport's exposure to path-level connection termination and must be
preregistered as a regime change, never silently substituted.

## 3. Transport failure before first byte

Connect/TLS/request-rejection failures (e.g. `UND_ERR_SOCKET` before any
bytes): identical in kind to regime 1 — thrown before any content exists.
Non-2xx responses keep the exact legacy error contract
(`LLM API request failed: <status> <statusText> — <body>`).

## 4. Transport failure mid-stream

Remote disconnect or malformed/truncated SSE **before** `finish_reason`:
thrown as `LLM stream failed before completion (transport) … — no partial
generation is returned`. **No partial generation is ever returned as a
successful completed model turn.**

Disconnect **after** `finish_reason` (e.g. the trailing usage chunk is lost):
the generation itself completed; the assembled result is returned with
whatever usage was captured (`tokens_used: 0` if none arrived).
