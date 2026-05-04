# DDR-029 — Agent output contracts and Builder schema

**Date:** 2026-05-04 · **Status:** deferred (post-MVP)
**Affects:** types.md, prompt-templates.md, dag-node-reference.md, dag-execution.md, context-manager.md

## Context

### The current state

`AgentResult.output` is typed as `unknown` (types.md:244-249). There is no compile-time guarantee that a Builder's output looks different from a Designer's. Output schemas for four roles (Tester, Debugger, Evaluator, Critic) exist only as prompt instructions in prompt-templates.md — not as typed contracts the daemon can validate.

Six roles produce unstructured prose (Designer, Explorer, Planner, Historian, Facilitator x3) with no machine-parseable contract.

**Builder is the critical gap.** The spec says Builder produces "implementation code files written to the project source tree" (prompt-templates.md:436-441) but also says "Templates must not instruct the agent to run commands, access the filesystem, or make network requests" (prompt-templates.md:873-874). These two statements contradict each other. Builder needs an output schema that lets it declare file mutations without touching the filesystem.

### Why not tool-calling / sandbox agents

Three models were evaluated:

| Model | How agents work | Determinism | Replayability |
|-------|----------------|-------------|---------------|
| **A — Structured output** | Agent returns typed JSON; system applies | High | High |
| **B — Tooled execution** | Agent calls tools (write_file, run_command) in a sandbox | Low | Low |
| **Hybrid** | Most roles use A; Builder/Debugger use B | Mixed | Mixed |

Model B and Hybrid give agents direct filesystem/terminal access, which collapses Layer 3 (agent reasoning) into Layer 2 (execution). This sacrifices:
- Determinism — file changes happen implicitly, execution order matters in hidden ways
- Replayability — can't reconstruct what happened from artifacts alone
- Inspectability — the DAG runner is no longer the sole source of truth for mutations

The DAG runner already *is* the execution control layer. The question is not "should agents have tools?" but "what is the output contract of each DAG node?" Giving agents richer structured output schemas is Model A with better types — not a new model.

### Principle

> **LLMs never mutate the system directly.** They produce typed, validated declarations. The DAG runner decides, applies, validates, persists.

This is already the stated intent of the architecture. The gap is that the types don't enforce it.

## Decision

### 1. Typed `AgentOutput` discriminated union

Replace `AgentResult.output: unknown` with a per-role discriminated union:

```typescript
export type AgentOutput =
  | { role: 'designer'; documents: DesignerOutput }
  | { role: 'explorer'; documents: ExplorerOutput }
  | { role: 'planner'; documents: PlannerOutput }
  | { role: 'tester'; scripts: TesterOutput }
  | { role: 'builder'; files: BuilderOutput }
  | { role: 'debugger'; report: FailureReportRich }
  | { role: 'evaluator'; verdict: EvaluatorOutput }
  | { role: 'critic'; critique: CritiqueResult }
  | { role: 'historian'; entry: HistorianEntry }
  | { role: 'facilitator'; response: FacilitatorOutput }
```

The `AgentResult` type becomes:

```typescript
export interface AgentResult {
  role: AgentRole
  output: AgentOutput
  tokens_used: number
  duration_ms: number
}
```

### 2. Per-role output schemas

#### Designer — prose documents (no JSON wrapping)

```typescript
export interface DesignerOutput {
  architecture: string   // markdown content for architecture.md
  requirements: string   // markdown content for requirements.md
}
```

Rationale: Designer produces prose architecture/requirements documents. Wrapping in JSON gives the DAG runner a parseable envelope while keeping content as markdown strings.

#### Explorer — research findings

```typescript
export interface ExplorerOutput {
  findings: string       // markdown content for research-findings
  tag: 'explore:user-guided'
  open_questions: string[]
}
```

#### Planner — plan documents

