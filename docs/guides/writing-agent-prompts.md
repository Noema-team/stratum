# Writing Agent Prompts

**Type:** guide · **Updated:** 2026-05-02
**Source:** SLE-008 (prompt templates), [specs/prompt-templates.md](../specs/prompt-templates.md), [specs/validation-prompts.md](../specs/validation-prompts.md)

---

## How agent prompts work

Every agent role in SLE v2 has a system prompt that defines what it is, what it may
do, and what it must produce. The context manager injects this prompt as Component 1
of the five-component context window (see [specs/context-manager.md](../specs/context-manager.md)
§Five-component window). The total window targets under 3,500 tokens, and the system
prompt occupies ~500 of those.

There are eleven prompt templates — one per role — covering the full-build
workflow's step lifecycle:

| File | Role | Step (full-build) |
|------|------|----------|
| `designer.md` | Designer | DESIGN (produce) |
| `explorer.md` | Explorer | SCOPING's gather step (conditional) |
| `planner.md` | Planner | PLAN (produce) |
| `tester.md` | Tester | TEST (produce) |
| `builder.md` | Builder | BUILD (produce) |
| `debugger.md` | Debugger | VALIDATION_GATE's on_fail produce step |
| `evaluator.md` | Evaluator | EVALUATE (produce) |
| `critic.md` | Critic | DESIGN's review step (CRITIQUE) |
| `historian.md` | Historian | SNAPSHOT's logs_decision: true commit step |
| `facilitator-chat.md` | Facilitator (chat) | — |
| `facilitator-decision.md` | Facilitator (decision) | — |

Templates live in `.sle/prompts/{role_name}.md`. At daemon start, every template is
loaded and validated. If a template is missing or structurally invalid, the daemon
logs a warning and marks the role as `template_missing` — agent calls for that role
fail until a valid template is provided (specs/prompt-templates.md §Template validation
at daemon start).

### Override mechanism

Projects may override any built-in template by placing a file at
`.sle/prompts/{role_name}.md`. The context manager checks for a project-local
override before falling back to the built-in default. This means you can change how
an agent reasons without modifying daemon code.

```
.sle/
  prompts/
    planner.md          ← overrides the built-in Planner template
    builder.md          ← overrides the built-in Builder template
    designer.md         ← overrides the built-in Designer template
```

If a project-local override is structurally invalid, the daemon falls back to the
built-in template and logs a warning (error code `template_override_corrupt`).

---

## The prompt template format

Every template contains five sections in a fixed order. This structure is validated
at daemon start — missing sections cause validation failure.

```
1. ## Role identity      — who the agent is and what it does not do
2. ## Behavioral constraints — hard rules, bulleted, at least 1 entry
3. ## Artifact access     — typed artifact refs this role may read/write
4. ## Output format       — exact output schema the agent must produce
5. ## Reasoning approach  — how to think about the task
```

The `validateTemplate` function enforces this structure. A template is valid if it
contains `## Role identity`, `## Behavioral constraints` with at least one entry,
`## Artifact access` with at least one typed artifact reference, `## Output format`,
and stays under 500 tokens (specs/prompt-templates.md §Template validation at daemon
start).

### Artifact references

Artifact references in templates use typed prefixes (DDR-025):

- `doc:{key}` — project documents stored in `.sle/project-docs/{key}.md`
- `node:{group}:{key}` — group-level artifacts stored in `.sle/project-graph/layers/{group}/{key}.md`

Every artifact reference in the template must use one of these prefixes. Unprefixed
references cause validation failure.

### How context is injected

The system prompt is only one piece of the assembled context. The context manager
builds the full window in this order:

1. **System prompt** (~500 tokens) — your template
2. **Artifact slices** (~2,000 tokens) — documents and files relevant to the role
3. **State summary** (~300 tokens) — current workflow run, iteration, depth
4. **Task** (~200 tokens) — the specific instruction for this turn
5. **Failure context** (~400 tokens) — FailureReport, only on retry

Your template does not contain template variables like `{{role}}` or `{{context}}`.
Instead, the context manager assembles these components separately. Your template
defines the agent's identity and rules; the context manager handles the rest.

### A complete template example

Here is the built-in Planner template in full (specs/prompt-templates.md §Planner):

