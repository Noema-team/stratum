# Error Codes

**Type:** reference · **Status:** draft · **Updated:** 2026-04-22

Authoritative error code reference for the SLE system. Every failure mode has a
code, a detection condition, a severity, and a defined recovery path.

System states: `idle | discovering | cycling | halted | complete`.
`confirming` is `cycle.awaiting_confirmation` (boolean flag), not a state (DDR-021).
`chatting` is not a state — chat is an orthogonal session (G20 resolution).

AgentRole set: Designer, Explorer, Planner, Tester, Builder, Debugger, Evaluator,
Critic, Historian, Facilitator.

---

## Severity definitions

| Severity | Daemon action | User visibility | Cycle impact |
|---|---|---|---|
| **critical** | Halt or refuse operation | Blocking alert | Cannot proceed until resolved |
| **error** | Retry or degrade; may halt iteration | Error notification | Iteration may fail; next iteration recovers |
| **warning** | Continue with degraded quality | Warning banner | No impact; logged for review |

---

## Code ranges

| Range | Subsystem | Count |
|---|---|---|
| E001–E009 | Daemon lifecycle | 9 |
| E010–E019 | DAG execution | 10 |
| E020–E029 | Validation | 10 |
| E030–E039 | Context manager | 5 |
| E040–E049 | Agents — LLM runtime | 8 |
| E050–E069 | Agents — role-specific | 18 |
| E080–E089 | Intake / sharding | 10 |
| E090–E099 | Beads integration | 10 |
| E100–E109 | Init | 10 |
| E110–E119 | Discovery | 10 |
| E120–E129 | Job dispatch / Docker | 10 |
| | **Total** | **110** |

---

## State reference for error detection

Errors that check system state use the following values from `map.yaml → meta.status`:

| State | Meaning | Transitions to |
|---|---|---|
| `idle` | No active session. Daemon running, ready. | `discovering` (sle discover), `cycling` (sle start) |
| `discovering` | Discovery session running. | `idle` (complete or halt) |
| `cycling` | Development cycle executing. May have `awaiting_confirmation` flag set. | `halted` (error/cap/halt), `complete` (success), `idle` (after snapshot) |
| `halted` | Cycle stopped before completion. | `idle` (after user acknowledgement), `cycling` (resume) |
| `complete` | Cycle finished, snapshot locked. | `idle` (automatic after snapshot) |

### What is NOT a state

| Removed value | Correct model | Why |
|---|---|---|
| `running` | `cycling` | `running` was ambiguous — running what? Replaced by precise `cycling`. |
| `awaiting_approval` | `cycle.awaiting_confirmation = true` | Confirmation is a sub-state of cycling, not a peer state (DDR-021). |
| `confirming` | `cycle.awaiting_confirmation = true` | Same as above. `meta.status` stays `cycling`. |
| `chatting` | Orthogonal session, not a state | Chat is always available regardless of system state (G20). Tracked by `map.yaml → chat.session_open`. |

---

## E001–E009 — Daemon lifecycle

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E001 | daemon_not_running | Any CLI or interface command; connection refused on `ws://localhost:7700` or `http://localhost:7700`. | critical | `sle daemon start` or `sle daemon status`. If crashed, check `.sle/daemon.log`. No cycle impact — no cycle runs without daemon. |
| E002 | daemon_crash_mid_cycle | On restart, `.sle/session-state.json` exists and previous PID is dead. `meta.status` is `cycling` or `discovering`. | critical | Step 1 — auto stale claim resolution (E091). Step 2 — user prompt: (1) resume from last Historian commit, (2) halt and write partial report, (3) restart from beginning. At worst one agent turn re-executed. |
| E003 | port_in_use | `sle daemon start` called and port 7700 occupied by another process. | critical | `sle daemon start --port 7701` or `lsof -ti:7700 \| xargs kill`. If another SLE daemon: `sle status`. |
| E004 | docs_remote_unreachable | Startup validation or version snapshot cannot reach docs git remote. | warning | Degraded mode: local artifact reads available, writes queued, snapshot blocked. Push manually: `cd .server && git push origin main`. Cycle completes locally. |
| E005 | beads_remote_unreachable | `bd push` or `bd pull` fails due to network or DoltHub issues. | warning | Cycle continues with local Beads state. Sync retried on next trigger. Manual: `bd push origin`. |
| E006 | session_state_corrupted | `.sle/session-state.json` exists but is not valid JSON or missing required fields (`session_id`, `daemon_pid`, `claimed_task`). | error | Delete corrupt file. If `meta.status` is `cycling`, treat as E002 crash recovery. If `idle`, no further action. Log corruption event. |
| E007 | invalid_state_transition | Requested state transition violates the state machine. Examples: `cycling → discovering`, `halted → complete`, `idle → confirming`. | critical | Transition rejected. Current state preserved. Log source state, target state, and caller. If repeated, daemon logic has a bug. |
| E008 | discovery_incomplete | `POST /cycle/start` called but `map.yaml → discovery.status` is not `complete`. | critical | Run discovery first: `sle discover`. Check: `sle status`. Cycles require discovery artifacts. |
| E009 | daemon_version_mismatch | `map.yaml → meta.sle_version` differs from running daemon and schema migration needed. | warning | Auto-migration attempted. If fails, manual: `sle daemon migrate`. map.yaml backed up before migration. |

---