```typescript
export interface PlannerOutput {
  plan: string           // markdown content for plan.md
  test_plan: string      // markdown content for test-plan.md
  build_plan?: string    // markdown content for build-plan.md (deep/research only)
  categories: string[]   // recommended validation categories
  sharding_proposal?: ShardingProposal
}
```

The `ShardingProposal` type already exists in dag-node-reference.md (lines 203-211). It moves to types.md as a canonical definition.

#### Tester — test scripts with metadata

```typescript
export interface TesterOutput {
  scripts: TestScript[]
}

export interface TestScript {
  category: string
  path: string             // e.g., "scripts/test_functional.ts"
  content: string          // full script source
  language: 'typescript' | 'shell'
  run_command: string      // e.g., "npx ts-node scripts/test_functional.ts"
}
```

The runtime JSON output format (currently defined only in the Tester prompt at prompt-templates.md:372-388) stays as-is — that's what the script *produces* at execution time. The `TesterOutput` above is what the Tester *agent* returns to the DAG runner.

#### Builder — declarative file operations (critical new schema)

```typescript
export interface BuilderOutput {
  files: FileOperation[]
  summary: string
  conflicts?: ConflictWarning[]
}

export type FileOperation =
  | CreateFile
  | ReplaceFile
  | PatchFile
  | SymbolReplace
  | DeleteFile
  | RenameFile
  | CreateExecutable

export interface CreateFile {
  type: 'create'
  path: string
  content: string
}

export interface ReplaceFile {
  type: 'full_replace'
  path: string
  content: string
}

export interface PatchFile {
  type: 'patch'
  path: string
  hunks: PatchHunk[]
}

export interface PatchHunk {
  search: string
  replace: string
}

export interface SymbolReplace {
  type: 'symbol_replace'
  path: string
  symbol: string           // function name, class name, or export identifier
  content: string          // full replacement for the symbol
}

export interface DeleteFile {
  type: 'delete'
  path: string
}

export interface RenameFile {
  type: 'rename'
  from: string
  to: string
}

export interface CreateExecutable {
  type: 'create_executable'
  path: string
  content: string
  run_command: string      // command the Executor uses to run this script
}

export interface ConflictWarning {
  path: string
  reason: string
  severity: 'error' | 'warning'
}
```

Design decisions for each operation type:

| Operation | When to use | Why |
|-----------|------------|-----|
| `create` | New files that don't exist yet | Explicit intent — DAG runner rejects if file exists |
| `full_replace` | Replacing entire file content | Simplest model. Works well for small-to-medium files. DAG runner can warn on large replacements. |
| `patch` | Surgical edits to existing files | Search/replace hunks. More reliable than line numbers (which drift between context snapshot and application). Agent includes enough surrounding context in `search` to uniquely identify the target. |
| `symbol_replace` | Replacing a specific function/class | Language-aware. MVP: regex-based resolution. Post-MVP: AST-based. Agent provides the symbol name and full replacement content. |
| `delete` | Removing files | Destructive — DAG runner flags for review if the file was not created in this cycle. |
| `rename` | Moving/renaming files | Destructive — same guard as delete. |
| `create_executable` | Instrumented test scripts | Builder produces these alongside implementation. `run_command` tells the Executor how to execute. |

#### Debugger — enriched FailureReport

```typescript
export interface FailureReportRich {
  cycle: number
  iteration: number
  failed_categories: FailedCategory[]
}

export interface FailedCategory {
  name: string
  phase: 'llm' | 'executable' | 'both'
  root_causes: RootCause[]
  symptoms: string[]
  priority: 'high' | 'medium' | 'low'
}

export interface RootCause {
  description: string
  evidence: string
  fix_recommendation: string
}
```

This replaces the simpler `FailureReport` currently in types.md (lines 547-555). The rich version already exists in prompt-templates.md (lines 490-504). This DDR makes it canonical.

#### Evaluator — structured verdict