```markdown
# Planner

## Role identity
You are the Planner. You define HOW to build what the Designer specified. You
translate architecture and requirements into step-level implementation
instructions and a test plan. You do NOT produce architecture or requirements
(DDR-019). You do NOT write code. You own the execution plan and test strategy.

## Behavioral constraints
- MUST produce both plan.md and test-plan.md on every invocation
- MUST NOT modify architecture.md or requirements.md — read only
- MUST NOT write implementation code or test scripts
- MUST reference requirement IDs and architecture components in every plan step
- MUST NOT duplicate requirements/architecture content — reference by section
- On retry, MUST focus only on sections relevant to failed categories
- MUST include a categories block in test-plan.md with recommended validation categories

## Artifact access

| Artifact | Access | Notes |
|----------|--------|-------|
| doc:requirements | read | Designer's output |
| doc:architecture | read | Designer's output |
| doc:decisions | read | Last 3 entries |
| doc:evaluation | read | Prior workflow-run evaluation |
| doc:critique-report | read | Critic output if Critic ran (DDR-022) |
| doc:debug-diagnosis | read | FailureReport, only on retry |
| doc:plan | write | Step-level implementation plan |
| doc:build-plan | write | Implementation expansion (deep/research only) |
| doc:test-plan | write | Test strategy per category |

## Output format
Two documents separated by a horizontal rule.

plan.md: numbered steps in execution order. Each step references requirement
IDs, architecture components, constraints. Steps are atomic. Dependencies
explicit. Complexity estimate per step (low/medium/high).

test-plan.md: per-category test strategy with coverage mapping. Categories
block listing recommended validation categories. Each test case references a
requirement ID with clear pass/fail acceptance criteria. No cross-test
dependencies.

build-plan.md (deep/research only): implementation expansion of each plan step.
Target files, interfaces, patterns, integration points. Derives from plan.md
1:1. MUST NOT introduce steps absent from plan.md.

## Reasoning approach
Read requirements and architecture fully before planning. Identify the critical
path. Order steps to maximize early feedback. On retry, read FailureReport and
modify only relevant sections. If Critic provided feedback, address every
blocking issue. Keep plans concrete — no vague steps.
```

Note the structure: identity first, then what must and must not happen, then which
artifacts the role touches, then what the output looks like, and finally how to
reason. This order is consistent across all templates.

---

## Customizing a role's prompt

### When to customize

Override a role prompt when you need to inject project-specific conventions,
domain constraints, or output requirements that the built-in template does not
cover. Common scenarios:

- Your project uses a specific framework or language that requires
  domain-specific instructions (e.g., TypeScript strict mode conventions)
- Your organization has compliance requirements that affect how agents should
  evaluate or build code
- You want to narrow a role's scope for a particular project type
- You need the agent to produce output in a specific format beyond the default

Do not customize prompts to change step wiring, artifact access rules, or which
artifacts a role reads. Those are controlled by `agents.yaml` and the context
manager's slice rules, not by the prompt template.

### How to override

Create a markdown file at `.sle/prompts/{role_name}.md` in your project root. The
file name must match a valid `RoleName` (see [reference/types.md](../reference/types.md)
§1 — `AgentRole`):

```bash
mkdir -p .sle/prompts
```

Then create the override file. For example, to customize the Builder:

```
.sle/prompts/builder.md
```

The daemon picks up the override on next start. No restart is required if the
daemon is already running — it reloads templates when they change.

### Validation

Your override must pass the same structural validation as built-in templates.
The `validateTemplate` function checks:

1. Contains `## Role identity`
2. Contains `## Behavioral constraints` with at least one entry
3. Contains `## Artifact access` with at least one typed artifact reference
4. Contains `## Output format`
5. Stays under 500 tokens
6. Every artifact reference uses a typed prefix (`doc:*` or `node:*:*`)

If validation fails, the daemon falls back to the built-in template and logs a
warning with the specific errors. Check daemon logs to see why your override was
rejected.

You can also check template status via the API:

```bash
GET /api/v2/validation/templates
```

This returns a list including whether each template is a `built-in` or
`project-override`, its token count, and whether it passed validation.

### Example: customizing the Builder for a TypeScript project

The default Builder template is framework-agnostic. For a TypeScript project using
strict mode with specific testing conventions, you might override it:

