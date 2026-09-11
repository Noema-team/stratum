# DDR-034 — Models propose; Stratum materializes

**Date:** 2026-09-11 · **Status:** proposed
**Affects:** src/agent-runner.ts, src/transport/*, src/workflow/methodology/*, src/workflow/builtins/define-work.ts, src/application.ts, scripts/eval-define-work.ts (harness), docs/developmentPlan/d3a-definition-readiness-methodology.md
**Cites:** DDR-029 (activates its principle for canonical representation; DDR-029 itself remains deferred), DDR-019 (write-path ownership), DDR-030 (provider interface, capability probes), DDR-032 (kernel/runtime boundary placement)

## Principle

> **Models propose; Stratum materializes.**
>
> Models may produce semantic content and semantic judgments. They do not own canonical
> serialization, artifact envelopes, schema versions, artifact paths, workflow metadata,
> control transitions, or any other mechanically derivable state.

This is the second half of an authority rule D.3 has been converging on since D.3c1a:

- D.3c1a/D.3d.5 commit 3: **models don't own control** (routes are derived, never declared).
- DDR-034: **models don't own representation either** (canonical bytes are derived, never
  authored).

---

## 1. The architectural problem

On the live path for D.3 methodology artifacts, a model must simultaneously do two jobs:

1. **Reason** — build a fact ledger, judge epistemic status, classify readiness gaps.
2. **Serialize** — emit an HTML-comment YAML preamble carrying `role`/`node`/`artifacts`
   (plus `verdict` for reviews), then a `## <path>` section whose content is itself a
   canonical artifact beginning with `---`-delimited YAML front matter containing
   `schemaVersion: 1`, at an exactly-declared path.

Job 2 has no semantic content: `schemaVersion`, front-matter delimiters, artifact paths,
preamble metadata, and envelope framing are all mechanically derivable by Stratum. Nesting
one YAML dialect inside another is the hardest possible ask at this boundary, and the
system already needed special-case parsing to make the nesting even representable
(`splitStandardSections`, textual-sle-output.ts:87-95 — a canonical Definition artifact was
physically unwritable through the section separator until that fix).

Consequences observed in D.3 qualification runs (§2): capable models fail on envelope and
front-matter mechanics while their semantic work is sound; control semantics are split
across two representations (verdict in the transport preamble, gap classifications in the
artifact front matter); and route derivation re-parses bytes the system just asked the
model to serialize.

The fix: the model returns a **semantic proposal** (typed data). Stratum validates it,
derives any deterministic control from it, and **materializes** the canonical artifact
bytes itself.

## 2. Evidence

### 2.1 Code evidence (verified 2026-09-11)

| Evidence | Location |
|---|---|
| Capability ladder declared with slots 1–2 unimplemented ("not yet all built") | src/transport/step-result.ts:22-26 |
| Transport ownership is already designed as total — "a structured/native transport can replace the wire format without touching the runner" | src/transport/textual-sle-output.ts:14-18 |
| `resolveResultTransport`: native structured → tool-call → textual, only textual implemented | src/transport/textual-sle-output.ts:345-359 |
| Front-matter/section-separator collision — nested representations required special-case parsing | src/transport/textual-sle-output.ts:87-95 |
| Model is taught the full canonical YAML shape, including `schemaVersion: 1` and `---` delimiters | DEFINITION_CONTRACT, src/workflow/methodology/definition-readiness.ts:28-60 |
| Model is taught the transport preamble (`role`/`node`/`artifacts`/`verdict`) | singleTurnFormatInstruction, src/transport/textual-sle-output.ts:224-259 |
| Verdict (control-relevant) travels in the preamble; gaps (control-relevant) in artifact front matter — one judgment, two encodings | src/transport/textual-sle-output.ts:229-240; src/workflow/methodology/readiness-artifact.ts:32-45 |
| Route derivation re-parses artifact bytes to recover typed gaps | src/agent-runner.ts:479-482; createReviewRouteDeriver, src/workflow/methodology/readiness-artifact.ts:196-210 |
| The typed target already exists: `validateDefinition` consumes `CanonicalDefinition`, not text | src/workflow/methodology/definition-artifact.ts:329 |
| `deriveReviewRoute` is already a pure function over typed gaps | src/workflow/methodology/readiness-artifact.ts:158-188 |
| Provenance dedupes by content hash → any renderer must be deterministic | src/agent-runner.ts:564-583 |
| Composition root already wires methodology-owned validators/derivers into a generic runner | src/application.ts:341-357; src/agent-runner.ts:151,160-163 |
| Multi-turn tool plumbing exists for OpenRouter and Anthropic (tool_use mapping) | src/llm-provider.ts:107-131, :317-360 |
| Prior GPT-OSS qualification failure mode (absent result block) is recorded in-code | src/agent-loop.ts:219-222 |

### 2.2 Screening evidence — the D.34-0 cross-run failure audit

The formal audit is **complete**: `docs/developmentPlan/d34-failure-audit.md`
(evidence-only, from persisted `eval-reports/` + git-anchored version windows; no
methodology or implementation was changed while performing it). Headline numbers: 65
scenario-runs, 6 models, 22 PASS / 40 FAIL / 3 ERROR, classified into six classes.

Findings this DDR rests on:

- **F1 — post-D.3d.5, the residual failure set is mechanical.** glm-5.3-flash's five W3
  (post-D.3d.5) failures: 2 canonical-serialization (readiness artifact missing
  `schemaVersion` → route underivable; readiness artifact missing front matter after a
  gate-rejection round), 2 transport (result-block repair exhausted), 1 convergence —
  **zero semantic**. The same model failed semantically three times in earlier windows.
- **F2 — transport compliance is a poor proxy for semantic ability.** claude-sonnet-4,
  the only model to pass a full suite, also accumulated 10 pure-transport failures
  pre-D.3d.5 (absent result block, invalid `## <path>` header); gpt-oss-120b's single
  recorded failure is pure transport, 4 hours before bounded repair existed.
- **F3 — serialization failures hit the review path specifically**, where control (route
  derivation) depends on parsing the bytes — representation failure propagating into
  control. Both W3 serialization failures are of this shape.
- **F4 — D.3d.4/D.3d.5 already executed this method class by class**: over-escalation
  disappeared when methodology wording was corrected (9 occurrences across three models,
  all pre-D.3d.4); absent-block failures gained bounded repair when the transport was
  corrected. Canonical serialization is the remaining unfixed class — the model is still
  asked to author bytes no one should ask it to author.
- **F5 — convergence is real, small, separate**: 4 occurrences (mature objectives
  refined 1–2 extra rounds; one 3×CAN_RESOLVE chain at iteration 4). §12 workstream.
- Semantic-capability failures (16 occurrences: fact-ledger weakening, missed genuine
  decisions, premature pass, misjudged mature scope) are **legitimate screening
  rejections** and remain the object of semantic qualification (§13) — notably
  deepseek-v4-pro's fact weakening across five consecutive runs.

A separate observed behavior — three consecutive valid `CAN_RESOLVE` rounds without a pass
— is real but **out of scope here**; it is the convergence workstream (§12), not a
representation problem.

## 3. Relationship to DDR-029

DDR-029 (`ddr-029-agent-output-contracts.md`) states the principle this DDR activates:

> LLMs never mutate the system directly. They produce typed, validated declarations. The
> DAG runner decides, applies, validates, persists.

DDR-029 remains **deferred, unchanged, and unmodified**. It is the broader post-MVP
decision about typed role outputs (Designer/Builder/Tester/…) and declarative mutations.
This DDR:

- **cites** DDR-029's principle as its foundation;
- **activates a narrow slice of it ahead of DDR-029's general deferral**, triggered by
  D.3 screening evidence, and scoped to the D.3 methodology artifacts
  (`definition`, `definition-readiness`) only;
- **extends** the principle from *mutations* to *canonical representation* — DDR-029 says
  what a model may declare; DDR-034 says the model need not (and must not) also serialize
  the canonical artifact.

A `submit_result`-style tool (§9) is a **side-effect-free return channel**, not agent
execution. It is categorically the Model-A mechanism DDR-029 already evaluated and
preferred; it grants no filesystem, command, or network authority, and shares nothing with
the `write_file`/`run_command` tool-execution model DDR-029 rejected.

## 4. Ownership boundaries

### 4.1 Today

| Concern | Owner |
|---|---|
| Goal, facts, epistemic status, gap judgments, human explanation | Model ✓ (correct) |
| `schemaVersion`, `---` delimiters, YAML encoding, field ordering | **Model** ✗ (should be system) |
| Transport preamble (`role`/`node`/`artifacts`/`verdict`), envelope, paths | **Model** ✗ (should be system) |
| Envelope parsing, bounded repair | System (D.3d.5) ✓ |
| Mechanical validation, route derivation | System (D.3d.5) ✓ — but derives from re-parsed bytes |

### 4.2 After DDR-034

| Concern | Owner |
|---|---|
| Goal, facts, epistemic status, requirements, constraints, non-goals, acceptance, gap judgments, verdict, human explanation (bodyMarkdown) | **Model** (semantic proposal) |
| `schemaVersion`, front-matter delimiters, YAML encoding/quoting, field order, envelope framing, artifact path, transport metadata, provenance plumbing | **Stratum** (contract + runner) |
| Mechanical validation (enums, uniqueness, DECIDED↔decision pairing, provenance rule) | **Stratum** (existing validators, now over typed proposals) |
| Route derivation | **Stratum** (existing `deriveReviewRoute`, now over typed gaps — no parse-back) |
| Canonical bytes | **Stratum** (methodology-owned renderer) |
| Parsing persisted artifacts (reload, human edits, audit) | **Stratum** (existing parsers, unchanged) |

The persisted artifact format does **not change**: `definition.md`/`readiness.md` remain
`schemaVersion: 1` front matter + Markdown body at the same paths. What changes is who
produces those bytes on the live path.

## 5. Abstractions and dependency direction

### 5.1 `OutputContract<T>` (methodology-owned)

The user-suggested interface, refined. Changes from the sketch: (a) `modelSchema` is a
zod schema — zod is already a dependency, gives parse + type inference, and is the
**single canonical semantic shape** (see below); (b) provider-facing JSON Schema is a
**generated projection** of that schema, never a second hand-maintained definition; (c) a
`reviewVerdict` hook so the runner never learns that "verdict" is a field of some type.

```ts
// src/workflow/contracts.ts (new — the generic seam; no methodology imports)
import type { z } from 'zod';

export interface OutputContractContext {
  workItemId?: string;          // same minimal context as InputValidator today
}

export interface ContractDefect {
  code: string;
  message: string;
  ref?: string;                 // factId / gap target / path into the proposal
}

export interface OutputContract<T> {
  /** Matches DeclaredOutputArtifact.type (StepKinds `type`). */
  readonly id: string;

  /**
   * THE single canonical semantic shape the model is responsible for.
   * schemaVersion is NOT in it. Every provider-facing representation is
   * derived from this — nothing else is authoritative.
   */
  readonly modelSchema: z.ZodType<T>;

  /**
   * Optional human/model-facing prose (rationale, examples) layered OVER the
   * generated projection. NEVER an independent field/constraint definition.
   * Conformance-tested: every field named here must exist in the projection.
   */
  readonly schemaNotes?: string;

  /** Context-aware mechanical validation beyond the schema. Absent = schema is enough. */
  readonly validate?(
    value: T,
    ctx: OutputContractContext,
  ): readonly ContractDefect[];

  /** Required exactly for review contracts (step declares requiresReviewVerdict). */
  readonly reviewVerdict?(value: T): 'pass' | 'fail';

  /** Optional deterministic control projection (review contracts). */
  readonly deriveRoute?(
    value: T,
    declaredRoutes: readonly string[],
  ): ReviewRouteDerivation;

  /**
   * Deterministic canonical rendering. PURE: same (value, static config) → same bytes.
   * Injects schemaVersion. No clock, no randomness, no fs, no env.
   */
  readonly materialize(value: T, ctx: OutputContractContext): string;
}
```

**Schema authority (one schema, generated projections).** `modelSchema` is the only
place a field, type, or constraint is declared. `contracts.ts` owns a pinned projection
adapter — `toJsonSchema(modelSchema)` wrapping a pinned conversion dependency
(`zod-to-json-schema` is acceptable; the repo is on Zod 3.22) — and a teaching renderer,
`renderSchemaTeaching(contract)` = generated projection + `schemaNotes`. Both are
consumed verbatim by transports via `TransportContext` (`resultSchemaJson` for
submit-result/native transports, `resultSchemaText` for textual teaching). Constraints:

- OutputContract zod schemas are constrained to the subset the adapter translates
  reliably (objects, strings with refinements, enums, unions of literals, arrays,
  optionality); anything outside the subset is a review event, not a workaround.
- Conversion behavior is pinned by golden tests (schema in → projection bytes out);
  adapter/dependency bumps regenerate goldens in the same commit.
- Textual teaching may *annotate* (explain, exemplify) but must not introduce fields,
  constraints, or types absent from `modelSchema`; a conformance test fails the build if
  it does.

### 5.2 `StepResult` — a discriminated union, not an ambiguous optional

Adding an optional `proposal` beside an optional `artifacts` would let every consumer
guess which shape arrived. The result is instead an explicit logical union — exactly one
kind per reply:

```ts
// src/transport/step-result.ts — replaces the current interface shape
export interface StepProposal {
  contractId: string;      // = OutputContract.id, from TransportContext.declaredArtifactId
  value: unknown;          // decoded+validated by the runner through the registry contract
}

