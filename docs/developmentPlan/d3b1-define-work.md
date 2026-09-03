# D.3b1 — the define-work workflow

**Status:** Complete. `define-work` is registered as a third builtin
workflow (alongside `full-build`/`draft-artifact`), implementing D.3a's
methodology contract for `CAN_RESOLVE` resolution only, over D.3b0's three
generic seams.
**Milestone:** D, phase D.3b → D.3b0 → D.3b1 (see
`docs/developmentPlan/d3b0-generic-seams.md` and
`docs/developmentPlan/d3a-definition-readiness-methodology.md`)

## 1. Prerequisites found while planning registration

Before registering `define-work`, review found one thing the D.3b0 sketch
had assumed the runtime already provided, and it did not: `gather` a
`StepKind` — `WorkflowEngine.executeGather()` is, and remains, a pure
no-op (mark running → mark complete → next step; see `workflow/engine.ts`).
Honoring D.3a's `CAN_RESOLVE` contract for a repository fact ("does this
repository already have a networking layer?") requires an actual read of
the repository — which nothing in the `gather` kind, or anywhere in
`WorkflowEngine`, ever performed.

Four things followed from that, all decided before writing `define-work`
itself:

1. **No `context.gather` step in `define-work`.** A no-op step whose name
   implies evidence collection would misrepresent what happened. Repository
   inspection instead happens *inside* a `produce`/`review` step, through
   `AgentRunner`'s existing multi-turn path (`AgentLoop`, with its
   `read_file`/`list_directory` tools) — never inside `WorkflowEngine`,
   which stays exactly as methodology-agnostic as DDR-031 already requires.
   The smallest graph with real behavior is four steps, not five.
2. **Reuse `AgentLoop`, don't invent a second agent subsystem.** The
   capability already exists (bounded turns, `read_file`/`list_directory`);
   the gap was that it was unreachable from any production code path (see
   §3) and its read boundary was technology-specific (see §4).
3. **The tool read boundary was hardcoded and non-generic**
   (`AGENT_READ_ALLOWLIST = ['docs/', '.sle/runs/', 'src/']`), which would
   have silently denied `tests/`, a Rust workspace outside `src/`, a Godot
   project's `game/` tree, firmware, or any repository shape not on that
   list. Fixed generically — see §4 — not by adding more names to the list.
4. **`AgentRunner` could only reach `AgentLoop` when its provider exposed
   `completeMultiTurn`, and no real provider in this codebase did** —
   `DynamicLLMProvider` (the composition every real provider is wrapped in)
   only implemented `complete()`. Fixed narrowly — see §3 — without
   pretending every provider supports multi-turn.

## 2. Provider capability seam (`DynamicLLMProvider`)

`DynamicLLMProvider.completeMultiTurn` is no longer a fixed class method —
it is an optional *own property*, (re)computed by `syncMultiTurnCapability()`
in the constructor and on every `setProvider()`. When the currently-wrapped
provider implements `completeMultiTurn`, the property forwards to it; when
it doesn't, the property is `delete`d. `AgentRunner`'s existing detection —
`typeof provider.completeMultiTurn === 'function'` — was already exactly
the right check; the bug was that a class-level method declaration would
have made that check true unconditionally, regardless of what the wrapped
provider actually supported, letting `AgentRunner` select the multi-turn
path only to have it throw. No concrete provider in this codebase
(`OpenAICompatibleProvider`, `AnthropicProvider`) implements
`completeMultiTurn` today, so in current production use `define-work` runs
entirely single-turn — correct and expected; the seam exists so a future
multi-turn-capable provider is picked up automatically, with no
`WorkflowEngine` awareness of provider capabilities at all.

## 3. Semantic review verdict stays single-turn (deterministic)

D.3b0's `requiresReviewVerdict` contract reads `verdict: pass | fail` from
the single-turn SLE-OUTPUT preamble (`<!-- SLE-OUTPUT ... -->`, YAML).
`AgentLoop`'s multi-turn path parses a materially different format
(`<<<SLE-OUTPUT>>>` / `### path` delimiters, `output-parser.ts`) with no
preamble concept — it cannot carry a verdict at all. Rather than widen
`AgentLoop`'s protocol for this one field, `AgentRunner.run()` now forces
the single-turn path whenever `ctx.requiresReviewVerdict` is true, even if
the active provider supports multi-turn:

```ts
const isMultiTurn =
  !ctx.requiresReviewVerdict &&
  typeof (this.llmProvider as any).completeMultiTurn === 'function';
```

