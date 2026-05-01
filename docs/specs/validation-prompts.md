# Validation Prompt Templates

| Type | Status | Updated |
|------|--------|---------|
| Spec | Draft | 2026-05-01 |

**Depends on:** validation.md, types.md
**Source material:** vision/SLE-008-prompt-templates.md, init-specs/05-prompt-templates.md
**Resolves:** A1 (validation prompt templates from Round 1 review)

## Overview

Validation prompt templates are markdown files that instruct the LLM how to
reason about an artifact slice during the `llm-check` sub-phase. Each template
corresponds to one validation category and defines what to check, how to reason,
and what structured JSON to emit.

Templates are data, not code. Changing how the LLM evaluates a category means
editing a markdown file — no daemon changes required. The system loads templates
at daemon start, validates their structure, and injects them as context for each
`llm-check` invocation.

**Scope:** Validation prompts only (Component 3 of the validation pipeline).
System prompts for agent roles are defined in
[prompt-templates.md](prompt-templates.md).

**Storage:** `.sle/prompts/{category}_check.md`

**Relationship to llm-check:** The `llm-check` sub-phase receives an artifact
slice (defined in validation.md §Per-category llm-check artifact slices) and a
prompt template. The LLM reasons about the artifacts according to the template
and returns structured JSON. The gate evaluates the result deterministically —
`verdict == 'pass' AND confidence >= pass_threshold`.

---

## Template structure

Every validation prompt template must contain exactly six sections in this order:

```
1. # {category} validation        — title identifying the category
2. ## Your role                    — who the LLM is acting as for this check
3. ## What you have been given     — artifact types the LLM receives
4. ## What to check                — ≥3 subsections with specific checklist items
5. ## How to reason                — reasoning strategy and priorities
6. ## Output format                — exact JSON schema the LLM must emit
```

Section 4 must contain at least three `###` subsections, each with specific
checklist items the LLM evaluates. Bullet points under each subsection are
individual checks.

---

## Output schema

Every template must instruct the LLM to emit this exact JSON structure. The
`llm-check` sub-phase parses this output and feeds it to the gate.

```typescript
interface LLMCheckOutput {
  verdict: 'pass' | 'fail'
  issues: Array<{
    description: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    location?: string
    suggestion?: string
  }>
  confidence: number
  evidence: Array<{
    claim: string
    source: string
  }>
}
```

**Field rules:**

| Field | Rules |
|-------|-------|
| `verdict` | `"pass"` or `"fail"`. No other values. |
| `issues` | Empty array on pass. At least one entry on fail. |
| `issues[].severity` | One of `low`, `medium`, `high`, `critical`. |
| `issues[].location` | Optional file path, function name, or artifact section. |
| `issues[].suggestion` | Optional fix recommendation. |
| `confidence` | Float between 0 and 1 inclusive. 0 = no confidence, 1 = certain. |
| `evidence` | At least one entry on both pass and fail verdicts. |
| `evidence[].source` | Artifact name or file path the claim is grounded in. |

---

## Template validation rules

Enforced at daemon start for every template:

1. **Verdict field.** Output format section must contain `"verdict": "pass"` and
   `"verdict": "fail"` (or equivalent `pass` | `fail` syntax).
2. **Checklist depth.** `## What to check` must contain at least three `###`
   subsections.
3. **Token budget.** Template must be under 2,000 tokens. Templates exceeding
   this are rejected.
4. **Artifact reference.** Template must reference at least one artifact by name
   (e.g., `requirements.md`, `architecture.md`, `src/**/*`).
5. **Missing template.** If a category requires `llm-check` but the template
   file is missing, the category is reclassified:
   - `method: 'both'` → downgraded to `method: 'executable'` with a warning
   - `method: 'llm'` → category skipped with a warning

Validation results are logged at daemon start. Invalid templates prevent the
daemon from starting — the operator must fix or remove the template.

---

