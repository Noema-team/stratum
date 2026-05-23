# Vertical Slice 4: Hardened Infrastructure & APIs

**Type:** implementation plan · **Status:** not started · **Updated:** 2026-05-23  
**Slice:** v4 · **Prerequisites:** VS3 Complete (Real subprocess EXEC, multi-turn agents, debugger loop)

---

## 🗺️ 1. Overview

This implementation plan defines the rigorous engineering tasks to align the core execution plane, memory indexes, and REST interface of **Stratum v2** with the technical specifications. We tackle core infrastructure security and context retrieval efficiency in a single combined hardened phase, ensuring the platform's foundation is production-grade before we add concurrency or user interface shells.

### 🎯 Target Specifications Reference
*   **Job Dispatch:** [job-dispatch.md](../specs/job-dispatch.md) (worker pools, jobs, Docker mounts, resource limits)
*   **Validation Gate:** [validation.md](../specs/validation.md) (tri-phase sub-phases, category statuses, deterministic gates)
*   **Link Indexing:** [document-linking.md](../specs/document-linking.md) (LinkIndex, forward-links, backlinks, wikilinks, typed refs)
*   **Context Manager:** [context-manager.md](../specs/context-manager.md) (five-component assembly, budgeting, `SliceRule` rules)
*   **Daemon API:** [daemon-api-endpoints.md](../specs/daemon-api-endpoints.md) (REST envelopes, status transitions, Zod schemas)

---

## 🔗 2. Dependency Map

### Files to Consume / Create

```directory
src/
├── exec-service.ts           # Replaced: host execution -> Docker Worker Pool Dispatcher
├── context-manager.ts        # Extended: basic slicing -> Link Index graph assembly & 5-component token budgeting
├── daemon.ts                 # Refactored: response envelopes & endpoints matching specs exactly
├── types.ts                  # Extended: LinkIndex, AssembledContext, job & validation schemas
└── tests/                    # Core integration and security test suites
```

---

## 🛠️ 3. Phases

---

### Phase A: Job Dispatch & Worker Pools (`specs/job-dispatch.md`)

**Goal:** Implement a fully sandboxed execution pool that queues, prioritizes, and executes validation checks inside isolated Docker containers using a stateful `WorkerPool`.

#### Technical Specifications Mapping
1.  **Job Schema:**
    ```typescript
    export interface Job {
      id: string;
      type: 'static-check' | 'llm-check' | 'exec-check' | 'task-execution';
      status: 'queued' | 'preparing' | 'running' | 'collecting' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
      priority: 0 | 1 | 2 | 3; // 0 = Critical (static-check), 1 = High, 2 = Normal, 3 = Low
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
      cycle_id: string;
      iteration: number;
      run_id: string;
      category: string | null;
      sub_phase: 'static-check' | 'llm-check' | 'exec-check' | null;
      container_id: string | null;
      context_pack_path: string | null;
      result: JobResult | null;
      error: JobError | null;
    }
    ```
2.  **Worker Pool Configuration:**
    *   `max_workers`: `min(os.cpus().length, 8)`
    *   `idle_timeout_ms`: `30000` (drains and stops idle containers)
    *   `container_startup_timeout_ms`: `60000`
3.  **Mount Spec (Strict Mount Table):**
    *   `{run_dir}` $\rightarrow$ `/sle/run` (Read-Write)
    *   `{project_root}` $\rightarrow$ `/sle/project` (Read-Only)
    *   `{scripts_dir}` $\rightarrow$ `/sle/scripts` (Read-Only)
    *   `{context_pack_path}` $\rightarrow$ `/sle/context/context-pack.md` (Read-Only)
4.  **Resource Limits:**
    *   Memory: `512MB` (`--memory="512m"`)
    *   CPU: `1.0` (`--cpus="1.0"`)
    *   Network: Disabled (`--network none`)

**Files to modify/create:**
*   `src/exec-service.ts` (rewrite to manage Docker client and pool execution)
*   `src/types.ts` (add Job and Worker interfaces)
*   `tests/exec-service.test.ts`

**Tests to Write (target: 12):**
*   Queue releases Critical priority `static-check` jobs first.
*   Worker pool starts, registers idle workers, and assigns jobs.
*   Network access inside container is blocked.
*   Memory limits are enforced (trigger OOM exception mapping).
*   Heartbeat failures drain and mark unresponsive workers as `dead`.

---

### Phase B: Tri-Phase Validation Gate (`specs/validation.md`)

**Goal:** Implement the sequential `static-check` $\rightarrow$ `llm-check` $\rightarrow$ `exec-check` validation runner, 10 categories, category caching, and the deterministic `VALIDATION_GATE` evaluator.

#### Technical Specifications Mapping
1.  **Tri-Phase Sequence Invariant:**
    *   Execute `static-check` globally first.
    *   If `static-check` fails (lint errors $>0$ or type-check errors $>0$), all downstream `llm-check` and `exec-check` jobs for that iteration are marked `skipped` immediately.
2.  **Pass Criteria Evaluation:**
    *   `ValidationMethod` is parsed per category from `validation.yaml`.
    *   Verdicts computed strictly on standard output objects:
        ```typescript
        export interface CategoryRunResult {
          category: string;
          phase: 'executable' | 'llm' | 'static';
          passed: boolean;
          tests: Array<{ id: string; passed: boolean; message?: string }>;
          duration_ms: number;
        }
        ```
    *   Deterministic Validation Gate: Evaluates results and writes a canonical `RunManifest` to `.sle/runs/{run_id}/run-manifest.json`.