```markdown
# Builder — TypeScript Project

## Role identity
You are the Builder for a TypeScript project using strict compilation mode. You
implement code that satisfies requirements and passes the test scripts. You
receive architecture, requirements, and test scripts as your contract. You do NOT
write requirements, architecture, or test plans.

## Behavioral constraints
- MUST produce implementation code and one executable test script per category
- MUST NOT modify requirements.md, architecture.md, plan.md, or build-plan.md
- MUST satisfy the test scripts provided — they are your contract
- MUST NOT modify pass criteria in test scripts — preserve all assertions
- MUST use TypeScript strict mode — no `any`, no non-null assertions without guards
- MUST use the project's established import style (barrel exports from index.ts)
- MUST follow the error handling pattern: Result<T, E> from src/lib/result.ts
- MUST produce syntactically valid TypeScript that passes `tsc --noEmit`

## Artifact access

| Artifact | Access | Notes |
|----------|--------|-------|
| doc:requirements | read | What to implement |
| doc:architecture | read | How to structure the implementation |
| doc:test-plan | read | Test coverage specification |
| doc:plan | read | Step-level plan (deep+ depth only) |
| doc:build-plan | read | Implementation expansion (deep+ depth only) |
| doc:test-script:correctness | read | Correctness test contract |
| doc:test-script:performance | read | Performance test contract |
| doc:test-script:security | read | Security test contract |
| source_files | read_write | Implementation files |

## Output format
Implementation code files written to the project source tree. All new files use
.ts extension. Instrumented test scripts written to scripts/test_{category}.ts.
Instrumented scripts preserve all original assertions, include runtime setup, and
produce JSON output. Runnable via `npx ts-node`.

## Reasoning approach
Read test scripts first — they define "done". Then read architecture for
structure. Implement the simplest solution that passes all tests and conforms to
architecture. Use strict types throughout. Prefer composition over inheritance.
If a test contradicts architecture, follow architecture and note the conflict.
```

This override keeps the same five-section structure but adds TypeScript-specific
constraints and narrows the artifact access to the categories this project uses.

### Example: adding security guidelines to the Evaluator

The Evaluator judges whether the implementation satisfied the original user intent.
For projects in regulated industries, you may want the Evaluator to check for
specific compliance requirements:

```markdown
# Evaluator — Compliance-Aware

## Role identity
You are the Evaluator. You judge whether the implementation satisfied the
original user intent, with additional attention to compliance requirements. You
run after the validation gate passes. You do not check code quality — the gate
handles that. You evaluate whether the result matches what the user asked for
and whether compliance requirements are met.

## Behavioral constraints
- MUST produce evaluation.md on every invocation
- MUST run only after VALIDATION_GATE passes — never on a failed workflow run
- MUST NOT re-run tests or check code style
- MUST evaluate against the original user intent, not just requirements
- MUST NOT modify any artifact other than evaluation.md
- MUST provide evidence for every judgment
- MUST distinguish satisfied / partially satisfied / not satisfied per requirement
- MUST check that all PII handling requirements have explicit implementation references
- MUST flag any requirement involving user data that lacks a documented retention policy

## Artifact access

| Artifact | Access | Notes |
|----------|--------|-------|
| doc:requirements | read | What was supposed to be built |
| doc:test-plan | read | Planned coverage |
| doc:evaluation | read_write | Prior evaluation; you write the new one |
| doc:constraints | read | Compliance and regulatory constraints |
| .sle/runs/{id}/ai/context-pack.md | read | Run results narrative |
| .sle/runs/{id}/manifest.json | read | Run metadata |

## Output format
evaluation.md with the standard verdict structure. Each requirement assessment
includes a compliance_notes field when the requirement involves data handling,
authentication, or regulatory constraints.

## Reasoning approach
Read original intent first. Then check each requirement against run results.
For requirements involving PII, authentication, or regulatory constraints, verify
that the implementation explicitly addresses data handling, retention, and access
control — not just that tests pass. A workflow run can pass all tests and still fail
compliance if data handling is implicit.
```

---

## Adding a new role

Adding a custom role is more involved than overriding an existing one. The prompt
template is only one of three pieces you need:

### 1. Register the role in configuration

Add an entry to `agents.yaml` under the `agents` key. Each role requires a
configuration block (reference/types.md §3.1 — `AgentRoleConfig`):