## E010–E019 — DAG execution

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E010 | rule_file_invalid | Daemon startup finds malformed YAML in `.sle/rules/`. Includes schema violations, invalid enum values, missing required fields. | critical | Daemon refuses to start. Error includes file path, line number, valid values. Fix and `sle daemon start`. |
| E011 | required_artifact_missing | A `required: true` artifact does not exist at cycle start (expected after first cycle). | warning | Context manager assembles reduced slice noting absent artifacts. Planner instructed to produce missing ones. Normal for first cycle. |
| E012 | map_yaml_write_conflict | Two processes attempt simultaneous `map.yaml` write. Detected via advisory lock `.sle/map.yaml.lock`. | warning | Retry 3x with exponential backoff (500ms base). If exhausted, cycle halts with outcome `error`. May indicate two daemons: `ps aux \| grep sle`. |
| E013 | artifact_store_write_failure | Write to `docs/` fails — permissions, disk full, or broken symlink. | critical | Retry once. If fails, cycle halts. Writes are atomic (temp file + rename). Check: `ls -la docs`, `.server/docs/` writable, `df -h`. |
| E014 | concurrent_cycle_attempt | `POST /cycle/start` while `meta.status` is not `idle`. Status is `cycling`, `discovering`, or `halted`. | critical | New cycle rejected. Running cycle continues. Error includes cycle, iteration, status, current node. Halt: `sle halt`. |
| E015 | map_yaml_status_inconsistency | On start, `meta.status` is `cycling` but daemon PID file references dead process. | error | Previous crash assumed. User prompt: (1) resume from last committed state, (2) halt and reset to `idle`, (3) `sle status --raw`. |
| E016 | artifact_hash_mismatch | Version snapshot finds artifact on disk does not match what agent wrote (externally modified during cycle). | error | Snapshot paused. Prompt: (1) use current file, (2) restore cycle version, (3) halt for manual review. |
| E017 | dag_node_order_violation | DAG runner executes a node whose prerequisites have not completed. Checked via `cycle.nodes_completed`. | critical | Node rejected. Log expected vs actual prerequisites. Internal daemon bug — not user-actionable. |
| E018 | iteration_cap_exceeded | VALIDATION gate fails and iteration counter ≥ `cycle.max_iterations`. `exit.yaml → on_cap_hit` fires. | error | Cycle halts with outcome `halted`. Partial report written. Beads task returned to open pool with failure context. |
| E019 | revision_cap_exceeded | User modifies plan at CONFIRM gate beyond revision limit (default: 5 per iteration). | error | Pause at CONFIRM. Prompt: approve current / halt / reset counter. Prevents infinite plan revision loops. |

---

## E020–E029 — Validation

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E020 | test_script_not_found | VALIDATION gate references a test script that does not exist in `scripts/`. Builder may have failed silently. | error | Category fails (`missing_executable`). FailureReport notes missing script. Planner instructs Builder to generate it on next iteration. |
| E021 | test_script_timeout | Script runs longer than `executable.timeout_ms` from `validation.yaml`. | error | Partial JSON extraction from stdout. If extractable, used with `partial` flag. Otherwise category fails (`timeout`). FailureReport includes timeout and partial metrics. |
| E022 | test_script_runtime_error | Script throws uncaught exception or exits non-zero without JSON on stdout. | error | stderr captured in FailureReport. Category fails (`runtime_error`). Planner receives error message and stack trace on next iteration. |
| E023 | test_script_invalid_json | Script exits 0 but stdout not valid JSON or lacks required `verdict`/`confidence` fields. | error | Lenient extraction (first `{` to last `}`). If extraction succeeds with valid structure, proceed. Otherwise category fails (`invalid_output`). |
| E024 | validation_category_not_found | `validation.yaml` references a category with no matching entry in categories array, or script path is empty. | error | Category skipped with warning. Gate proceeds with remaining categories. If none remain, cycle halts. Fix `validation.yaml`. |
| E025 | docker_container_failure | Execution container fails to start, crashes, or is unresponsive during exec-check or static-check. | error | All container-dependent categories fail. Retry once with fresh container. If persistent, cycle halts. Check Docker: `docker ps`. |
| E026 | static_check_failure | Static analysis (lint, typecheck, complexity) fails for one or more categories. By design, llm-check and exec-check are skipped for the failed category. | error | Violations in FailureReport with specific lint/type errors. Planner receives details. Next iteration focuses on fixing static violations first. |
| E027 | validation_gate_evaluation_failure | Gate cannot produce pass/fail — all category results missing, malformed, or contradictory. | critical | Gate defaults to fail. Full diagnostic logged. Indicates rule file misconfiguration or execution plane bug. |
| E028 | confirmation_gate_timeout | `cycle.awaiting_confirmation = true` and no user response within configured timeout (from `user_validation.yaml`). | warning | Daemon emits reminder event. After extended timeout (2x initial), cycle auto-halts. Resume later: `sle start --resume`. |
| E029 | confirmation_gate_invalid_response | User response to CONFIRM gate fails schema validation — unknown decision value, missing fields, invalid categories. | error | Response rejected. User re-prompted with valid options. Cycle remains `cycling` with `awaiting_confirmation = true`. |

---

## E030–E039 — Context manager

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E030 | context_budget_exceeded | Assembled context exceeds token budget (hard cap: 4000 tokens for artifact content, per SLE-007). Sum of all component slices + system prompt exceeds model context window. | warning | Progressive trimming: Component 5 (failure context) first, then Component 4 (evaluation), then Component 3 (recent decisions). Components 1–2 (requirements + architecture) never trimmed. Actual vs budget logged. |
| E031 | artifact_slice_not_found | Context manager loads a declared artifact that is missing on disk, or a section anchor referenced but not found in document. | warning | Placeholder substituted noting absence. Assembly continues with available slices. If Component 1 missing, agent explicitly warned. |
| E032 | context_assembly_failed | Unrecoverable error during assembly: circular artifact references, file encoding errors, or multi-artifact disk I/O failure. | critical | Agent call aborted. Iteration abandoned, counter increments. If repeated, cycle halts. Check artifact file integrity and encoding. |
| E033 | link_index_query_failure | Link index (SLE-017 backlink engine) query fails — not initialised, corrupted, or returns unexpected types. | warning | Assembly proceeds without link data. Agent receives reduced context. Index rebuilt on next artifact save. Manual: `sle index rebuild`. |
| E034 | resolver_mode_resolution_failed | Context manager in resolver mode (declared tasks) cannot resolve a `TaskContextDeclaration`: document ID not found, section does not exist, source file path invalid. | error | Unresolved references replaced with placeholders. Agent warned about missing context. If >50% unresolvable, agent call skipped and task flagged for re-declaration. |

---