## Core templates

Core templates ship with full checklist content across all six sections. They
cover the three categories activated by default across all project types.

### correctness_check.md

**Category:** `correctness` · **Method:** `both` · **Threshold:** `0.85`

```markdown
# Correctness validation

## Your role

You are a correctness reviewer. You determine whether the implementation does
what the requirements intend — not just what they literally say, but what they
mean. You catch logic errors, missing edge cases, misunderstood contracts, and
implementations that pass tests but violate the spirit of the requirement.

## What you have been given

- **requirements.md** — the authoritative list of what the system must do
- **Source files (src/**/*)** — the implementation under review

You will not see test scripts, architecture, or planning documents. Judge
correctness from requirements to implementation, nothing else.

## What to check

### Logic and output correctness

- Each requirement maps to a clear implementation path in the source code
- Functions produce correct outputs for the expected input range
- Return types and shapes match what requirements describe
- Computed values use correct formulas, algorithms, and data transformations
- Boolean conditions and branching logic match requirement specifications

### Edge cases and boundary conditions

- Empty inputs are handled (empty strings, empty arrays, zero values)
- Maximum-size inputs are handled (large files, long strings, deep nesting)
- Null and undefined inputs are handled where applicable
- Off-by-one errors are absent from loops, indices, and pagination
- Concurrent or overlapping operations produce consistent results

### Data contracts and interfaces

- API endpoints accept and return the shapes documented in requirements
- Database queries retrieve and persist the correct fields
- Error responses match the specified error format and status codes
- Required fields are validated before processing
- Optional fields default to documented values when absent

### Requirement coverage

- Every requirement ID in requirements.md has a corresponding implementation
- No implementation logic exists without a backing requirement
- Ambiguous requirements are flagged rather than silently interpreted
- Cross-requirement interactions are handled (dependencies between features)
- Requirement priority levels are respected (critical paths are solid)

## How to reason

Start by reading every requirement. Then trace each requirement through the
source code. If you cannot find where a requirement is implemented, that is a
finding — do not assume it is handled elsewhere. When implementation contradicts
requirement intent, flag it even if the literal text is satisfied. Prefer
specific evidence over general impressions. If you are unsure whether something
is correct, state your uncertainty explicitly rather than guessing.

## Output format

Respond with a single JSON object:

{
  "verdict": "pass" | "fail",
  "issues": [
    {
      "description": "string — what is wrong",
      "severity": "low" | "medium" | "high" | "critical",
      "location": "string — file path or function name",
      "suggestion": "string — how to fix it"
    }
  ],
  "confidence": 0.0-1.0,
  "evidence": [
    {
      "claim": "string — what you determined",
      "source": "string — artifact or file that supports it"
    }
  ]
}

On pass: issues is empty, confidence reflects how thoroughly you could verify.
On fail: at least one issue, confidence reflects certainty of the finding.
```

---

### performance_check.md

**Category:** `performance` · **Method:** `both` · **Threshold:** `0.80`