`tests/d3b1-define-work.test.ts` proves this with a provider that
implements both `complete` and `completeMultiTurn` — where
`completeMultiTurn` throws if it is ever invoked — confirming a
`requiresReviewVerdict` step still reaches and consumes its verdict via
`complete()` alone. `Definition synthesis/refinement (not opted into
requiresReviewVerdict) may still use `AgentLoop` when the provider supports
it; only the review step is pinned to single-turn.

## 4. Git-tracked-file read authority

`src/tools.ts`'s `AGENT_READ_ALLOWLIST` (a hardcoded directory-prefix list)
is replaced with `listGitTrackedFiles` — the project's `git ls-files`
output — as the sole read authority for `read_file`/`list_directory`,
independent of directory or technology. Both handlers now check the
caller's path against a `trackedFiles: ReadonlySet<string>` argument
instead of a prefix table:

- `read_file` permits exactly a tracked file path.
- `list_directory` is derived **entirely from the tracked-file set**, never
  from `fs.readdir` — an untracked file sitting next to tracked content in
  the same real directory (`.env`, a build cache, local credentials) can
  never appear in a listing, because the listing was never asked of the
  filesystem in the first place.
- Fails closed: if the tracked set can't be determined at all (not a git
  repository, `git` unavailable, command error), `listGitTrackedFiles`
  resolves to an empty list — every read is denied — rather than falling
  back to "allow everything."
- The existing traversal/absolute-path rejection is unchanged (`..` and
  absolute paths are rejected before any tracked-file check).

`AgentLoop` computes the tracked-file set **once per run** (not once per
tool call) via an injectable `listTrackedFiles` option (defaulting to the
real `git ls-files`-backed implementation), and reuses it for every
`read_file`/`list_directory` call in that run. Tests inject a synthetic
tracked-file list instead of requiring a real git repository — except
`tests/d3b1-define-work.test.ts`'s repository-inspection proof (§5), which
deliberately exercises the real implementation against a real (temporary)
git repository, since that is the one place in the suite proving the real
`git ls-files` path itself, not just the injectable seam.

`tests/agent-runner-multiturn.test.ts` (D.1-era, predates this authority
model) required four small fixture updates — injecting a synthetic tracked
list — where an existing assertion depended on a read actually succeeding;
every other test in that file was unaffected because it didn't assert on
tool-result content.

## 5. Repository-inspection proof (generic, before `define-work`)

`tests/d3b1-define-work.test.ts` Part B proves, against **synthetic**
workflow/step ids (`a-synthetic-workflow-not-define-work`,
`investigate-repository` — never `define-work` or a readiness-specific id),
that an explorer step can:

1. receive its declarative `instruction` (asserted present in the first
   message actually sent to the model);
2. inspect a Git-tracked repository file via the real `AgentLoop`/tool
   mechanism, against a real temporary git repository (`git init` + `git
   add`, no commit needed — `git ls-files` reports staged content);
3. inspect a tracked path **outside `src/`** (`tests/example.test.ts`) —
   proving the boundary is technology/path-independent, not a relocated
   prefix list;
4. produce exactly its declared output (D.1b/D.1c cardinality + exact-match,
   unchanged);
5. stay within its role's write ceiling (`explorer` → `.sle/work/`,
   unchanged);
6. never actually read an untracked path — proven by wrapping the real `fs`
   module to record every `readFile` call and asserting the untracked
   file's path never appears in that record (stronger than checking the
   tool's returned error string alone);
7. remain bounded by `AgentLoop`'s existing `MAX_AGENT_TURNS` cap — no
   second, looser cap was introduced for repository inspection.

## 6. The `define-work` workflow

`src/workflow/builtins/define-work.ts`, registered as a builtin (like
`full-build`/`draft-artifact`) in `workflow/registry.ts`:

```text
synthesize-definition (produce)
  → refine-definition (produce, skipped on iteration 1)
    → definition-readiness-review (review, requiresReviewVerdict: true)
        on_pass → commit
        on_fail → refine-definition (+ iteration, capped)