```typescript
export interface EvaluatorOutput {
  verdict: 'satisfied' | 'partially_satisfied' | 'not_satisfied'
  intent_alignment: string
  requirements_assessment: RequirementAssessment[]
  strengths: string[]
  gaps: string[]
  recommendations: string[]
}

export interface RequirementAssessment {
  requirement_id: string
  status: 'satisfied' | 'partially_satisfied' | 'not_satisfied'
  evidence: string
  notes: string
}
```

Already defined in prompt-templates.md:551-561. Now canonical in types.md.

#### Critic — structured critique

```typescript
export interface CritiqueResult {
  pass: boolean
  blocking_issues: BlockingIssue[]
  warnings: CriticWarning[]
  suggestions: string[]
}

export interface BlockingIssue {
  description: string
  impact: string
  recommendation: string
}

export interface CriticWarning {
  description: string
  context: string
}
```

Already defined in prompt-templates.md:612-625. Now canonical in types.md.

#### Historian — audit entry

```typescript
export interface HistorianEntry {
  timestamp: string        // ISO 8601
  cycle: number
  iteration: number
  node: string
  content: string          // 2-3 sentence summary
}
```

#### Facilitator — mode-dependent output

```typescript
export type FacilitatorOutput =
  | FacilitatorChatOutput
  | FacilitatorDecisionOutput
  | FacilitatorScopingOutput

export interface FacilitatorChatOutput {
  mode: 'chat'
  message: string
}

export interface FacilitatorDecisionOutput {
  mode: 'decision'
  gate: 'confirm' | 'sharding_approval'
  presentation: string     // formatted context for user
  available_actions: string[]
}

export interface FacilitatorScopingOutput {
  mode: 'scoping'
  message: string
  charter?: CycleCharter   // produced on final round
  tags_applied?: TagAction[]
}

export interface CycleCharter {
  scope: string
  purpose: string
  requirements: string
  boundaries: string
  version_bump: 'major' | 'minor' | 'patch'
  deferred_items: string[]
}

export interface TagAction {
  action: 'add' | 'remove'
  target_type: 'node' | 'layer' | 'group'
  target_id: string
  tag: string              // e.g., "#next-cycle", "#scope:abc"
}
```

### 3. DAG runner validation for BuilderOutput

Before applying any file operations, the DAG runner performs:

1. **Schema validation** — Zod parse against `BuilderOutput`. Reject on parse failure.
2. **Path validation** — all paths relative to project root. Reject `..`, `.sle/`, absolute paths.
3. **Conflict detection** — check for overlapping paths across shards (when SHARDING_APPROVAL was used).
4. **Create guard** — `create` rejects if file already exists. Use `full_replace` or `patch` for existing files.
5. **Deletion guard** — `delete` and `rename` require DAG runner approval if the file was not created in this cycle.
6. **Size guard** — individual file content exceeding a configurable threshold (default: 50KB) produces a warning.
7. **Patch application** — `search` string must match exactly once. Fail if 0 matches (context drifted) or 2+ matches (ambiguous).
8. **Symbol resolution** — MVP: regex-based (`export (function|const|class|interface|type) {symbol}\b`). Post-MVP: language-aware AST resolution.

On validation failure, the DAG runner produces a structured error fed back to the Builder as retry context (same as current iteration loop).

### 4. Sharding integration

When SHARDING_APPROVAL splits work into tasks, each task's Builder invocation produces its own `BuilderOutput`. The DAG runner:

1. Validates each manifest independently.
2. Checks for path conflicts across shards (`ConflictWarning` on overlapping paths).
3. Applies in dependency order (defined by `ShardingProposal.tasks[].dependencies`).
4. Produces a merged `BuilderOutput` for the artifact store.

### 5. Instrumented test scripts

Builder's current contract says it produces "instrumented test scripts" alongside implementation. With the new schema, these are `CreateExecutable` operations:

```typescript
{
  type: 'create_executable',
  path: 'scripts/test_functional.ts',
  content: '// instrumented script...',
  run_command: 'npx ts-node scripts/test_functional.ts'
}
```