```markdown
# Performance validation

## Your role

You are a performance reviewer. You determine whether the implementation is
likely to meet performance expectations based on code-level analysis. You catch
algorithmic bottlenecks, unnecessary blocking, missing caching, and patterns
that degrade under load. You do not run benchmarks — you reason about code.

## What you have been given

- **requirements.md** — performance expectations and constraints
- **architecture.md** — system design, data flows, caching strategy

You will not see source code directly. Judge performance characteristics from
architectural decisions and requirement specifications.

## What to check

### Algorithmic efficiency

- Hot-path algorithms are appropriate for expected data sizes
- Time complexity is acceptable for the stated throughput requirements
- Space complexity does not risk memory exhaustion at scale
- Sorting, searching, and filtering use efficient data structures
- Nested loops and recursive calls have bounded depth

### I/O and resource patterns

- Database queries avoid N+1 patterns
- File I/O uses streaming for large files rather than loading entirely into memory
- Network calls use connection pooling and keep-alive where applicable
- Batch operations are used instead of sequential single-item operations
- Resource cleanup (file handles, connections, streams) is guaranteed

### Caching and optimization

- Frequently accessed data has a caching strategy defined
- Cache invalidation rules are specified and coherent
- Computed values that do not change per request are memoized or precomputed
- Redundant computations within a single request path are eliminated
- Static assets and responses use appropriate compression or encoding

### Concurrency and async

- Blocking operations are correctly identified and handled asynchronously
- Shared mutable state is protected from race conditions
- Connection pools and thread pools are sized appropriately for expected load
- Timeouts are defined for all external service calls
- Backpressure mechanisms exist for high-throughput scenarios

## How to reason

Start with requirements — identify explicit performance constraints (latency
targets, throughput, memory limits). Then trace the architecture for each hot
path. If a requirement specifies "p95 < 200ms" and the architecture involves
three sequential database queries with no caching, flag it. Be specific about
which path, which bottleneck, and what the expected impact is. Do not flag
theoretical concerns without connecting them to a requirement.

## Output format

Respond with a single JSON object:

{
  "verdict": "pass" | "fail",
  "issues": [
    {
      "description": "string — what is wrong",
      "severity": "low" | "medium" | "high" | "critical",
      "location": "string — component or data flow path",
      "suggestion": "string — how to fix it"
    }
  ],
  "confidence": 0.0-1.0,
  "evidence": [
    {
      "claim": "string — what you determined",
      "source": "string — artifact or section that supports it"
    }
  ]
}

On pass: issues is empty, confidence reflects how thoroughly you could verify.
On fail: at least one issue, confidence reflects certainty of the finding.
```

---

### security_check.md

**Category:** `security` · **Method:** `both` · **Threshold:** `0.90`

```markdown
# Security validation

## Your role

You are a security reviewer. You determine whether the implementation exposes
security vulnerabilities. You catch authentication bypasses, injection risks,
secret exposure, improper access control, and insecure defaults. You are
conservative — when in doubt, flag it. Security findings default to high
severity unless clearly cosmetic.

## What you have been given

- **requirements.md** — security requirements and compliance constraints
- **architecture.md** — authentication flows, data boundaries, trust zones
- **Source files (src/**/*)** — the implementation under review

You see source code for security review. This is the only validation category
where source access is required by default.

## What to check

### Authentication and authorization

- Authentication is required on all non-public endpoints
- Authorization checks are enforced at every access boundary, not just at entry
- Role-based access control is applied consistently across all protected routes
- Session tokens are validated on every request, not cached client-side only
- Privilege escalation is prevented — users cannot access resources beyond their role

### Input validation and injection

- All user inputs are validated and sanitized before processing
- SQL queries use parameterized statements — no string concatenation
- Command injection is prevented — no unsanitized input passed to shell commands
- HTML output is escaped to prevent cross-site scripting (XSS)
- File path inputs are normalized to prevent directory traversal

### Secrets and sensitive data

- No secrets, API keys, or credentials appear in source code or configuration files
- Sensitive data is encrypted at rest and in transit
- Logs do not contain passwords, tokens, or personally identifiable information
- Error messages do not leak internal system details to external callers
- Secret rotation mechanisms are defined for long-lived credentials

### Error handling and surface area

- Errors are caught and handled — no unhandled exceptions reach the client
- Stack traces and internal error details are not exposed in production responses
- Default configurations are secure — opting out of security requires explicit action
- Unused endpoints, ports, and services are disabled or removed
- Rate limiting is applied to authentication and public-facing endpoints

## How to reason

Start by identifying the trust boundaries in the architecture: where does
untrusted input enter, where is authentication checked, where is sensitive data
stored. Then trace each trust boundary through the source code. Every point
where untrusted data crosses a boundary without validation is a finding. When
you find a vulnerability, assign severity using the guide below. Be specific —
reference the exact file, function, or configuration entry. Do not flag things
as insecure without explaining the attack vector.

**Severity guide for security findings:**

| Severity | Criteria |
|----------|----------|
| `critical` | Remote code execution, authentication bypass, data breach |
| `high` | Injection, privilege escalation, significant information disclosure |
| `medium` | Missing validation on non-critical paths, insecure defaults |
| `low` | Informational — best practice violations with low exploitability |

## Output format

Respond with a single JSON object:

{
  "verdict": "pass" | "fail",
  "issues": [
    {
      "description": "string — what is wrong",
      "severity": "low" | "medium" | "high" | "critical",
      "location": "string — file path or endpoint",
      "suggestion": "string — how to fix it"
    }
  ],
  "confidence": 0.0-1.0,
  "evidence": [
    {
      "claim": "string — what you determined",
      "source": "string — artifact or file that supports it"
    }
  ]
}

On pass: issues is empty, confidence reflects how thoroughly you could verify.
On fail: at least one issue. Security findings are never downgraded without evidence.
```