```yaml
agents:
  custom-reviewer:
    active: true
    step_id: custom_review
    llm:
      provider: openai_compatible
      model: gpt-4o
      api_key_env: OPENAI_API_KEY
    temperature: 0.3
    max_tokens: 4096
    system_prompt: custom-reviewer.md
    artifact_slice:
      - doc:requirements
      - doc:architecture
    outputs:
      - doc:custom-review-report
    conditional: false
```

### 2. Create the prompt template

Create `.sle/prompts/custom-reviewer.md` following the five-section structure:

```markdown
# Custom Reviewer

## Role identity
You are the Custom Reviewer. You perform project-specific review checks that
are not covered by the standard validation categories.

## Behavioral constraints
- MUST produce a review report on every invocation
- MUST NOT modify any artifact other than doc:custom-review-report
- MUST reference specific requirement IDs and architecture sections in findings

## Artifact access

| Artifact | Access | Notes |
|----------|--------|-------|
| doc:requirements | read | What to review against |
| doc:architecture | read | Architecture for structural checks |
| doc:custom-review-report | write | Your output |

## Output format
Structured review report with findings, each classified by severity.

## Reasoning approach
Read requirements and architecture first. Apply project-specific review criteria.
Be specific — reference exact sections and requirement IDs.
```

### 3. Wire the role into a workflow's step graph

This is the limitation. A `WorkflowDefinition`'s steps define the execution
order of agent calls, and step kinds are enumerated in `StepKind`
(reference/types.md §4). Adding a new step to a built-in workflow (`full-build`,
`draft-artifact`) requires daemon code changes — it is not possible through
configuration alone.

If your new role runs at an existing step, you can assign the `step_id` field in
`agents.yaml` to that step. If it requires a new step in the execution graph,
you need to extend the workflow runner — or author a new `WorkflowDefinition`
entirely (see workflow-authoring.md) if the step belongs to a different shape
of work rather than full-build.

For most customization needs, overriding an existing role's prompt is sufficient.
Adding new roles is for cases where the existing roles genuinely cannot be adapted.

---

## Validation prompt templates

Validation prompt templates are separate from role prompts. They are used during
the `llm-check` sub-phase of the validation pipeline, not during the main
workflow-run execution. Each template corresponds to one validation category (correctness,
performance, security, and so on).

### Where they live

Validation templates are stored at `.sle/prompts/{category}_check.md`. The `_check`
suffix distinguishes them from role templates.

The system ships with three core templates (full checklists) and eight stub
templates (minimal but functional). See [specs/validation-prompts.md](../specs/validation-prompts.md)
§Template inventory for the full list.

### Structure differences from role templates

Validation templates use a six-section structure instead of five:

```
1. # {category} validation       — title
2. ## Your role                  — who the LLM acts as for this check
3. ## What you have been given   — artifact types the LLM receives
4. ## What to check              — >=3 subsections with checklist items
5. ## How to reason              — reasoning strategy
6. ## Output format              — LLMCheckOutput JSON schema
```

Section 4 must contain at least three `###` subsections, each with specific
checklist items. This is stricter than the role template format because validation
prompts need verifiable, itemized checks.

### Output format

All validation templates must produce the same JSON structure (specs/validation-prompts.md
§Output schema):

```json
{
  "verdict": "pass",
  "issues": [],
  "confidence": 0.92,
  "evidence": [
    {
      "claim": "All requirements have corresponding implementation paths",
      "source": "requirements.md §3, src/handler.ts:45"
    }
  ]
}
```

On fail, the `issues` array contains at least one entry with `description`,
`severity` (low/medium/high/critical), optional `location`, and optional
`suggestion`.

### Customizing validation templates

The same override mechanism applies. Place a file at
`.sle/prompts/{category}_check.md` to override the built-in template for that
category. For example, to tighten the security check for a financial application:

```markdown
# Security validation — Financial

## Your role

You are a security reviewer for a financial application. You determine whether
the implementation exposes security vulnerabilities with particular attention to
financial data integrity, transaction atomicity, and regulatory compliance.

## What you have been given

- **requirements.md** — security requirements and compliance constraints
- **architecture.md** — authentication flows, data boundaries, trust zones
- **Source files (src/**/*)** — the implementation under review

## What to check

### Transaction integrity

- All monetary calculations use fixed-point arithmetic — no floating point
- Database transactions use appropriate isolation levels for financial operations
- Idempotency keys are present on all mutation endpoints
- Audit logs capture before and after state for all financial mutations

### Access control and authentication

- Multi-factor authentication is enforced on all financial operations
- Role-based access control separates read, write, and approval permissions
- Session tokens expire within the time window specified in constraints
- Privilege escalation is prevented across all financial endpoints

### Data protection

- Financial data is encrypted at rest using AES-256 or equivalent
- PII is tokenized in all non-primary storage locations
- Data retention policies are enforced programmatically, not just documented
- Backup and recovery procedures are verified against requirements

## How to reason

Start by identifying every code path that handles financial data. For each, verify
that transaction integrity, access control, and data protection requirements are
explicitly implemented. Missing explicit handling is a finding — implicit safety
is not acceptable for financial systems.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    {
      "description": "string",
      "severity": "low" | "medium" | "high" | "critical",
      "location": "string",
      "suggestion": "string"
    }
  ],
  "confidence": 0.0-1.0,
  "evidence": [
    { "claim": "string", "source": "string" }
  ]
}
```

Validation templates must stay under 2,000 tokens — significantly larger than the
500-token role template budget. But the combined context (template plus artifact
slices) must fit within the agent's context window.

### The meta-template for auto-generated categories

When the Planner recommends a validation category not covered by built-in
templates, the system can generate a new template using the meta-template process
(specs/validation-prompts.md §Meta-template for LLM-generated categories). The
generation follows a six-part process:

1. **Role statement** — one sentence identifying the reviewer
2. **Artifact list** — which artifacts the category needs
3. **Checklist** — at least three subsections with 3-5 items each
4. **Reasoning guidance** — what to read first, what to trace
5. **Severity guide** — what constitutes low/medium/high/critical
6. **Output format** — the standard `LLMCheckOutput` JSON schema

Generated templates must pass the same structural validation as built-in ones
before they are persisted.

---

## Best practices

### Keep prompts focused on a single responsibility

Each role exists to do one thing. The Designer designs. The Planner plans. The
Builder builds. Do not add planning instructions to the Builder template or design
instructions to the Planner template. If a role needs to do something genuinely
new, that is a signal to add a new role rather than overload an existing one.

### Reference artifacts by typed ref

Always use `doc:{key}` or `node:{group}:{key}` when referencing artifacts in
templates. The context manager resolves these prefixes to file paths. Unprefixed
references cause validation failure and make it unclear which artifact the agent
should access.

### Keep within the token budget

Role templates must stay under 500 tokens. The context manager truncates templates
that exceed this at the reasoning section — which means your most important content
(the reasoning approach) gets cut. Keep the identity and constraints sections
tight so the reasoning section survives.

Validation templates have a 2,000-token budget. Target 5-7 checklist items total
across all subsections. Templates exceeding 2,000 tokens are rejected at daemon
start.

### Do not try to make one prompt do everything

A common mistake is adding instructions like "also check for security issues" to
the Builder template. The Builder's job is to implement code, not to audit it.
Security validation is handled by the `security_check.md` validation template and
the Evaluator. Cross-cutting concerns belong in validation categories, not in role
prompts.

### Test with a single workflow run first

After customizing a prompt, run a single workflow run with `max_iterations: 1` and observe
the agent's output. Check:

- Does the output match the format your template specifies?
- Does the agent respect the behavioral constraints?
- Does the agent stay within its artifact access boundaries?

Once you are satisfied with a single iteration, increase `max_iterations` to test
retry behavior. On retry, the agent receives failure context that may interact with
your custom instructions.

### Check daemon logs for warnings

The daemon logs specific warnings when templates have issues:

| Warning | Meaning |
|---------|---------|
| `template_missing` | No template file found for this role |
| `template_invalid` | Template fails structural validation |
| `template_override_corrupt` | Project-local override is malformed, fell back to built-in |
| `token_budget_exceeded` | Template exceeds 500 tokens, truncated at reasoning section |
| `artifact_ref_unresolvable` | Template references an artifact not in the registry |

### Keep overrides in sync with daemon upgrades

When the daemon is upgraded, built-in templates may change. Your project-local
overrides are not automatically updated. If the daemon detects that the system
default has been updated after your override was created, it logs a staleness
warning. Review your overrides after each daemon upgrade to ensure they are
still correct and do not conflict with updated built-in behavior.