/**
 * The logical step result. Exactly one kind is ever present:
 *  - 'materialized' — legacy path: canonical artifact bytes (non-contract roles),
 *    plus the legacy preamble verdict. Byte-for-byte today's behavior.
 *  - 'proposal'     — semantic path: a payload for a registered OutputContract.
 * A transport can never emit both; the compiler enforces what the runner dispatches on.
 */
export type StepResult =
  | {
      kind: 'materialized';
      artifacts: StepResultArtifact[];
      review?: StepReviewProposal;
    }
  | {
      kind: 'proposal';
      proposal: StepProposal;
    };
```

Migration semantics: output-contract steps produce proposals; legacy/unmigrated steps
continue producing materialized results. The runner dispatches on **result kind +
registered output contract** (`kind: 'materialized'` → existing pipeline unchanged;
`kind: 'proposal'` → contract pipeline, §5.3), which lets D.34 migrate readiness and
Definition without implicitly redesigning every existing role. Removing the
`'materialized'` kind later — if and when all roles migrate — is a separate, independent
decision.

TransportContext gains the runner-generated schema projections (transports consume them
verbatim and never learn what a Definition is):

```ts
/** Generated by the runner from the resolved contract (see §5.1). Absent = legacy. */
resultSchemaText?: string;                  // teaching text: projection + schemaNotes
resultSchemaJson?: Record<string, unknown>; // generated projection, for tool/native transports
```

### 5.3 Runner registry and resolution rule (generic)

```ts
// AgentRunnerConfig — additive, same shape as inputValidators
outputContracts?: Record<string, OutputContract<never>>;
```

Resolution rule, fully generic (no `if (definition)` anywhere) — dispatch on **result
kind + registered contract**:

1. Step declares `outputArtifact.type`; runner looks up `outputContracts[type]`.
2. Transport returns `kind: 'proposal'` → **contract path required**: a contract must be
   registered for `proposal.contractId` (else fail closed — authoring error).
   `modelSchema.safeParse` → `validate?` → `reviewVerdict?`/`deriveRoute?` →
   `materialize` → existing path-canonicalization, role-ceiling, write, and provenance
   pipeline (agent-runner.ts:499-583, unchanged).
3. Transport returns `kind: 'materialized'` → legacy byte path, byte-for-byte today's
   behavior. All non-contract roles (builder, designer, …) are untouched; this is also
   the permanent coexistence story for DDR-029's future scope.
4. A step whose type has a registered contract but whose transport produced
   `materialized` bytes is a negotiation bug — fail closed (the contract path can never
   be silently bypassed by a stale transport).

Fail-closed authoring errors (before any LLM call), mirroring the existing input-validator
rules (agent-runner.ts:620-626):

- step declares `requiresReviewVerdict` on the contract path and the contract lacks
  `reviewVerdict`;
- contract path, fail verdict, declared fail routes, and the contract lacks `deriveRoute`;
- transport returned a proposal for a type with no registered contract (or vice versa
  per rule 4).

**Two validation layers, deliberately distinct** — never merge them:

| Layer | Question | Mechanism | Failure shape |
|---|---|---|---|
| **Decode** | *Is this structurally a `T`?* | `modelSchema.safeParse` (zod) | schema diagnostics → transport repair prompt (bounded) |
| **Validate** | *Does this typed `T` satisfy the methodology's deterministic invariants?* | `validate?(value, ctx)` — plain code over `T` | structured `ContractDefect[]` → repair prompt (bounded), same defect wording the refine path consumes |

`validateDefinition` keeps its structured defects and its authority-resolution semantics
(`findDecision` closure injected at the composition root) — it is **wrapped, verbatim, as
the contract's `validate`**; it is never buried inside zod refinements, where
methodology rules would degrade into anonymous schema errors and Decision-resolution
context would have no place to live.

Decode/validate failures enter the **existing bounded format-repair machinery**
(`MAX_FORMAT_REPAIRS`, `repairDecision`, same diagnostic shape — step-result.ts:141-168)
with the schema/defect text as the repair reason. Exhaustion fails closed exactly as
today.

### 5.4 Dependency direction

```text
src/workflow/methodology/*   →  owns semantic types, zod schemas (the single schema
                                authority), validators, renderers, contracts   (meaning)
src/workflow/contracts.ts    →  owns OutputContract<T>, StepProposal, the pinned
                                schema-projection adapter (shape of the seam)
src/transport/*              →  owns wire envelopes; consumes generated schema
                                projections verbatim
src/agent-runner.ts          →  owns orchestration, gates, materialization invocation,
                                writes, provenance (generic — registry lookups only)
src/application.ts           →  owns composition: contract instances, closures (findDecision)
src/workflow/engine.ts       →  UNCHANGED, UNAWARE
```

Methodology may not import transport or runner. Transport may not import methodology.
The runner imports only `contracts.ts` types. Composition is one-directional at
`buildAgentRunner` (src/application.ts:320-359), exactly the pattern D.3d.5 established.

## 6. Option A vs Option B — recommendation

**Option A — transport renders.** The structured/textual transport resolves the codec
(requires registry access inside transport construction) and emits canonical bytes into
`StepResult.artifacts`. Runner untouched.

- ✅ Zero runner change.
- ❌ Two different layers would own canonical bytes depending on which transport was
  negotiated — a latent ownership split; a transport bug bypasses every runner-side
  semantic gate by construction.
- ❌ Route derivation still parse-back (`deriveReviewRoute(artifactText, …)` on
  agent-runner.ts:479-482).
- ❌ Verdict still travels outside the semantic payload.

**Option B — write-path/runtime materializes (RECOMMENDED).** `StepResult` gains a
`'proposal'` kind carrying the decoded-JSON payload; the runner resolves the contract from its own registry
(the established `inputValidators` pattern), decodes, validates, derives verdict/route,
materializes, and writes through the existing gated pipeline.

- ✅ One owner of canonical bytes: the methodology contract, invoked at the write path.
- ✅ Route derived from typed gaps — the parse-back at agent-runner.ts:479-482 is deleted
  on the contract path.
- ✅ Runner changes are additive and generic (registry lookup + four hook calls); the
  runner still never learns what a Definition is.
- ✅ Contract path is unit-testable with no transport at all (`decode → validate →
  materialize` directly).
- ❌ The runner grows a second execution branch (accepted: the legacy branch is required
  indefinitely for non-contract roles anyway).

**Decision: Option B.** Option A's "zero runner change" is illusory — the registry has to
reach the transport somehow — and it leaves the parse-back and the two-owner problem
unsolved.

## 7. Readiness-first migration design

Readiness is the smallest, cleanest case: route derivation is already a pure function of
typed gaps, and the reviewer's semantic judgment is compact.

### 7.1 Proposal (methodology-owned, `readiness-contract.ts`)

```ts
export interface ReadinessProposal {
  verdict: 'pass' | 'fail';
  gaps: Array<{
    target: string;          // fact id or explicit missing-area identifier (model-chosen, as today)
    description: string;
    classification: GapClassification;   // CAN_RESOLVE | DEFER | HUMAN_DECISION | EXPLORE_AS_WORK
    reason: string;
    closure?: string;
  }>;
  bodyMarkdown: string;      // the human-facing review explanation (artifact body)
}
```

The model stops emitting: `schemaVersion`, `---` front matter, the preamble envelope, the
`## <path>` header path, and the separate preamble `verdict:` line. Verdict moves **into**
the semantic payload — one judgment, one encoding.

### 7.2 Contract wiring

- `modelSchema`: zod schema over `ReadinessProposal` (enum-validated classifications —
  the mechanical membership check parseReadinessArtifact performs today,
  readiness-artifact.ts:119-131, moves to the schema).
- `validate`: none needed initially (membership is schema; nothing else is mechanical).
- `reviewVerdict`: `(p) => p.verdict`.
- `deriveRoute`: `(p, routes) => deriveReviewRoute(p.gaps, routes)` — **the existing pure
  function, called directly** (readiness-artifact.ts:158-188, unchanged).
- `materialize`: renders

  ```text
  ---
  schemaVersion: 1
  gaps: [ …typed gaps, canonical YAML… ]
  ---

  <bodyMarkdown>
  ```

  byte-compatibly with today's format (§10 invariants), verified by round-trip against
  `parseReadinessArtifact`.

### 7.3 Live-path behavior after migration

```text
model → ReadinessProposal payload
  → zod decode (mechanical; repairable, bounded)
  → reviewVerdict hook → existing verdict gate (agent-runner.ts:449-457, unchanged)
  → deriveRoute over typed gaps → existing allowlist gate (agent-runner.ts:476-497, unchanged)
  → materialize readiness.md (system bytes)
  → canonical path + role ceiling + write + provenance (unchanged)
```

The sequence `model → readiness bytes → parse bytes → derive route` no longer exists on
the live path.

### 7.4 What stays

- `parseReadinessArtifact` — the load path for persisted/human-edited/cross-run artifacts
  (§11). Also consumes materialized bytes in the round-trip tests.
- The deterministic input-validation gate (agent-runner.ts:608-679) — it validates the
  *input* Definition from disk and is untouched by this migration.
- `writeGateRejection` — the refine step still consumes the readiness artifact as text;
  gate rejections keep their current markdown shape.
- `READINESS_RUBRIC`, `GAP_CLASSIFICATION`, `READINESS_ROUTE_CONTRACT` — semantic
  methodology, unchanged. `READINESS_ROUTE_CONTRACT` shrinks by whatever wording purely
  describes transport mechanics.

## 8. Definition migration design

### 8.1 Proposal (`definition-contract.ts`)

```ts
export interface DefinitionProposal {
  goal: string;
  facts: Array<{
    id: string;              // model-chosen, as today (see OQ-034-1)
    statement: string;
    status: FactStatus;
    source: FactSource;
    kind?: FactKind;
    decisionRef?: string;    // DECIDED pairing enforced mechanically, as today
    evidenceRef?: string;
  }>;
  constraints?: CanonicalConstraint[];
  requirements?: string[];
  nonGoals?: string[];
  acceptance?: CanonicalAcceptanceCriterion[];
  bodyMarkdown: string;      // design notes / rationale / tradeoffs
}
```

### 8.2 Contract wiring

- `modelSchema`: zod over `DefinitionProposal` (status/source/kind enums at the schema
  layer; non-empty-after-trim via `.refine`, never silent `.trim()` transforms — content
  is normalized, never cleaned).
- `validate`: wraps the existing `validateDefinition` (definition-artifact.ts:329-430)
  **verbatim, as a plain function over `T` — never expressed as zod refinements**. It
  already consumes `CanonicalDefinition`; the proposal maps onto it 1:1, and its
  structured defect codes plus authority resolution (`findDecision` closure injected at
  the composition root, application.ts:342-355) are preserved exactly. Defects feed the
  bounded repair loop with the same structured-defect wording the refine path already
  consumes.
- `materialize`: renders front matter (`schemaVersion: 1` injected; field order
  `schemaVersion, goal, facts, constraints, requirements, nonGoals, acceptance`) +
  `bodyMarkdown`, byte-compatible with `parseDefinition`.

### 8.3 Affected steps

`synthesize-definition`, `refine-definition`, `apply-deferred-gaps`,
`apply-human-decision` (all produce `definition`), plus the three review steps
(produce `definition-readiness`). All are contract-path by registry lookup; the step
declarations in define-work.ts keep their ids, paths, routes, and iteration semantics.
Multi-turn investigation (AgentLoop read tools) is orthogonal and unchanged —
`submit_result` (§9) rides alongside the read tools.

What the methodology prompts stop teaching: the entire mechanical serialization block of
`DEFINITION_CONTRACT` (exact YAML shape, `---` delimiters, `schemaVersion: 1`,
quoting/structure rules — definition-readiness.ts:28-60) moves into the **generated
schema projection** (`renderSchemaTeaching`: projection bytes + `schemaNotes`) — no
hand-maintained textual schema. The prompt keeps the *epistemic* contract: ledger rules,
status/source semantics, provenance discipline. Prompt tokens go down; the projection
becomes the single serialization teacher, in whichever representation the negotiated
transport uses.

## 9. Provider/transport capability strategy

### 9.1 Preference order (runtime — unchanged from D.3d.5's declaration)

```text
1. provider-native structured output
2. submit-result / tool-call (side-effect-free return channel)
3. textual SLE-OUTPUT envelope carrying the JSON proposal payload
```

Implementation order differs from preference order (as directed): **submit-result first**
(plumbing exists: `completeMultiTurn` on OpenRouter + Anthropic tool_use mapping,
llm-provider.ts:107-131), **native structured output second** (support varies widely
across OpenRouter models). Slot 3 is always available; capability negotiation degrades,
never fails, and the negotiated transport is recorded in run metadata for screening
attribution (§13).

### 9.2 `submit_result` semantics — a return channel, not agency

- Declared **alongside** the read tools on multi-turn produce steps; calling it is the
  model *returning its answer*, terminating the loop the way an `end_turn` with a
  well-formed block does today.
- Carries **no** filesystem/command/network authority. It is DDR-029's Model A
  (typed declarations; system applies), not the Model B tool-execution model DDR-029
  rejected.
- Tool definition generated from the contract's schema projection —
  `resultSchemaJson`, produced by the pinned adapter from `modelSchema` and
  runner-injected via TransportContext; the transport stays schema-agnostic.
- Loop handling: on a `submit_result` tool_use, the loop extracts the payload into a
  `kind: 'proposal'` result and ends the step (the model may still have spent earlier turns
  on read-only investigation). Missing/invalid payloads route through the same bounded
  repair machinery as today's envelope failures.

### 9.3 `completeMultiTurn` is a vehicle, not the destination

`completeMultiTurn` conflates *interactive investigation* (read tools, N turns) with
*result submission*. It is the right first vehicle because produce steps already need the
investigation loop. Long-term the provider interface gains a distinct capability:

```ts
// additive, capability-probed (DDR-030 pattern) — NOT implemented by every provider
completeStructured?(params: {
  model: string; system: string; messages: LLMCompletionParams['messages'];
  max_tokens: number;
  jsonSchema: Record<string, unknown>;   // generated projection (pinned adapter)
}): Promise<{ value: unknown; tokens_used: number; duration_ms: number }>;
```

Implementations: native response_format/json_schema where genuinely supported; a forced
`tool_choice: submit_result` single call otherwise. This gives single-turn review steps a
structured channel without pretending they are interactive agents, and lets the review
single-turn execution policy (agent-runner.ts:239-246) be revisited on evidence rather
than transport necessity.

**Phase plan:** phase 1 ships contracts over the textual envelope (all providers, no
provider code); phase 2 adds `submit_result` on `completeMultiTurn` for multi-turn produce
steps; phase 3 adds `completeStructured` for reviews and negotiates it first where
genuinely supported.

## 10. Deterministic renderer invariants (hard requirements)

Provenance dedupes by content hash (agent-runner.ts:564-583), so the renderer is a pure
function: `same proposal + same static config → same bytes → same hash`.

1. **Purity.** No clock, randomness, environment, or filesystem access inside
   `materialize`. Enforced by review + the stability property test (§16).
2. **Key order.** Fixed declaration order — Definition: `schemaVersion, goal, facts,
   constraints, requirements, nonGoals, acceptance`; fact entries: `id, statement,
   status, source, kind, decisionRef, evidenceRef`; Readiness: `schemaVersion, gaps`;
   gap entries: `target, description, classification, reason, closure`. Never sorted
   alphabetically; never input-order-dependent.
3. **Optional fields.** `undefined` → omitted entirely (never `key: null`, never
   `key: undefined`). **Empty-but-present optional arrays are meaningful and rendered
   explicitly** (`constraints: []` = "explicitly none") — the absent/empty semantic
   distinction is preserved.
4. **Array order.** Semantic order is preserved verbatim (fact-ledger order, gap order).
   The renderer never sorts, dedupes, or reorders — dedupe/uniqueness is validation's
   failure domain, not rendering's cleanup.
5. **Content integrity.** Model strings are never trimmed, collapsed, reflowed, or
   markdown-munged. `bodyMarkdown` is emitted as-is after newline normalization. Content
   that would need cleaning is *rejected by the schema* (non-empty-after-trim refinements),
   never silently fixed.
6. **Newlines.** CRLF/CR in any proposal string normalized to LF (representation
   normalization, not content change). Rendered artifact ends with exactly one `\n`.
7. **Envelope.** Front matter is `---\n` + YAML + `\n---\n`; exactly one blank line
   between the closing `---` and a non-empty body; empty body → artifact ends at the
   closing `---` newline.
8. **YAML engine pinning.** js-yaml `dump` with pinned options recorded as named constants
   in the codec files (`indent: 2`, `lineWidth` pinned, `noRefs: true`, `sortKeys: false`,
   default quoting); the js-yaml version is pinned. Any bump requires regenerating golden
   fixtures in the same commit, with the byte diff reviewed explicitly.
9. **No generated identity.** No timestamps, UUIDs, hashes, or system-derived IDs injected
   at render time.
10. **Golden-byte tests.** Fixture proposals → exact committed bytes. A one-byte diff is a
    review event. Paired round-trip tests: `render → parse(parseDefinition /
    parseReadinessArtifact) → semantic equality`, and stability:
    `render(decode(render(p))) === render(p)`.

## 11. Parser responsibilities after migration

Parsers lose zero authority; they change *callers*.

| Path | Before | After |
|---|---|---|
| Live produce/review (contract steps) | model bytes → parse → validate | proposal → schema decode → validate → **materialize** |
| Route derivation (contract steps) | parse readiness bytes → derive | typed gaps → derive (direct) |
| Deterministic input gate (review steps) | parse definition bytes from disk | **unchanged** (input is disk bytes) |
| Disk reload: resume, audit, cross-run, human-edited artifacts | parse → validate | **unchanged** |
| Legacy (non-contract) roles | model bytes → parse (where applicable) | **unchanged** |

Consequence: on the contract path the live loop can no longer produce
`FRONT_MATTER_MISSING` / `SCHEMA_VERSION_UNSUPPORTED` for its own output — those defect
classes become impossible by construction rather than caught by validation. They remain
live and meaningful for disk-reload paths (hand-edited artifacts).

## 12. Convergence follow-up (separate workstream — design sketch only)

**Not in scope for implementation under this DDR.** Recorded so the representation work
doesn't preclude it.

Observed shape: review N finds G1/G2 → refine resolves them → review N+1 receives only
the refined Definition (define-work.ts:180 — `inputArtifactRefs` names definition.md
only) and re-reviews from scratch, so a cautious rubric can always discover fresh
improvements; three consecutive valid `CAN_RESOLVE` rounds are the symptom.

**Smallest adjudicative change (to be specced separately):**

1. Review N+1 must explicitly receive review N's gap list (readiness.md from the prior
   round persists on disk — refine never writes it — so the mechanism is input wiring,
   not engine change; candidate mechanisms: add `.sle/work/{workItemId}/readiness.md` to
   the review step's inputs with a ContextManager tolerance for first-round absence, or
   runner-side `ephemeral` injection (StepRunContext.ephemeral already exists,
   workflow/types.ts:342). Decide there; **WorkflowEngine remains untouched either way**.
2. Review N+1's proposal adjudicates each prior gap — CLOSED / PERSISTS / reclassified —
   plus genuinely new gaps. This is a proposal-schema extension (`adjudications?`),
   gated on prior gaps being present in context.
3. Stable gap identity is a prerequisite for any future deterministic non-convergence
   detection: `target` (fact id / missing-area id) is the natural primary key, with
   description for disambiguation. Note it now; design it when item 2 lands.
4. **Explicitly deferred:** stall detectors, iteration-budget changes, rubric rewrites.
   First make review N+1 adjudicate review N; measure; then decide.

## 13. Screening redesign

The combined "5/5 qualification score" is retired in favor of independent tiers. A model
can be semantically qualified yet transport-limited; that combination routes around
transport limits rather than rejecting the model.

| Tier | Question | Measured on | Transport dependence |
|---|---|---|---|
| **Semantic qualification** | Does the model reason well about work? Fact discipline, KNOWN/ASSUMED/UNKNOWN/DECIDED/DEFERRED honesty, classification correctness, fabrication resistance, reasonable-default judgment, gap quality | Contract path proposals (typed) | Minimal — any transport that yields a valid proposal |
| **Transport compatibility** | Can model × provider × transport reliably produce valid submissions (tool-call JSON / payload text)? | Per-transport success/repair rates | The thing being measured |
| **Workflow convergence** | Rounds-to-pass; gap churn; repeat classifications across refinement rounds | Full define-work runs | None beyond semantic tier |
| **Deployment qualification** | End-to-end pass rate of the concrete deployed tuple (model × provider × transport × workflow) | Production-shaped runs | All of it |

Harness changes (scripts/eval-define-work.ts): report per tier; record negotiated
transport per run; semantic scoring consumes typed proposals (no byte-parse scoring);
transport-tier failures are attributed to the triple, not the model. Mechanical
compliance still matters — it becomes a **system regression suite** (golden bytes,
round-trip, bounded-repair behavior) plus a **per-triple compatibility measurement**,
instead of a model entrance exam.

## 14. Implementation sequence (small, reviewable commits; no code yet)

| # | Commit | Contents | Acceptance |
|---|---|---|---|
| D.34-0 | **Cross-run failure audit** — ✅ complete | Classify every recorded screening failure; evidence-only, from persisted eval reports + git-anchored windows | `docs/developmentPlan/d34-failure-audit.md` — 65 runs, 6 models, 6 classes; cited in §2.2 |
| C1 | Contract seam | `contracts.ts` types + pinned schema-projection adapter skeleton; `StepResult` discriminated union (`materialized` \| `proposal`); `outputContracts` registry; generic contract path + fail-closed authoring errors in agent-runner; TransportContext schema projections | No contracts registered → zero behavior change; full existing suite green; union enforced at compile time |
| C2 | Readiness codec | `ReadinessProposal`, zod schema (single authority), generated projection + golden projection tests, `schemaNotes`, `renderReadiness` (invariants §10), readiness contract with `reviewVerdict`/`deriveRoute` hooks | Golden-byte + round-trip + stability + projection-conformance tests green |
| C3 | Readiness wiring | Register contract at composition root; review steps on contract path; textual transport teaches the generated projection for proposal steps; prompt slimming (verdict + serialization mechanics out) | define-work review runs textual end-to-end; route gate consumes typed gaps (parse-back deleted on this path) |
| C4 | Definition codec + wiring | `DefinitionProposal`, schema, `validateDefinition` wrapper (plain function, not refinements), renderer, goldens; produce steps on contract path; defect text feeds bounded repair | Same as C2/C3, plus DECIDED-referral resolution via composition-root closure |
| C5 | submit_result transport | Tool-channel transport on `completeMultiTurn` (produce steps); tool schema from `resultSchemaJson`; negotiation order in `resolveResultTransport` extended; run metadata records negotiated transport | Multi-turn produce with read tools + submission on both OpenRouter and Anthropic paths |
| C6 | Provider structured capability (optional sequencing) | `completeStructured` capability + review-step structured channel | Capability-probed; textual fallback intact everywhere |
| C7 | Harness split | Four-tier scoring in scripts/eval-define-work.ts; **persist failing artifacts + raw node-outputs for failed steps** (audit finding F6) | Tier report emitted per run; SER/TRANSPORT failures auditable from artifacts |

C1–C4 are independent of provider work (textual envelope throughout); C5/C6 upgrade the
channel without touching contracts or methodology.

## 15. Frozen surfaces (must NOT change)

- **`src/workflow/engine.ts` and WorkflowEngine semantics** — the strong acceptance
  criterion. No route precedence, iteration accounting, checkpoint, Decision-lifecycle, or
  step-dispatch changes. `git diff engine.ts` across the entire series is the test.
- Canonical on-disk artifact format: `schemaVersion: 1`, front matter + body, same paths,
  same parsers. Pre-migration artifacts must load unchanged.
- D.3d.5 fail-closed machinery: `TransportParseError` taxonomy, `MAX_FORMAT_REPAIRS`,
  `repairDecision`, exhaustion diagnostics, input-validation gate, `writeGateRejection`.
- Path safety, role ceilings (`ROLE_OUTPUT_PATHS`), append-only policy, provenance/hash
  schema in ArtifactRepository.
- Route derivation semantics: `GAP_CLASSIFICATION_PRECEDENCE` order and the allowlist
  gate. Only the *input* to derivation changes (typed gaps instead of parsed bytes).
- DDR-029 text and status; DDR-030 provider capability-probe pattern.
- Non-contract roles' wire behavior (builder, designer, planner, …) — byte-for-byte.
- WorkflowStep schema: no new required fields; contracts attach by registry lookup on
  `outputArtifact.type`.

## 16. Acceptance criteria

1. `git diff src/workflow/engine.ts` is empty across the full implementation series.
2. For contract steps, no model-visible instruction teaches `schemaVersion`, `---`
   delimiters, artifact paths, or preamble YAML; the generated schema projection is the only
   serialization teacher. (Verified by prompt-text diff and grep.)
3. A proposal missing `schemaVersion`-class mechanical state is **impossible to
   represent** — mutation test: deleting system-side injection fails tests, not runs.
4. Renderer determinism: golden-byte fixtures pass; `render ∘ decode ∘ render` is the
   identity; `js-yaml` pin bump without golden regeneration fails CI.
5. Round-trip: `parseDefinition(render(definitionProposal))` and
   `parseReadinessArtifact(render(readinessProposal))` yield semantic equals, for all
   fixtures including absent-vs-empty optional sections.
6. Route derivation on the contract path consumes typed gaps; the
   `deriveReviewRoute(artifactText, …)` parse-back call site is deleted for contract
   steps (agent-runner.ts:479-482).
7. Legacy roles and the textual fallback remain fully functional (coexistence proven by
   existing suite + one legacy-role integration run).
8. The verdict, gaps, and explanation of a review are carried in **one** semantic
   encoding end-to-end (proposal), with the artifact a system-rendered projection.
9. Screening harness reports the four tiers independently; transport failures are
   attributed to model × provider × transport, not to semantic qualification.
10. Full existing test suite passes with only the explicitly enumerated prompt/assertion
    updates.
11. **Single schema authority**: no hand-maintained JSON Schema or textual field list
    exists anywhere in the contract path; every provider-facing schema artifact is the
    output of the pinned adapter applied to `modelSchema` (verified by golden projection
    tests), and the schemaNotes conformance test fails the build if teaching text names
    anything absent from the projection.
12. **StepResult is a closed union**: the compiler rejects any transport or runner code
    path that could observe both a materialized result and a proposal for one reply;
    a proposal arriving with no registered contract fails closed (mutation test).

## Resolved OQ decisions (2026-09-11 review)

The following were resolved during DDR review; see also §Open questions:

- **Schema authority** — the Zod `modelSchema` is the single canonical semantic shape.
  Provider-facing JSON Schema is a generated projection through a small pinned
  conversion dependency (repo is on Zod 3.22), constrained to a reliably translatable
  Zod subset and pinned by golden tests. Textual teaching annotates the projection but
  is never independently authoritative.
- **StepResult migration** — a discriminated union (`materialized` | `proposal`), never
  an ambiguous optional pair. Runner dispatches by result kind + registered output
  contract; legacy roles keep materialized results until a separate decision removes
  the kind.
- **Decode vs validate** — zod answers "is this structurally a `T`?"; `validate?`
  answers "does this `T` satisfy deterministic methodology invariants?".
  `validateDefinition` is wrapped verbatim as plain code, never buried in zod
  refinements; its structured defects and authority-resolution semantics are preserved.

## Open questions

| ID | Question | Notes |
|----|----------|-------|
| OQ-034-1 | Should fact `id`s become system-assigned? | **Resolved: NO for D.34.** Fact IDs are semantic referential identity across Definition / readiness / refinement / Decision provenance. Stable identity is not mechanically derivable without solving semantic equivalence — a problem deliberately not introduced here. Model-owned, as today. Revisit only with the §12 stable-gap-identity work. |
| OQ-034-2 | zod-to-json-schema dependency vs hand-written `wireSchema.jsonSchema`? | **Resolved: derive, never hand-maintain.** JSON Schema is a generated projection of `modelSchema` via a small pinned conversion dependency; the contract's Zod schema is the single authority. See §5.1 and acceptance criterion 11. |
| OQ-034-3 | Prior-readiness wiring mechanism (§12.1): review-step input ref vs runner-side `ephemeral` injection? | **Deliberately open.** The current asymmetry (refine sees the prior readiness; the next review does not) is confirmed by the audit (finding F5) but is designed only after the typed readiness/materialization path exists (post-C3). |
| OQ-034-4 | Do draft-artifact/full-build builtins migrate to contracts? | Out of scope — that is DDR-029's general activation, post-MVP. |
| OQ-034-5 | Renderer byte-compatibility for *existing committed* artifacts? | Parsers define compatibility, not bytes; fixtures should still prefer byte-identity with current canonical examples where achievable. Any divergence must be listed in the C2/C4 commit messages. |