---

## Stub templates

Stub templates are functional but minimal. They contain all six required sections
with shorter checklists. They can be expanded into full templates by adding
detailed checklist items per subsection.

### usability_check.md

**Category:** `usability` · **Method:** `both` · **Threshold:** `0.80`

```markdown
# Usability validation

## Your role

You are a usability reviewer. You determine whether the implementation provides
a clear, intuitive, and helpful experience for its intended users.

## What you have been given

- **requirements.md** — usability requirements and user-facing behavior
- **Source files (src/**/*)** — the implementation under review

## What to check

### Error messages and feedback

- Error messages are clear, specific, and actionable
- User-facing errors suggest how to fix the problem
- Success states provide confirmation where appropriate

### Discoverability and defaults

- Default values are sensible for the common case
- Configuration options are documented and discoverable
- API surfaces follow consistent naming conventions

### Accessibility and inclusivity

- Interactive elements are reachable and operable
- Color and visual indicators are not the sole means of conveying information
- Response formats support internationalization where required

## How to reason

Read requirements first, identify user-facing surfaces, then check source for
each. Prefer the user's perspective — what they see, what they expect, what
confuses them. Flag inconsistencies between requirements and implementation.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### reliability_check.md

**Category:** `reliability` · **Method:** `both` · **Threshold:** `0.85`

```markdown
# Reliability validation

## Your role

You are a reliability reviewer. You determine whether the implementation handles
failures gracefully, recovers correctly, and maintains availability under adverse
conditions.

## What you have been given

- **requirements.md** — reliability requirements and availability constraints
- **architecture.md** — failure modes, retry strategies, degradation plans

## What to check

### Retry and recovery

- Failed operations have defined retry strategies with backoff
- Retry limits are bounded to prevent infinite loops
- Circuit breakers exist for external service dependencies

### Graceful degradation

- The system remains partially functional when non-critical services fail
- Fallback behaviors are defined for each external dependency
- Degraded states are communicated to the caller

### Timeout and resource limits

- All external calls have timeouts defined
- Resource limits (memory, connections, file handles) are enforced
- Deadlock-prone patterns are absent from concurrent code

## How to reason

Identify every external dependency and failure mode from the architecture. For
each, trace the failure path: what happens, how is it detected, how does the
system recover. Missing failure handling is a finding.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### maintainability_check.md

**Category:** `maintainability` · **Method:** `llm` · **Threshold:** `0.75`