The `run_command` is what the Executor uses at the EXEC node. The script must produce the same JSON format the Tester defined (prompt-templates.md:372-388).

### 6. Relaxation of the filesystem constraint

The current constraint in prompt-templates.md:873-874:

> Templates must not instruct the agent to run commands, access the filesystem, or make network requests.

Replaced with:

> Agents produce typed, validated output declarations. The DAG runner applies mutations to the filesystem and routes execution to the Executor. Agents never access the filesystem, run commands, or make network requests directly.

The constraint is the same in effect — agents still don't touch the filesystem. The difference is that Builder's output now has a structured schema for declaring file operations, rather than an ambiguous "code files written to the source tree."

### 7. Constraint on prompt templates

Prompt templates for each role MUST reference the output schema by name. Example for Builder:

```
## Output format
Produce a BuilderOutput JSON object with file operations.
Each operation declares what to create, replace, patch, or delete.
The DAG runner validates and applies all operations.
```

This replaces the current unstructured "implementation code files written to the project source tree."

## Consequences

### Positive

- `AgentResult.output` is typed — compile-time guarantee that each role's output is structurally valid
- Builder output is inspectable, replayable, and shardable — every mutation is an explicit declaration
- DAG runner can validate before applying — catch invalid paths, ambiguous patches, missing files
- Sharding works naturally — each shard produces a `BuilderOutput`, DAG runner merges
- No sandbox, no tool-calling, no E2B needed for the core pipeline
- Existing schemas (Tester JSON format, CritiqueResult, FailureReport) are promoted from prompt instructions to canonical types
- FailureReport inconsistency resolved — single rich schema replaces the two competing versions

### Negative

- Builder must produce valid JSON containing file content — token cost increases for large files
- `patch` and `symbol_replace` add complexity to the DAG runner (search/replace logic, symbol resolution)
- Prose-producing roles (Designer, Planner, Explorer) still have weak typing — the schema wraps markdown strings but doesn't validate their structure
- Builder's `full_replace` is inefficient for large files with small changes — but `patch` and `symbol_replace` address this

### Risks

- Patch search strings may fail to match if the codebase drifts between context snapshot and application — mitigation: DAG runner reports the drift as structured error, Builder retries
- Symbol resolution in MVP (regex) may be fragile for complex code — mitigation: post-MVP AST resolver
- JSON-wrapping file content may hit token limits for very large files — mitigation: sharding breaks work into smaller units; `symbol_replace` targets individual symbols

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| OC-001 | Should `symbol_replace` support nested symbols (e.g., methods within a class)? | Builder expressiveness | Open — MVP: top-level exports only. Post-MVP: nested resolution. |
| OC-002 | Should the DAG runner support dry-run mode (validate + diff without applying)? | Developer experience, debugging | Open — likely yes, but scope is post-MVP. |
| OC-003 | Should `CreateExecutable.run_command` support multi-command scripts (e.g., build + test)? | Executor complexity | Open — MVP: single command. Post-MVP: command array with sequential execution. |
| OC-004 | Should `PatchFile` support a `fuzzy` mode for approximate matching? | Patch robustness | Open — risky (silent misapplication). Lean toward exact match + retry on failure. |
| OC-005 | What is the maximum practical file size for `full_replace` before sharding is required? | Builder token budget | Open — needs empirical testing. Initial heuristic: 500 lines or 10KB per file operation. |
| OC-006 | Should Designer/Planner outputs eventually become structured JSON (e.g., architecture as component tree, plan as step array)? | Type safety for prose roles | Open — current markdown wrapping is pragmatic. Structured formats can be introduced per-role as needed. |
| OC-007 | How does the DAG runner handle `create` for a file that exists from a prior cycle but is being rewritten? | Builder ergonomics | Open — likely: if the file was created in a prior cycle, Builder should use `full_replace` (not `create`). The DAG runner can auto-coerce `create` → `full_replace` with a warning for prior-cycle files. |