**Files to modify:**
*   `src/exec-gate.ts` (implements the validation logic)
*   `src/types.ts` (add CategoryRunResult and RunManifest schemas)
*   `tests/exec-gate.test.ts`

**Tests to Write (target: 10):**
*   Global `static-check` failure skips all categories' LLM and Exec runs.
*   Both-method category passes only if both LLM and Exec phases pass.
*   Gate verdict evaluates correctly without any LLM intervention.
*   Deterministic Zod schema validation of the `RunManifest`.

---

### Phase C: Semantic Trace-Link Index (`specs/document-linking.md`)

**Goal:** Implement the persistent trace-link index using canonical `doc:{key}` and `node:{group}:{key}` addresses, manual `[[wikilink]]` syntax parsing, and backlinks computation.

#### Technical Specifications Mapping
1.  **Storage Schema:**
    Persisted to disk under `.sle/link-index/` as three clean files:
    *   `forward-links.json`: Array of `ForwardLink` definitions containing source and target references.
    *   `file-index.json`: Key-value map of file paths to active link targets.
    *   `document-index.json`: Key-value map of project document keys to targets.
2.  **Backlink Computation:**
    Computed in-memory upon startup or link mutations:
    ```typescript
    export interface Backlink {
      from: LinkSource;
      context: string;
      link_type: 'structural_dag' | 'structural_declaration' | 'contextual_execution' | 'manual';
      resolved_label: string;
    }
    ```
3.  **Wikilink Parser:**
    Analyze markdown files recursively on cycles, extracting double bracket wikilink syntax: `[[doc:requirements]]` or `[[node:auth:test-plan|Authentication Spec]]`.

**Files to modify/create:**
*   `src/link-index.ts` (new - manages file writes and backlink compilation)
*   `src/wikilink-parser.ts` (new - regex parser for manual wikilinks)
*   `tests/link-index.test.ts`

**Tests to Write (target: 14):**
*   Index persists and loads correctly from `.sle/link-index/`.
*   Link additions successfully trigger bidirectional backlink recompilation.
*   Manual wikilink parser correctly extracts multiple custom target names.
*   Wildcard formats (`node:*:{key}`) resolve successfully to active targets.

---

### Phase D: Five-Component Context Manager (`specs/context-manager.md`)

**Goal:** Replace basic text slicing with the strict, token-bounded **Five-Component Context Window** assembly and enforce `SliceRule` priority weights.

#### Technical Specifications Mapping
1.  **Component Budgets (Hard Ceiling: 3,500 tokens):**
    1.  *System Prompt* (~500 tokens)
    2.  *Artifact Slices* (~2000 tokens)
    3.  *State Summary* (~300 tokens)
    4.  *Task Details* (~200 tokens)
    5.  *Failure Context* (~400 tokens) - replaces passing categories' budgets on retry iterations.
2.  **Truncation Priorities (`SliceRule`):**
    When the token ceiling is exceeded, content is sliced in descending priority according to `source_weight`:
    *   `inferred` weights are truncated first.
    *   `cycle_produced` weights are truncated second.
    *   `user_defined` weights are never truncated.

**Files to modify:**
*   `src/context-manager.ts` (implement the five-component assembly and budgeting logic)
*   `tests/context-manager.test.ts`

**Tests to Write (target: 10):**
*   Window assembled in exact order (System $\rightarrow$ Slices $\rightarrow$ State $\rightarrow$ Task $\rightarrow$ Failure).
*   Token ceiling of 3,500 is strictly guarded.
*   Low-weight slices are truncated first under resource constraints.
*   TDD constraint enforced: Tester never receives Builder outputs.

---

### Phase E: API Contract Compliance (`specs/daemon-api-endpoints.md`)

**Goal:** Align existing endpoints in `src/daemon.ts` with their exact specifications, wrapping all request/response objects in Zod validation schemas.

#### Endpoint-by-Endpoint Schema Mapping

| Route | Spec Location | Payload Schema Requirement | Response envelope |
| :--- | :--- | :--- | :--- |
| `GET /api/v2/health` | §Health check | None | `{ ok: true, data: { status: "healthy", uptime_ms: number, version: string } }` |
| `GET /api/v2/info` | §Daemon info | None | `{ ok: true, data: DaemonInfo }` |
| `GET /api/v2/system/state` | §Get system state | None | `{ ok: true, data: SystemState }` |
| `POST /api/v2/system/state/transition` | §Transition state | `{ target: State, trigger: string }` | `{ ok: true, data: { previous: State, current: State } }` |
| `POST /api/v2/init` | §Init project | `{ project_root: string, force?: boolean }` | `{ ok: true, data: { initialized: boolean } }` |
| `POST /api/v2/cycles/start` | §Start cycle | `{ intent: string, depth: string }` | `{ ok: true, data: CycleRecord }` |
| `GET /api/v2/cycles/current` | §Get current cycle | None | `{ ok: true, data: CycleRecord }` |
| `POST /api/v2/cycles/halt` | §Halt cycle | None | `{ ok: true, data: { halted: boolean } }` |

**Files to modify:**
*   `src/daemon.ts`
*   `tests/daemon-api.test.ts`

**Tests to Write (target: 12):**
*   Malformed payload triggers standard `APIError` envelope.
*   Transition states reject illegal state paths.
*   Request metadata envelopes populated with correct UUIDs and ISO timestamps.