```markdown
# Maintainability validation

## Your role

You are a maintainability reviewer. You determine whether the implementation is
structured for long-term maintenance — readable, modular, and changeable.

## What you have been given

- **Source files (src/**/*)** — the implementation under review
- **architecture.md** — intended module boundaries and responsibilities

## What to check

### Complexity and readability

- Functions are short and focused on a single responsibility
- Control flow is shallow — minimal nesting of conditionals and loops
- Naming is consistent and self-documenting across modules

### Module cohesion and coupling

- Module boundaries match the architecture's component definitions
- Modules have high internal cohesion — related logic is co-located
- Inter-module dependencies are explicit and unidirectional

### Documentation and testability

- Public interfaces have sufficient documentation for a new contributor
- Module structure allows testing in isolation without excessive mocking
- Configuration is externalized, not hardcoded

## How to reason

Read the architecture for intended structure, then check whether source code
matches. Flag divergence between architectural intent and implementation reality.
Focus on changes that would be difficult or risky, not cosmetic style issues.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### compatibility_check.md

**Category:** `compatibility` · **Method:** `both` · **Threshold:** `0.85`

```markdown
# Compatibility validation

## Your role

You are a compatibility reviewer. You determine whether the implementation
maintains correct contracts with external consumers, platforms, and dependencies.

## What you have been given

- **requirements.md** — compatibility requirements and supported platforms
- **architecture.md** — interface contracts, protocol versions, dependency versions

## What to check

### API and interface stability

- Public API contracts match documented specifications
- Breaking changes are flagged and versioned
- Request and response schemas are backward-compatible

### Platform and dependency compatibility

- Declared runtime versions match requirements
- Third-party dependencies are compatible with target platforms
- Platform-specific code is correctly isolated behind abstractions

### Data format compatibility

- Data serialization formats match consumer expectations
- Schema evolution is handled (new fields, deprecated fields)
- Encoding and character handling is consistent across boundaries

## How to reason

Identify every external contract from requirements and architecture. For each,
verify that the implementation honors the contract. Breaking changes without
versioning are findings.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### compliance_check.md

**Category:** `compliance` · **Method:** `llm` · **Threshold:** `0.90`

```markdown
# Compliance validation

## Your role

You are a compliance reviewer. You determine whether the implementation meets
regulatory, legal, and licensing requirements relevant to the project.

## What you have been given

- **requirements.md** — compliance requirements, regulations, licensing constraints

## What to check

### Data handling and privacy

- Personal data collection, storage, and processing follows stated regulations
- Data retention and deletion policies are implemented as specified
- User consent mechanisms are present where required

### Licensing and attribution

- Third-party dependencies use compatible licenses
- Required attributions and license notices are present
- Proprietary code does not inadvertently include copyleft-licensed code

### Audit and reporting

- Audit trails exist for regulated operations
- Required logging and reporting mechanisms are implemented
- Compliance-relevant events are captured and queryable

## How to reason

Start with the explicit compliance requirements in requirements.md. For each
regulation or constraint, trace through to verify implementation. When
requirements reference specific regulations (GDPR, HIPAA, SOC 2), check that
the implementation addresses the cited provisions. Flag gaps between regulatory
requirements and implementation coverage.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### observability_check.md

**Category:** `observability` · **Method:** `both` · **Threshold:** `0.80`

```markdown
# Observability validation

## Your role

You are an observability reviewer. You determine whether the implementation
produces sufficient logs, metrics, and traces to support debugging, alerting,
and performance analysis in production.

## What you have been given

- **requirements.md** — observability requirements and monitoring constraints
- **architecture.md** — logging strategy, metrics architecture, trace design

## What to check

### Logging

- Log levels are used consistently (error, warn, info, debug)
- Log entries contain sufficient context for diagnosis (request ID, user ID, timestamps)
- Sensitive data is excluded from log output

### Metrics

- Key performance indicators defined in requirements have corresponding metrics
- Metrics are labeled for dimensional querying (endpoint, status, region)
- Aggregation granularity supports the stated alerting thresholds

### Tracing and alerting

- Request tracing spans cover critical paths end-to-end
- Trace context is propagated across service boundaries
- Alert conditions map to defined thresholds in requirements

## How to reason