## E040–E049 — Agents: LLM runtime

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E040 | llm_call_timeout | LLM call does not return within configured timeout (default: 120s per call). | warning | Retry once. If second attempt times out, iteration abandoned and counter increments. Error includes role and attempt count. Persistent: check API key, network, provider status. |
| E041 | llm_invalid_json | LLM validation sub-phase (llm-check) returns output that cannot be parsed as expected JSON structure. | warning | Lenient extraction (first `{` to last `}`). If yields `verdict` + `confidence`, proceed. Otherwise category fails (confidence 0.0, reason `invalid_response`). Planner receives context. |
| E042 | llm_confidence_below_threshold | LLM returns `verdict: pass` but `confidence` is below configured `pass_threshold`. | warning | Treated as fail. Gate receives fail with confidence score. FailureReport notes confidence-fail. Planner receives context on next iteration. |
| E043 | llm_rate_limited | LLM provider API returns 429 rate limit response. | warning | Wait `Retry-After` header duration, then retry. No iteration increment. If persists >5min, cycle auto-pauses. Manual halt: `sle halt`. No state lost on pause. |
| E044 | llm_auth_failure | LLM provider returns 401 or 403 — invalid API key, expired token, billing issue. | critical | Cycle halts immediately. No retry — auth failure not transient. Check API key in environment or `agents.yaml`. Verify provider billing. |
| E045 | agent_output_schema_violation | LLM succeeds but structured output mismatches expected role schema: missing required fields, wrong types, out-of-range values. | error | Retry once with explicit schema instruction in prompt. If fails, iteration counter increments. Error includes role, expected schema, actual output. |
| E046 | agent_forbidden_artifact_write | Agent output references or attempts to modify artifact outside its declared scope. E.g., Tester referencing `architecture.md`, Builder writing to `requirements.md`. | critical | Write rejected. Output discarded. Retry once with explicit scope reminder. If repeated, iteration fails. Error includes role, forbidden artifact, allowed list. |
| E047 | llm_context_window_exceeded | Assembled prompt (system + artifacts + intent) exceeds the model's context window limit. | error | Re-assemble with aggressive trimming (drop Component 5, summarise 4, reduce 3). If still exceeds after trimming, cycle halts. Reduce document sizes or adjust budgets in `agents.yaml`. |

---

## E050–E069 — Agents: role-specific

### Designer (E050–E052)

The Designer owns architecture output at the DESIGN node. It receives requirements,
prior architecture, and decisions. Critic reviews its output at `deep`/`research`
planning depth.

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E050 | designer_circular_dependencies | Architecture output contains unresolvable circular dependencies between components. Static analysis on architecture detects cycles in the component dependency graph. | error | Architecture rejected. Designer re-prompted with the specific cycle path and asked to resolve. If unresolved, Critic (if active at current depth) reviews and suggests alternatives. Retry within same turn — iteration does not increment. |
| E051 | designer_constraint_violation | Architecture violates explicit constraints from discovery documents (`constraints.md`, `system-description.md`). Detected by comparing output against constraint declarations. | error | Architecture flagged with specific violated constraints. Designer prompted to revise. At `deep`/`research` depth, Critic activated. If unresolved after 2 retries, iteration fails and Planner receives violation context. |
| E052 | designer_missing_components | Architecture does not address all components required by user intent and requirements. Cross-reference between intent, requirements sections, and architecture sections finds gaps. | warning | Architecture accepted with warning. Missing components listed in Planner context. If critical components missing (determined by intent analysis), architecture rejected and Designer re-prompted. |

### Explorer (E053–E055, E068)

The Explorer runs conditionally at the EXPLORE node when unknowns are flagged in
the user intent. It produces research findings injected into the Designer's context.
EXPLORE is skipped if no unknowns are detected — the cycle proceeds directly to
DESIGN.

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E053 | explorer_research_timeout | EXPLORE node exceeds configured time budget (default: configurable in `agents.yaml`, suggested 300s). | warning | Partial findings captured. Explorer forced to produce summary of findings so far, even if incomplete. Designer receives partial research with truncation note. Cycle continues — EXPLORE is conditional, not blocking. |
| E054 | explorer_resource_inaccessible | Explorer requires access to external resource (API docs, repository, benchmark data) for spike but cannot reach it — network failure, 403, or resource not found. | warning | Explorer proceeds with available information. Missing resource noted in research findings. Designer receives context noting the gap. User may provide resource manually or adjust intent. |
| E055 | explorer_no_findings | Explorer completes research phase but produces no actionable findings — empty output or only restatements of the intent. | warning | EXPLORE completes with empty findings. Designer proceeds without research input (same as if EXPLORE were not triggered). Warning logged. Consider whether unknowns flag was appropriate. |
| E068 | explorer_trigger_invalid | EXPLORE node activated (unknowns flagged) but intent contains no actionable unknowns, or heuristic score is below threshold. | warning | EXPLORE skipped. Cycle proceeds directly to DESIGN. Flag logged for intent quality review. User may need more specific intent on next cycle. |

### Tester (E056–E057)

The Tester writes tests from requirements only — it never sees the Builder's
implementation or the architecture. This is the TDD separation constraint. Tests
must be self-contained (no LLM calls, no network calls).

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E056 | tester_separation_violation | Tester produces a test that references the Builder's implementation or the architecture. Detected by scanning test output for source file imports not in test scaffold, or references to architecture-specific terms. | critical | Test rejected. Tester re-prompted with explicit constraint reminder: tests read only requirements and test-plan. No retry limit within the turn — Tester must produce clean tests before TEST node completes. |
| E057 | tester_not_self_contained | Tester produces a test that makes LLM calls, network calls to external services, or depends on runtime state not provisioned in test scaffold. | error | Test rejected with specific violation identified. Tester re-prompted. If cannot produce self-contained test after 2 retries, placeholder always-fail test inserted and Planner notified. |

### Debugger (E058–E060)