```

`synthesize-definition` only executes once: nothing ever routes back to
it — a failed review's `on_fail` target is `refine-definition`, so the
step graph's cursor never revisits index 0. `refine-definition`'s
`skip_if: iteration === 1` is what makes the *first* pass through the
linear sequence skip straight from synthesis to the readiness review; on
every iteration reached by looping back (2, 3, 4), `refine-definition`
runs normally, since `skip_if` is re-evaluated against the now-incremented
iteration.

`max_iterations: 4` on the definition (an initial draft plus at most 3
refinement passes is iterations 1–4 — see the D.3a.1 correction to
`d3a-definition-readiness-methodology.md` §4). No `onCapHit` override was
registered in `execution/workflow-invocation.ts`; the generic fallback
there (`{ action: 'halt' }`) already matches "never force READY, fail
closed" exactly.

Declared artifacts:

| Step | type | ref | path |
|---|---|---|---|
| synthesize/refine-definition | `definition` | `definition:{objectiveId}` | `.sle/work/{workItemId}/definition.md` |
| definition-readiness-review | `definition-readiness` | `definition-readiness:{objectiveId}` | `.sle/work/{workItemId}/readiness.md` |

`definition-readiness-review`'s `inputArtifactRefs` is the **physical
materialized path** (`.sle/work/{workItemId}/definition.md`), not the
semantic ref `definition:{objectiveId}` — `ContextManager` resolves
`inputArtifactRefs` against the filesystem (D.1b), it does not query
`ArtifactRepository`. The semantic ref is provenance identity, recorded
separately by `AgentRunner`'s existing declared-output provenance path
(D.1c); the two are not (and must not be treated as) interchangeable.

`explorer` is used for all three agent-facing steps — its `.sle/work/`
write ceiling already matches this workflow exactly, and nothing in
implementation surfaced a reason to introduce or reuse a different role.

## 7. D.3b1's scope: `CAN_RESOLVE` only

Per `synthesize-definition`/`refine-definition`'s own instructions: a
repository fact becomes `KNOWN` (`source: repository`) only after an actual
inspection — via the tools proven in §5 — never because the model judges it
"probably true." `HUMAN_DECISION`, `DEFER`, and `EXPLORE_AS_WORK` gaps are
preserved as unresolved blockers in the fact ledger (still `ASSUMED`/
`UNKNOWN`, not force-resolved) — no checkpoint, no investigation `WorkItem`,
no `Decision` routing exists yet; that is D.3c. A readiness review that
still finds such a blocker correctly returns `verdict: fail`, and the
refinement loop simply runs out its cap (§6) rather than ever manufacturing
a false `KNOWN`/`DECIDED`/`READY`.

## 8. What D.3b1 deliberately did not touch

- No `WorkProposal` produced or applied.
- No new `StepKind` (repository inspection lives inside `produce`/`review`
  via `AgentLoop`, not as a new kernel primitive) and no new `AgentRole`.
- No `Definition`/`WorkProposal` entity or table — `Definition` and its
  readiness review stay `Artifact`s, exactly as D.3a specified.
- No `ObjectiveService` dependency in `WorkflowEngine`, `ContextManager`,
  `AgentRunner`, or `AgentLoop` — `objectiveId` continues to arrive already
  resolved (D.3b0 §2B), and repository inspection is pure
  filesystem/git-metadata, never a database read.
- No workflow-id or step-id special case was added to `WorkflowEngine`,
  `FullBuildStepRunner`, `AgentStepRunner`, or `AgentRunner` for
  `define-work` — every mechanism it uses (`requiresReviewVerdict`,
  `includeWorkItemContext`, placeholder materialization, the tracked-file
  read authority) is the same generic mechanism the D.3b0/D.3b1 synthetic
  proofs exercise under unfamiliar ids.

## 9. Test coverage

`tests/d3b1-define-work.test.ts` (8 tests): the `DynamicLLMProvider`
capability seam (present only when genuinely supported, restored/removed
correctly across `setProvider()`); the `requiresReviewVerdict` single-turn
regression against a dual-capability provider; the full repository-
inspection proof (§5, real git repo); the turn-cap regression; `define-work`
structural assertions (step ids/kinds, `skip_if`, routing,
`inputArtifactRefs`, `max_iterations: 4`, no gather step); and two
end-to-end runs of the real registered workflow through the real
`WorkflowEngine`/`AgentStepRunner`/`AgentRunner`/`ArtifactRepository` stack
— one where a failed review triggers exactly one `CAN_RESOLVE` refinement
pass before passing and committing, and one where four consecutive fails
exhaust `max_iterations: 4`, halting with the cap error, iteration frozen
at 4, and the final Definition/readiness artifacts (both on disk and in
`ArtifactRepository`'s version history) intact.

`tests/agent-runner-multiturn.test.ts` gained the four fixture fixes noted
in §4; all pre-existing tests there (and everywhere else) are otherwise
byte-for-byte unchanged in behavior. Full `npm run verify` (type-check,
build, 1207 tests) is green.