Identify what an operator needs to diagnose issues in production. For each
critical path, verify that logging, metrics, and tracing provide enough signal.
Missing observability is a finding — you cannot debug what you cannot see.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### scalability_check.md

**Category:** `scalability` · **Method:** `both` · **Threshold:** `0.80`

```markdown
# Scalability validation

## Your role

You are a scalability reviewer. You determine whether the implementation can
handle growth in load, data volume, and user count within the architecture's
design parameters.

## What you have been given

- **requirements.md** — scalability targets and growth expectations
- **architecture.md** — scaling strategy, partitioning, resource allocation

## What to check

### Horizontal scaling

- Stateless components can be replicated without coordination
- Shared state is externalized to appropriate stores (cache, database)
- Load balancing strategy covers all entry points

### Data scaling

- Database queries use indexes appropriate for expected data volumes
- Large datasets use pagination, streaming, or batching
- Data partitioning strategy matches the access patterns

### Resource growth

- Memory usage grows sub-linearly with input size
- Connection pools and client pools scale with instance count
- Backpressure mechanisms prevent cascading failures under load

## How to reason

Identify growth axes from requirements (users, data, throughput). For each,
trace the architecture to find bottlenecks that would prevent scaling. Focus on
shared resources, single points of failure, and O(n) operations on large
datasets.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

### reproducibility_check.md

**Category:** `reproducibility` · **Method:** `llm` · **Threshold:** `0.85`
**Installed for:** research projects only

```markdown
# Reproducibility validation

## Your role

You are a reproducibility reviewer. You determine whether the implementation
can produce identical results given the same inputs, data, and configuration.

## What you have been given

- **requirements.md** — reproducibility requirements and experimental constraints

## What to check

### Environment and dependencies

- All dependencies are pinned to exact versions
- Random seeds are fixed and documented where randomness is used
- Environment configuration is fully captured and version-controlled

### Data and pipeline

- Data preprocessing steps are deterministic
- Data sources are referenced by version or hash, not mutable pointers
- Pipeline steps are ordered and idempotent

### Output verification

- Outputs include metadata sufficient to reproduce (config hash, input hash, timestamp)
- Intermediate results can be inspected without re-running the pipeline
- Non-deterministic sources (network calls, timing) are isolated and mocked

## How to reason

For research projects, reproducibility is a core requirement, not a nice-to-have.
Trace every source of non-determinism. If a step cannot be reproduced, the
result is not verifiable. Flag implicit dependencies on execution order,
filesystem state, or wall-clock time.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

## Meta-template for LLM-generated categories

When the Planner emits a new validation category not covered by built-in
templates, a prompt template must be generated. This section defines the
generation rules so that LLM-produced templates follow the same structure and
quality bar as the built-ins.

### 6-part generation process

1. **Role statement.** One sentence: "You are a {category} reviewer." Followed
   by a one-sentence summary of what the reviewer determines.

2. **Artifact list.** Determine which artifacts the category needs based on the
   category's concern. Reference the per-category slice table in validation.md.
   Use the exact artifact names (e.g., `requirements.md`, `src/**/*`).

3. **Checklist (5-7 items).** Write at least three `###` subsections, each with
   3-5 bullet-point checks. Checks must be specific, observable, and tied to
   artifacts. Avoid vague items like "check for problems."

4. **Reasoning guidance.** One paragraph explaining the reasoning strategy:
   what to read first, what to trace, what to prioritize. Include a statement
   about uncertainty handling.

5. **Severity guide.** Define what constitutes low/medium/high/critical for
   this specific category. If not defined, default severity is `medium`.

6. **Output format.** The standard `LLMCheckOutput` JSON schema — identical
   across all templates. Copy from the output schema section above.

### Common mistakes to avoid

- **Too many checks.** Templates over 2,000 tokens are rejected. Target
  5-7 checklist items total across all subsections.
- **Vague checks.** "Check for issues" is not a check. Every bullet must
  describe a specific, verifiable property.