The Debugger runs at the DEBUG node after a VALIDATION gate failure. It is the
first consumer of run artifacts (SLE-022). It diagnoses failures and feeds its
output to the next PLAN node iteration.

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E058 | debugger_artifacts_missing | Run artifacts (`manifest.json` or `context-pack.md`) missing or malformed at DEBUG node. Files in `.sle/runs/{id}/` absent or unparseable. | error | Best-effort diagnosis from FailureReport summary alone (no detailed run data). Planner receives degraded diagnosis. If persistent, indicates EXEC phase bug — check `.sle/runs/` and Docker logs. |
| E059 | debugger_diagnosis_contradicts | Diagnosis is internally inconsistent or contradicts failure evidence — e.g., blames a passing component, claims timeout when evidence shows runtime error. | warning | Diagnosis accepted but flagged with confidence modifier. Planner receives both the diagnosis and the contradiction flag. May choose to ignore Debugger and rely on raw FailureReport. |
| E060 | debugger_cannot_reproduce | Debugger analysis concludes failure cannot be reliably reproduced — insufficient logs, missing traces, or non-deterministic failure. | warning | Probabilistic diagnosis with multiple hypotheses ranked by likelihood. Planner receives all hypotheses. At `deep`/`research` depth, Designer may be re-engaged to add instrumentation for next iteration. |

### Other roles (E061–E067)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E061 | critic_wrong_target | Critic at CRITIQUE node (active at `deep`/`research`) reviews artifact other than Designer's architecture — e.g., reviews the plan. | warning | Critique accepted but context corrected. Re-prompted once to review architecture only. If still wrong, output discarded. Cycle proceeds without critique. |
| E062 | planner_undefined_requirement | Plan references a requirement section or feature not present in `requirements.md`. Traceability check fails. | error | Plan rejected. Re-prompted with actual requirements list. If legitimate unmet need, Planner flags for Designer rather than inventing scope. |
| E063 | builder_missing_output | Builder output does not include all files declared in plan's implementation steps. Declared files checked against actual output. | error | Builder re-prompted with missing file list. If unresolved, EXEC will fail on missing scripts (E020), triggering normal iteration loop. |
| E064 | historian_append_failure | Write to `decisions.md` fails — file locked, encoding issue, or would create duplicate entry. | warning | Retry once. If fails, Historian entry for this turn skipped. Gap in audit trail. Cycle continues — Historian failure does not block DAG. |
| E065 | evaluator_missing_sections | Evaluator output lacks required sections: intent satisfaction verdict, requirements coverage, quality assessment. | error | Re-prompted once with section template. If still incomplete, evaluation proceeds with available sections. Gaps noted in artifact. |
| E066 | facilitator_discovery_interrupted | Discovery session interrupted — user disconnects, daemon restarts, or repeated Facilitator LLM failures during a round. | warning | Progress saved to `map.yaml → discovery.completed_rounds`. On reconnect/restart, resumes from last completed round. Partially completed round restarted. No data loss. |
| E067 | builder_architecture_violation | Builder code contradicts Designer architecture — introduces undeclared components, bypasses interfaces, violates layer boundaries. | error | Builder re-prompted with specific violation. If architecture is genuinely impractical, violation logged for Planner to adjust plan or architecture on next iteration. |

---

## E080–E089 — Intake / sharding

Errors from the document intake, coherence validation, and task sharding pipeline
(SLE-019). These apply when the pipeline is active (inline mode, standalone
pre-prime, or forced mode). In bypassed mode (`--no-intake`), these codes are
never emitted.

### Coherence gate (E080–E083)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E080 | coherence_contradiction | Layer 1 coherence check finds direct contradiction: a decision in Document A conflicts with a constraint in Document B. | error | Pipeline halted at coherence gate. User presented with documents, sections, and conflicting statements. No automatic resolution — user must resolve. |
| E081 | coherence_undefined_reference | Document references entity, section, or concept defined nowhere in the document set. | error | Blocking finding if load-bearing (referenced by 2+ downstream documents). Warning if tangential. User resolves or acknowledges. |
| E082 | coherence_terminology_conflict | Same concept has different names across documents, or different concepts share the same name. | warning | Non-blocking. User can acknowledge or resolve. Agents may produce inconsistent output if unresolved. |
| E083 | coherence_missing_document | Planned task scope requires a document (e.g., `architecture.md`) that does not exist in `.sle/project-docs/` or artifact store. | error | Pipeline halted. User provides missing document or reduces task scope. For first cycle: bypass with `--intake skip`. |

### Sharding (E084–E087)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E084 | sharding_scope_overlap | Two tasks declare the same `scope` (same file, module, or endpoint). Layer 2 task coherence detects duplicate ownership. | error | Proposal rejected. Re-shard with non-overlapping scopes. If overlap is genuine (shared module), merge tasks or extract shared module as separate task. |
| E085 | sharding_context_budget_exceeded | Task's `TaskContextDeclaration.estimated_tokens` exceeds agent context window budget (SLE-007 budget minus system prompt overhead). | error | Task split into smaller tasks with narrower context declarations. Fallback: use `summary_only` mode for large reference documents. |
| E086 | sharding_dependency_cycle | Proposed task set has circular dependency chain: A→B→C→A. | critical | Proposal rejected. Cycle must be broken by merging tasks or removing one dependency. User reviews dependency graph. |
| E087 | sharding_unverifiable_acceptance | Task acceptance criteria cannot be verified by Tester — vague language, subjective measures, or criteria requiring human judgement. | error | Task returned for revision. Rewrite as specific, measurable, pass/fail conditions. If genuinely needs human judgement, flag for review at CONFIRM gate. |

### Runtime coherence (E088–E089)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E088 | runtime_coherence_task_stale | Document declared in a task's context was modified after task creation. Layer 3 runtime coherence detects version mismatch. | warning | Task flagged `stale` in Beads (`STALE:` note in issue). Job dispatch paused for this task. User notified with changed document and affected tasks. Options: re-shard / update declarations / clear stale flag. |
| E089 | document_promotion_failure | System cannot promote a free-floating document — node ID collision, group not found, or link index write failure. | warning | Document stays `ungraphed`. Content still accessible to agents via direct path reference. Promotion retried on next artifact save. Manual: `sle docs promote {document_id}`. |

---

## E090–E099 — Beads integration

Errors from the Beads bridge (`@sle/sdk` internal module wrapping `bd` CLI).
Beads is the issue tracker for agent workflow — claim/close/unclaim operations
are the bridge between SLE cycles and Beads issues.