- **Missing artifact reference.** Every check must be traceable to an artifact
  the LLM has access to. Checks about artifacts not in the slice are useless.
- **Inconsistent output.** The output format must be the standard JSON schema.
  Do not invent new fields or change the structure.
- **Overlapping categories.** A generated category must not duplicate checks
  already covered by an existing category. Reference existing categories and
  focus on what is unique.

### Worked example: accessibility_check.md

```markdown
# Accessibility validation

## Your role

You are an accessibility reviewer. You determine whether the implementation
meets accessibility standards so that users with disabilities can use the
system effectively.

## What you have been given

- **requirements.md** — accessibility requirements and target standards (WCAG level)
- **Source files (src/**/*)** — the implementation under review

## What to check

### Perceivable content

- Images have meaningful alt text or are marked decorative where appropriate
- Color is not the sole means of conveying information
- Text contrast ratios meet the specified WCAG level

### Operable interfaces

- All interactive elements are reachable via keyboard navigation
- Focus order follows a logical sequence
- Time-based interactions provide options to extend or disable timers

### Understandable and robust

- Form inputs have associated labels
- Error identification and suggestions are provided inline
- Markup uses semantic elements and validates against the specified standard

## How to reason

Identify the target WCAG level from requirements. Trace every user-facing
surface and verify each criterion. When a requirement is ambiguous about
accessibility, flag it rather than assuming compliance. Focus on barriers that
would prevent a user with disabilities from completing core tasks.

## Output format

{
  "verdict": "pass" | "fail",
  "issues": [
    { "description": "string", "severity": "low" | "medium" | "high" | "critical", "location": "string", "suggestion": "string" }
  ],
  "confidence": 0.0-1.0,
  "evidence": [{ "claim": "string", "source": "string" }]
}
```

---

## Template inventory

| File | Category | Method | Threshold | Ships as | Installed for |
|------|----------|--------|-----------|----------|--------------|
| `correctness_check.md` | correctness | both | 0.85 | full | all |
| `performance_check.md` | performance | both | 0.80 | full | all |
| `security_check.md` | security | both | 0.90 | full | all |
| `usability_check.md` | usability | both | 0.80 | stub | all |
| `reliability_check.md` | reliability | both | 0.85 | stub | all |
| `maintainability_check.md` | maintainability | llm | 0.75 | stub | all |
| `compatibility_check.md` | compatibility | both | 0.85 | stub | all |
| `compliance_check.md` | compliance | llm | 0.90 | stub | all |
| `observability_check.md` | observability | both | 0.80 | stub | all |
| `scalability_check.md` | scalability | both | 0.80 | stub | all |
| `reproducibility_check.md` | reproducibility | llm | 0.85 | stub | research |
| `{custom}_check.md` | custom | varies | varies | generated | per-plan |

**Installed for** determines which templates are copied during `sle init` based
on project type. See validation.md §Template defaults by project type for the
mapping of project types to active categories.

---

## Project-local overrides

Projects may override any built-in template by placing a file at
`.sle/prompts/{category}_check.md`. The `llm-check` sub-phase checks for a
project-local override before falling back to the system default.

**Resolution order:**

1. `.sle/prompts/{category}_check.md` (project-local override)
2. System default template (shipped with the daemon)

**Staleness handling:**

If the system default template has been updated after the project-local override
was created (compared by modification timestamp of the shipped template), the
daemon logs a warning at startup:

```
WARN: project-local override for {category}_check.md may be stale
      (system template updated {date}). Consider reviewing or removing the override.
```

The daemon does not overwrite project-local overrides. The operator must
manually update or remove the override file.

---

## API contract

Template loading is performed by the validation subsystem. The following
endpoints manage templates at runtime.

### GET /api/v2/validation/templates

List all installed templates with metadata.