### Claim lifecycle (E090–E091, E097)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E090 | beads_claim_failed | `bd update --claim` fails — task already claimed by another agent, or task status changed since `bd ready` (race condition). | error | Planner selects next ready task from cached list. If no tasks remain, cycle halts: "No ready tasks. Create issues with `bd create`." |
| E091 | beads_stale_claim_startup | Daemon starts, `.sle/session-state.json` references dead PID — previous daemon claimed a task and crashed before resolving. | warning | Auto-resolve before user prompt: `bd comment` with crash context, `bd update --status open --assignee ""`. Task back in open pool. Always runs before E002 recovery prompt. |
| E097 | beads_unclaim_exit_failed | `resolveExit` calls unclaim/close and it fails — Beads unreachable at exact moment of cycle exit. Task left `in_progress`. | warning | Session state file preserved (not deleted). Next daemon start resolves via E091. Task is never permanently stuck. |

### Sync and queries (E092–E096)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E092 | beads_sync_failure | `bd push`/`bd pull` returns non-zero exit that is not a network error — Dolt merge conflict, schema mismatch, authentication failure. | warning | Sync deferred. Cycle continues with local state. Retry on next trigger (before `bd ready`, after `bd close`). Persistent: `bd push origin --force` or inspect Dolt conflict. |
| E093 | beads_task_not_found | DAG runner references a task ID but `bd show {id}` returns nothing — task deleted or ID from different project/prefix. | error | During claim resolution: create new task. During comment/close: skip and log. Session state cleaned up. |
| E094 | beads_dependency_resolution_failed | `bd ready` returns tasks but dependency graph is inconsistent — task depends on non-existent task, or circular deps in Beads. | warning | Skip unresolvable tasks, return available ones. Skipped tasks logged. User fixes manually: `bd dep remove {id} {dep_id}`. |
| E095 | beads_compact_failure | `bd compact` fails — LLM summarisation error or database write error. | warning | Compaction skipped. Old closed issues retain full content. Retry on next trigger (after 10 cycles or size threshold). No active cycle impact. |
| E096 | beads_bridge_subprocess_error | `bd` subprocess exits unexpectedly or stdout not valid JSON with `--json` flag. | error | Bridge method fails. Calling code handles based on context (retry or degrade). Persistent: check `bd --version` and Beads installation. |

### Sharding integration (E098–E099)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E098 | beads_sharding_create_failed | `bd create` fails during sharding pipeline (SLE-019 Part 4). One or more tasks could not be created as Beads issues. | error | Successful tasks remain. Failed tasks logged with declarations. User retries or creates manually. No rollback of successful creations. |
| E099 | beads_dep_wiring_failed | `bd dep add` fails during post-sharding dependency wiring — task ID not found or dependency already exists. | warning | Skip failed dependency. Tasks created but may appear in wrong order in `bd ready`. User wires manually: `bd dep add {child} {parent}`. Logged for follow-up. |

---

## E100–E109 — Init

Errors from `sle init` and the init API endpoints. These cover the one-time
project setup sequence from prerequisite checks through daemon start.

### Init sequence (E100–E109)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E100 | init_already_initialised | `.sle/` exists and `--reset` not set | critical | `sle init --reset` to reinitialise |
| E101 | init_no_git_repo | Not inside a git working tree | critical | `git init` or clone a repository |
| E102 | init_no_origin | No git remote named `origin` | critical | `git remote add origin <url>` |
| E103 | init_beads_failure | `bd init` returns non-zero exit | error | Check `.beads/` doesn't exist, permissions. Then: `sle init --resume` |
| E104 | init_docs_clone_failure | `git clone` for docs remote fails | error | Remote may not exist. Create it or skip: `sle init --resume` |
| E105 | init_commit_failure | `git commit` or `git add` fails | error | Check git status, permissions. Local state preserved: `sle init --resume` |
| E106 | init_push_failure | `git push origin` fails | warning | Local state is valid. Push manually: `git push origin main` |
| E107 | init_daemon_start_failure | Daemon process fails to start | error | Check port availability: `sle daemon start`. Init succeeds without daemon |
| E108 | init_state_corrupted | `.sle/init-state.json` exists but is invalid JSON | error | Delete file and re-run: `sle init` |
| E109 | init_task_store_unsupported | `--task-store` value is not `beads` or `local` | critical | Use `--task-store beads` or `--task-store local` |

---

## E110–E119 — Discovery

Errors from `sle discover` and the discovery API endpoints. These cover the
guided discovery flow (rounds, synthesis, planning).

### Discovery session (E110–E119)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E110 | discovery_already_complete | `sle discover` when `discovery.status` is `complete` | error | `sle discover --revisit` to revise |
| E111 | discovery_not_initialised | `sle discover` when `sle init` has not been run | critical | Run `sle init` first |
| E112 | discovery_not_idle | `sle discover` when `meta.status` is not `idle` | critical | Complete or halt current session first |
| E113 | discovery_session_timeout | No user interaction for 30 minutes | warning | State preserved. Resume: `sle discover` (session auto-resumes) |
| E114 | discovery_synthesis_conflict | User modifies artifact externally during synthesis | warning | Auto re-read and re-synthesise |
| E115 | discovery_round_invalid | Request for round N when current round is M ≠ N | error | Check current round: `GET /api/v2/discovery/status` |
| E116 | discovery_plan_no_phases | Plan generation produces zero phases | error | Revisit discovery — insufficient scope or constraints |
| E117 | discovery_task_create_failed | TaskStore fails to create Phase 1 tasks | warning | Plan approved but no tasks. Create manually or re-run finalization |
| E118 | discovery_from_file_not_found | `--from brief.md` references non-existent file | critical | Provide valid file path |
| E119 | discovery_mode_conflict | `--solo` and `--revisit` without `--solo` on previously solo project | warning | Mode upgrade proceeds — existing docs used as starting points |

---

## E120–E129 — Job dispatch / Docker

Errors from the job dispatcher (L4 execution plane). These cover Docker
container lifecycle, worker pool management, and dispatch orchestration.

### Container errors (E120–E124)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E120 | docker_unavailable | Docker daemon not running or unreachable | critical | Halt cycle (unrecoverable). Start Docker: `systemctl start docker` |
| E121 | container_start_failed | Container creation or install command failed | error | Mark job failed. Retry once. If retry fails, halt cycle |
| E122 | container_oom_killed | Container exceeded memory limit | error | Mark job failed with `container_oom_killed`. Not retried — indicates resource issue. Increase `memory_mb` in `validation.yaml` |
| E123 | container_timeout | Job exceeded `timeout_ms` | error | SIGKILL container. Mark job `timed_out`. Not retried. Increase `timeout_ms` in `validation.yaml` |
| E124 | image_pull_failed | Base image cannot be pulled from registry | critical | Halt cycle (unrecoverable). Check image name and network |

### Worker pool errors (E125–E127)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E125 | worker_dead | Worker missed 3 consecutive heartbeats | error | Mark current job failed. Requeue job (if retry budget allows). Spawn replacement worker |
| E126 | worker_spawn_failed | Cannot create new worker (Docker error) | error | Continue with remaining workers. If all workers dead, halt cycle |
| E127 | pool_exhausted | All workers dead and cannot spawn replacements | critical | Halt cycle (unrecoverable). Check Docker resources |

### Dispatch errors (E128–E129)

| Code | Name | Condition | Severity | Recovery |
|---|---|---|---|---|
| E128 | dispatch_plan_empty | Cannot generate dispatch plan (no active categories) | error | Halt cycle (no work to do). Check `validation.yaml` category configuration |
| E129 | orphaned_containers | Containers from previous daemon run detected at startup | warning | Log warning. Destroy all orphaned containers. Proceed |

---

## Error event shape

All errors are emitted as WebSocket events (SLE-005 event types). Every interface
(CLI, web UI, Obsidian) receives the same events.

```typescript
interface ErrorEvent {
  type: 'error'
  cycle: number
  iteration: number
  timestamp: string
  payload: {
    code: string
    message: string
    node_id?: string
    recoverable: boolean
    action_required?: string
  }
}
```

`recoverable: true` — displayed as warning; cycle continues.
`recoverable: false` — displayed as blocking alert; user action required.

---

## Recovery decision flow

```
Error detected
  │
  ├─ severity = critical?
  │    └─ yes → halt cycle or refuse operation
  │              emit ErrorEvent (recoverable: false)
  │              user action required
  │
  ├─ severity = error?
  │    └─ retry available?
  │         ├─ yes → retry (1–3x depending on code)
  │         │         if retry succeeds → continue
  │         │         if retries exhausted →
  │         │           ├─ iteration-level → abandon iteration, counter++
  │         │           └─ cycle-level → halt with outcome 'halted'
  │         └─ no → abandon operation
  │                  emit ErrorEvent (recoverable: true)
  │                  degrade gracefully
  │
  └─ severity = warning?
       └─ continue cycle in degraded mode
          emit ErrorEvent (recoverable: true)
          log for review
```

---

## ResolveExit outcome mapping

When a cycle exits, `resolveExit` (SLE-006) is called with an outcome. Error
codes map to outcomes as follows:

| Error codes | resolveExit outcome | Beads action |
|---|---|---|
| E018, E014, E007, E027 | `halted` | unclaim + comment with failure context |
| E013, E025, E032, E044 | `error` | unclaim + comment with error details |
| E043 (persistent) | `error` | unclaim + comment noting rate limit |
| E002, E015 | `crash` | stale claim resolution on next start (E091) |
| (none — successful cycle) | `completed` | close with version ID |

---

## Index by code