```typescript
interface TemplateListEntry {
  category: string
  source: 'built-in' | 'project-override' | 'generated'
  method: ValidationMethod
  threshold: number
  token_count: number
  valid: boolean
}
```

Response: `TemplateListEntry[]`

### GET /api/v2/validation/templates/{category}

Get the full content of a specific template.

```typescript
interface TemplateDetail {
  category: string
  content: string
  source: 'built-in' | 'project-override' | 'generated'
  token_count: number
  valid: boolean
  validation_errors: string[]
}
```

Response: `TemplateDetail`

### PUT /api/v2/validation/templates/{category}

Create or update a project-local override. Validates the template before
saving. Returns 400 if validation fails.

Request body: raw markdown content (`Content-Type: text/markdown`).

Response: `TemplateDetail` (after validation)

### DELETE /api/v2/validation/templates/{category}

Remove a project-local override and revert to the system default. Returns 404
if no project-local override exists. Does not affect system default templates.

Response: `TemplateDetail` (showing the reverted-to system default)

---

## Error cases

| Error | Condition | Response | Recovery |
|-------|-----------|----------|----------|
| `template_missing` | Template file not found for a category requiring `llm-check` | Downgrade method or skip category with warning | Install template or remove category from config |
| `template_invalid` | Template fails structural validation (missing sections, wrong format) | Daemon refuses to start with specific errors | Fix template structure or remove file |
| `template_too_large` | Template exceeds 2,000 token budget | Daemon refuses to start | Shorten template content |
| `template_override_corrupt` | Project-local override is malformed | Fall back to system default, log warning | Fix or delete override file |
| `template_override_stale` | System default updated after override was created | Log warning, continue with override | Review and update override manually |
| `output_parse_error` | LLM output does not match `LLMCheckOutput` schema | Treat as `fail` with confidence 0, log error | Improve template output format instructions |
| `output_verdict_missing` | LLM output lacks `verdict` field | Treat as `fail` with confidence 0 | — |

---

## Constraints

1. **Token budget.** Every template must fit within 2,000 tokens. The
   `llm-check` sub-phase prepends artifact slices to the template; the combined
   context must fit the agent's context window.

2. **Standard output schema.** Every template must produce the `LLMCheckOutput`
   JSON structure. No template may define a custom output format.

3. **Six-section structure.** Every template must contain all six sections in
   order. Missing sections cause validation failure at daemon start.

4. **Artifact alignment.** Artifacts listed in `## What you have been given`
   must match the slices defined in validation.md §Per-category llm-check
   artifact slices. Templates cannot reference artifacts the context manager does
   not provide.

5. **No execution instructions.** Templates must not instruct the LLM to run
   commands, access the filesystem, or make network requests.

6. **Severity consistency.** Templates that define custom severity criteria must
   use the standard severity levels (`low`, `medium`, `high`, `critical`). No
   custom severity values are allowed.

7. **Category uniqueness.** Each category maps to exactly one template file.
   Multiple templates for the same category are not supported.

8. **Generated template validation.** LLM-generated templates (from the
   meta-template process) must pass the same structural validation as built-in
   templates before being persisted.

---

## Open questions

| ID | Question | Impact | Status |
|----|----------|--------|--------|
| VP-001 | Should templates support conditional checks based on `PlanningDepth`? | Deep/research projects may want stricter checks | Open |
| VP-002 | Should the meta-template process validate generated templates against the project's actual artifact registry? | Prevents generated checks referencing non-existent artifacts | Open |
| VP-003 | What is the versioning strategy for built-in templates across daemon upgrades? | Stale override detection uses timestamps but no semantic version | Open |
| VP-004 | Should stub templates auto-expand to full templates when a category fails repeatedly across iterations? | Could improve retry quality but increases prompt complexity | Open |
| VP-005 | Can projects ship custom templates for categories not in the built-in inventory at init time? | Projects may need domain-specific categories (e.g., `localization_check.md`) before the Planner generates them | Open |