| Code | Name | Subsystem | Severity |
|---|---|---|---|
| E001 | daemon_not_running | Daemon lifecycle | critical |
| E002 | daemon_crash_mid_cycle | Daemon lifecycle | critical |
| E003 | port_in_use | Daemon lifecycle | critical |
| E004 | docs_remote_unreachable | Daemon lifecycle | warning |
| E005 | beads_remote_unreachable | Daemon lifecycle | warning |
| E006 | session_state_corrupted | Daemon lifecycle | error |
| E007 | invalid_state_transition | Daemon lifecycle | critical |
| E008 | discovery_incomplete | Daemon lifecycle | critical |
| E009 | daemon_version_mismatch | Daemon lifecycle | warning |
| E010 | rule_file_invalid | DAG execution | critical |
| E011 | required_artifact_missing | DAG execution | warning |
| E012 | map_yaml_write_conflict | DAG execution | warning |
| E013 | artifact_store_write_failure | DAG execution | critical |
| E014 | concurrent_cycle_attempt | DAG execution | critical |
| E015 | map_yaml_status_inconsistency | DAG execution | error |
| E016 | artifact_hash_mismatch | DAG execution | error |
| E017 | dag_node_order_violation | DAG execution | critical |
| E018 | iteration_cap_exceeded | DAG execution | error |
| E019 | revision_cap_exceeded | DAG execution | error |
| E020 | test_script_not_found | Validation | error |
| E021 | test_script_timeout | Validation | error |
| E022 | test_script_runtime_error | Validation | error |
| E023 | test_script_invalid_json | Validation | error |
| E024 | validation_category_not_found | Validation | error |
| E025 | docker_container_failure | Validation | error |
| E026 | static_check_failure | Validation | error |
| E027 | validation_gate_evaluation_failure | Validation | critical |
| E028 | confirmation_gate_timeout | Validation | warning |
| E029 | confirmation_gate_invalid_response | Validation | error |
| E030 | context_budget_exceeded | Context manager | warning |
| E031 | artifact_slice_not_found | Context manager | warning |
| E032 | context_assembly_failed | Context manager | critical |
| E033 | link_index_query_failure | Context manager | warning |
| E034 | resolver_mode_resolution_failed | Context manager | error |
| E040 | llm_call_timeout | LLM runtime | warning |
| E041 | llm_invalid_json | LLM runtime | warning |
| E042 | llm_confidence_below_threshold | LLM runtime | warning |
| E043 | llm_rate_limited | LLM runtime | warning |
| E044 | llm_auth_failure | LLM runtime | critical |
| E045 | agent_output_schema_violation | LLM runtime | error |
| E046 | agent_forbidden_artifact_write | LLM runtime | critical |
| E047 | llm_context_window_exceeded | LLM runtime | error |
| E050 | designer_circular_dependencies | Designer | error |
| E051 | designer_constraint_violation | Designer | error |
| E052 | designer_missing_components | Designer | warning |
| E053 | explorer_research_timeout | Explorer | warning |
| E054 | explorer_resource_inaccessible | Explorer | warning |
| E055 | explorer_no_findings | Explorer | warning |
| E056 | tester_separation_violation | Tester | critical |
| E057 | tester_not_self_contained | Tester | error |
| E058 | debugger_artifacts_missing | Debugger | error |
| E059 | debugger_diagnosis_contradicts | Debugger | warning |
| E060 | debugger_cannot_reproduce | Debugger | warning |
| E061 | critic_wrong_target | Critic | warning |
| E062 | planner_undefined_requirement | Planner | error |
| E063 | builder_missing_output | Builder | error |
| E064 | historian_append_failure | Historian | warning |
| E065 | evaluator_missing_sections | Evaluator | error |
| E066 | facilitator_discovery_interrupted | Facilitator | warning |
| E067 | builder_architecture_violation | Builder | error |
| E068 | explorer_trigger_invalid | Explorer | warning |
| E080 | coherence_contradiction | Intake / sharding | error |
| E081 | coherence_undefined_reference | Intake / sharding | error |
| E082 | coherence_terminology_conflict | Intake / sharding | warning |
| E083 | coherence_missing_document | Intake / sharding | error |
| E084 | sharding_scope_overlap | Intake / sharding | error |
| E085 | sharding_context_budget_exceeded | Intake / sharding | error |
| E086 | sharding_dependency_cycle | Intake / sharding | critical |
| E087 | sharding_unverifiable_acceptance | Intake / sharding | error |
| E088 | runtime_coherence_task_stale | Intake / sharding | warning |
| E089 | document_promotion_failure | Intake / sharding | warning |
| E090 | beads_claim_failed | Beads integration | error |
| E091 | beads_stale_claim_startup | Beads integration | warning |
| E092 | beads_sync_failure | Beads integration | warning |
| E093 | beads_task_not_found | Beads integration | error |
| E094 | beads_dependency_resolution_failed | Beads integration | warning |
| E095 | beads_compact_failure | Beads integration | warning |
| E096 | beads_bridge_subprocess_error | Beads integration | error |
| E097 | beads_unclaim_exit_failed | Beads integration | warning |
| E098 | beads_sharding_create_failed | Beads integration | error |
| E099 | beads_dep_wiring_failed | Beads integration | warning |
| E100 | init_already_initialised | Init | critical |
| E101 | init_no_git_repo | Init | critical |
| E102 | init_no_origin | Init | critical |
| E103 | init_beads_failure | Init | error |
| E104 | init_docs_clone_failure | Init | error |
| E105 | init_commit_failure | Init | error |
| E106 | init_push_failure | Init | warning |
| E107 | init_daemon_start_failure | Init | error |
| E108 | init_state_corrupted | Init | error |
| E109 | init_task_store_unsupported | Init | critical |
| E110 | discovery_already_complete | Discovery | error |
| E111 | discovery_not_initialised | Discovery | critical |
| E112 | discovery_not_idle | Discovery | critical |
| E113 | discovery_session_timeout | Discovery | warning |
| E114 | discovery_synthesis_conflict | Discovery | warning |
| E115 | discovery_round_invalid | Discovery | error |
| E116 | discovery_plan_no_phases | Discovery | error |
| E117 | discovery_task_create_failed | Discovery | warning |
| E118 | discovery_from_file_not_found | Discovery | critical |
| E119 | discovery_mode_conflict | Discovery | warning |
| E120 | docker_unavailable | Job dispatch / Docker | critical |
| E121 | container_start_failed | Job dispatch / Docker | error |
| E122 | container_oom_killed | Job dispatch / Docker | error |
| E123 | container_timeout | Job dispatch / Docker | error |
| E124 | image_pull_failed | Job dispatch / Docker | critical |
| E125 | worker_dead | Job dispatch / Docker | error |
| E126 | worker_spawn_failed | Job dispatch / Docker | error |
| E127 | pool_exhausted | Job dispatch / Docker | critical |
| E128 | dispatch_plan_empty | Job dispatch / Docker | error |
| E129 | orphaned_containers | Job dispatch / Docker | warning |

---

## Error cascading

Errors in one subsystem often trigger errors downstream. The following table
maps common cascade chains. Each row shows a primary error and the errors it
may cause if unhandled.

| Primary error | Cascade target | Triggered codes | Why |
|---|---|---|---|
| E025 (Docker failure) | Validation | E020, E022, E023 | Scripts cannot run without container; results in missing or broken output. |
| E040 (LLM timeout) | Agents | E045, E063 | Agent produces no output or truncated output that fails schema validation. Builder produces no files. |
| E044 (LLM auth failure) | DAG | E018 | Immediate halt. If auth fails repeatedly across iterations, cap is hit. |
| E043 (LLM rate limit, persistent) | Agents | E040, E053 | Extended rate limiting causes timeouts on subsequent calls. Explorer research may hit its own timeout. |
| E013 (Artifact write failure) | Context manager | E031 | If artifact was partially written before failure, next context assembly finds it missing. |
| E058 (Debugger artifacts missing) | Agents | E062 | Debugger produces degraded diagnosis. Planner may reference requirements that were not properly traced through the failure. |
| E032 (Context assembly failed) | Agents | E040 | Failed assembly triggers agent call abort, which the agent runtime may report as timeout. |
| E091 (Stale claim on startup) | DAG | E002, E015 | Stale claim implies previous crash, which also means map.yaml may have inconsistent status. |
| E088 (Task stale) | Beads | E090 | If user clears stale flag and task is reclaimed, but context has changed, claim may fail for other reasons. |
| E086 (Dependency cycle) | Beads | E094 | Sharding dependency cycle, if not caught, surfaces as Beads dependency resolution failure. |

---

## Error codes by DAG node

Which errors can fire at each node in the cycle DAG.

| DAG node | Possible error codes |
|---|---|
| INTENT | E014, E008 |
| CONTEXT ASSEMBLY | E030, E031, E032, E033, E034 |
| EXPLORE | E053, E054, E055, E068, E040, E044 |
| DESIGN | E050, E051, E052, E061, E040, E044, E047 |
| PLAN | E062, E040, E044, E047 |
| TEST | E056, E057, E040, E044, E046 |
| CONFIRM GATE | E028, E029, E019 |
| BUILD | E063, E067, E040, E044, E046 |
| HISTORY | E064, E013 |
| EXEC | E020, E021, E022, E023, E025, E026 |
| VALIDATION GATE | E024, E027, E018 |
| DEBUG | E058, E059, E060, E040, E044 |
| EVALUATE | E065, E040, E044 |
| SUMMARISE | E013 |
| SNAPSHOT | E016, E004 |

---

## Error codes by planning depth

Some error codes only fire at certain planning depths because the roles or
nodes that produce them are depth-conditional.

| Depth | Active roles | Additional error codes |
|---|---|---|
| `minimal` | Planner, Tester, Builder, Historian, Evaluator | — |
| `standard` | + Designer | E050, E051, E052 |
| `deep` | + Critic, + Explorer (conditional) | E053–E055, E061, E068 |
| `research` | + Critic (multi-pass), + Explorer | Same as `deep`, with additional Critic and Explorer retry paths |

---

## Error codes by session type

| Session type | Relevant ranges |
|---|---|
| Discovery | E001–E009 (daemon), E040–E047 (Facilitator LLM), E066 (Facilitator), E090–E099 (Beads setup) |
| Chat | E001–E003 (daemon), E040–E044 (Facilitator LLM) |
| Cycle | All ranges |

---

## Retry policies

| Code | Max retries | Backoff | Iteration increment on exhaustion? |
|---|---|---|---|
| E012 (map.yaml conflict) | 3 | 500ms exponential | Yes (cycle halts) |
| E013 (artifact write) | 1 | immediate | Yes (cycle halts) |
| E020–E023 (test script) | 0 | — | No (category fails, iteration continues) |
| E025 (Docker) | 1 | immediate | No (all categories fail, iteration continues) |
| E030 (context budget) | 0 | — (auto-trim) | No |
| E040 (LLM timeout) | 1 | 5s | Yes |
| E041 (LLM invalid JSON) | 1 (lenient extract) | immediate | No (category fails) |
| E043 (LLM rate limit) | indefinite | Retry-After header | No |
| E045 (schema violation) | 1 | immediate | Yes |
| E046 (forbidden write) | 1 | immediate | Yes (iteration fails) |
| E050–E052 (Designer) | 2 (within turn) | immediate | No (within turn); yes if exhausted |
| E056 (Tester separation) | unlimited (within turn) | immediate | No |
| E057 (Tester self-contained) | 2 | immediate | No (placeholder inserted) |
| E061 (Critic target) | 1 | immediate | No (output discarded) |
| E064 (Historian append) | 1 | immediate | No |
| E065 (Evaluator sections) | 1 | immediate | No |

---

## Relationship to exit.yaml

`exit.yaml` defines what happens when the iteration cap is hit (E018). Error
codes interact with exit.yaml at two points:

1. **E018 triggers `on_cap_hit`**: The exit strategy from `exit.yaml` determines
   whether the cycle writes a partial report, escalates to a different planning
   depth, or simply halts. The error code itself is always E018 regardless of
   the exit strategy chosen.

2. **Error codes feed `resolveExit`**: The cycle outcome passed to
   `bridge.resolveExit()` (SLE-006) is determined by which error code caused
   the exit. See the ResolveExit outcome mapping table above.

Error codes that do NOT trigger exit.yaml (handled within iteration):
E020–E026 (validation errors), E040–E043 (LLM retries), E030–E031 (context
budget/slice issues), E050–E060 (role-specific retries within turn).

---

## Relationship to FailureReport

The FailureReport (SLE-022, replacing SLE-003's version) is generated by the
VALIDATION gate when one or more categories fail. Error codes contribute to
the FailureReport as follows:

| Error code | FailureReport contribution |
|---|---|
| E020 | `fail_reason: "missing_executable"` |
| E021 | `fail_reason: "timeout"`, partial metrics if available |
| E022 | `fail_reason: "runtime_error"`, stderr included |
| E023 | `fail_reason: "invalid_output"`, raw stdout included |
| E024 | Category omitted from report (not a failure, a configuration error) |
| E025 | `fail_reason: "container_failure"`, Docker error included |
| E026 | `fail_reason: "static_check"`, specific violations listed |
| E041 | `fail_reason: "invalid_response"`, confidence: 0.0 |
| E042 | `fail_reason: "confidence_below_threshold"`, actual confidence included |

Error codes outside the validation subsystem do not directly contribute to
FailureReport. They may halt the iteration before the VALIDATION gate is reached,
in which case no FailureReport is generated for that iteration.

---

## Resolved gaps

| Gap | Resolution |
|---|---|
| G26 | E050–E060, E067–E068 cover Designer, Explorer, and Debugger role-specific failure scenarios. Includes: circular dependencies, constraint violations, missing components, research timeout, resource inaccessibility, empty findings, missing/malformed run artifacts, contradictory diagnoses, unreproducible failures, architecture violations, invalid triggers. |
| G33 | All state references use settled values: `idle`, `cycling`, `discovering`, `halted`, `complete`. No code references `running` or `awaiting_approval` as state values. `confirming` is modelled as `cycle.awaiting_confirmation` boolean flag (E028, E029). `chatting` is not referenced as a state — chat is an orthogonal session tracked by `map.yaml → chat.session_open`. E014 checks `meta.status !== 'idle'` instead of the old `status !== 'running'`. E015 detects `meta.status === 'cycling'` instead of `status === 'running'`. E028/E029 handle confirmation via the `awaiting_confirmation` flag. |
