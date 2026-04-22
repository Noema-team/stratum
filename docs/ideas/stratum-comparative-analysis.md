# Stratum vs Hermes — Comparative Analysis

**Date:** 2026-04-22

---

## Structural Comparison

| Concept | Hermes | Stratum |
|---------|--------|---------|
| **Orchestration** | Single-agent loop (`AIAgent`, 10.7k lines) | Multi-role DAG (Planner→Builder→Evaluator→Critic, 10 roles) |
| **Agent model** | One agent, one context, one model call at a time | DAG nodes executed by role-specific agents with isolated context |
| **Task lifecycle** | Free-form conversation turns | State machine with strict transitions (IDLE→PLANNING→CONFIRMING→EXECUTING→VALIDATING→COMPLETE) |
| **Validation** | None built-in (tools succeed or fail) | Dual-phase: LLM reasoning + executable scripts + deterministic gates |
| **Iteration** | Loop until iteration budget (90 turns) | Gate fail → iteration within cycle with failure report → retry |
| **Knowledge** | Skills (SKILL.md files) + Memory (MEMORY/USER.md) + Session search (SQLite FTS5) | Cognee (vector + graph search) + link index (agent memory) + content store |
| **Self-improvement** | Agent creates/patches skills after complex tasks | Not yet specified — gap |
| **Context management** | Frozen system prompt, compression at 50%/85% | Context manager assembles role-specific slices with token budgets (SLE-007) |
| **Configuration** | `config.yaml`, per-session overrides | 7 YAML rule files + map.yaml |
| **State persistence** | SQLite (sessions + FTS5) | map.yaml + Beads/Dolt |
| **Interfaces** | CLI + 18 messaging platforms + ACP (IDE) | CLI + REST/WebSocket daemon + Tauri graph dashboard |
| **Deployment** | Local, Docker, SSH, Daytona, Modal, Singularity | Docker container per validation cycle (DDR-008) |

---

## What Hermes Does Better

1. **Self-improvement loop** — The skill creation/patch/update cycle is the best implementation of "agent that learns" in any open-source agent. Stratum has no equivalent.

2. **Progressive disclosure** — Skill names only in prompt (~3k tokens), content loaded on demand. Stratum's context manager injects everything upfront.

3. **Knowledge capture granularity** — Domain skills capture specific gotchas, selectors, API shapes. Cognee retrieves by semantic similarity but doesn't capture *procedures*.

4. **Bounded memory** — Tiny, curated MEMORY.md + USER.md that's always in context. Complements the larger retrieval system without consuming context budget.

5. **Platform breadth** — 18 messaging adapters, cron scheduler, ACP integration. Not Stratum's focus, but the plugin architecture is clean.

---

## What Stratum Does Better

1. **Structured software lifecycle** — Multi-role DAG with validation gates is far more appropriate for "intent → working software" than a single agent free-styling.

2. **Validation system** — Dual-phase (LLM + executable) with deterministic gates. Hermes has no validation concept — tools succeed or fail, no gatekeeping.

3. **State machine rigor** — Strict transitions prevent the agent from going off-track. Hermes' free-form loop can spiral.

4. **Configuration-as-code** — 7 YAML rule files govern all behavior. Hermes uses a single config.yaml with runtime overrides.

5. **Artifact traceability** — Every DAG node produces artifacts with typed references (doc:{key}, node:{group}:{key}). Hermes has session history but no structured artifact system.

6. **Graph visualization** — Layered DAG dashboard with Sigma.js (100k+ nodes). Hermes is CLI/chat only.

---

## The Gap: Stratum Needs a Skills Layer

Hermes' biggest innovation — the self-improving skill system — has no equivalent in Stratum. This is a real gap.

### What's missing in Stratum today:

1. **No procedural memory** — Cognee does semantic retrieval, but doesn't capture step-by-step procedures with gotchas.
2. **No progressive disclosure** — Context manager injects everything relevant. No "load on demand" mechanism.
3. **No cross-cycle learning** — Each cycle starts fresh. Lessons from cycle N don't automatically inform cycle N+1.
4. **No gotcha persistence** — Validation failures produce failure reports, but the patterns aren't distilled into reusable knowledge.

### Proposal: Stratum Skills Layer

Add a skills layer that's **integrated with the existing DAG and content store**, not a parallel system:

#### 1. Per-group skill files in content store

After a cycle completes, the Evaluator/Critic agents write a skill file to the node group's content store:

```yaml
# content store: group:auth-module/skills/validation.md
---
name: auth-validation
triggers: [auth, login, session, token]
last_updated: 2026-04-22
success_rate: 0.85
---

## Gotchas
- NextAuth requires NEXTAUTH_URL set even in dev
- Cookie secure flag fails on HTTP — set to false in dev only
- Session JWT must include role claim for RBAC middleware

## Verification steps
1. POST /api/auth/signin → expect 302 redirect
2. Check session cookie: httpOnly, sameSite=lax
3. Call /api/auth/session → expect 200 with user object
4. Token expiry: default 24h, configurable via NEXTAUTH_SESSION_MAX_AGE
```

This uses the **existing content store** (SLE-015) and **layer module system** — no new storage mechanism.

#### 2. Progressive disclosure in context assembly

The context manager (SLE-007) already builds role-specific slices. Add a skill index as a lightweight layer:

```
Available skills (~2k tokens):
  auth-validation (triggers: auth, login, session) — success_rate: 0.85
  api-route-testing (triggers: api, rest, endpoint) — success_rate: 0.92
  db-migration (triggers: migration, schema, prisma) — success_rate: 0.78
```

When the Planner or Builder encounters a task matching a trigger, it requests the full skill via the content store API.

#### 3. Gotcha persistence from validation failures

When validation fails and the cycle iterates:
1. Failure report is generated (existing behavior)
2. Critic agent distills the failure into a gotcha entry
3. Gotcha is attached to the relevant node group's skill file
4. Future cycles in the same project auto-load these gotchas

#### 4. Bounded project memory

Add a small, always-in-context block (~1,500 tokens) alongside Cognee:

```markdown
═══ PROJECT MEMORY [72% — 1,080/1,500 chars] ═══
Stack: Next.js 14 + Prisma + PostgreSQL 16
Auth: NextAuth v5 with GitHub provider
Test: Vitest + Playwright for E2E
CI: GitHub Actions, lint before test
Gotcha: Prisma migrate needs --create-only in CI to review SQL
Gotcha: Next.js App Router caches fetch() by default — use { cache: 'no-store' }
```

This gives every agent role access to critical project context without a Cognee query, complementing (not replacing) the knowledge engine.

---

## Browser Harness Integration Plan

### Where it fits in Stratum

Browser-harness could serve as a **validation node type** in the DAG:

```
BUILD node → browser-check validation node
  → spawn container with browser-harness
  → navigate to built app (port forwarded from build container)
  → screenshot each route
  → compare against acceptance criteria
  → report visual/functional differences as validation failures
  → persist UI gotchas as skill entries
```

### Integration approach

1. **Not as a Hermes skill** — Stratum runs browser-harness directly, not through another agent
2. **Containerized** — runs inside Stratum's validation container (DDR-008) with headless Chrome
3. **Script-driven** — Stratum generates a browser-harness Python script from acceptance criteria, not free-form agent prompting
4. **Gotcha feedback loop** — failures are distilled into skill entries for future validation

### What to use from browser-harness

- `helpers.py` — the CDP primitives (click, screenshot, goto, js)
- `daemon.py` — the Unix socket relay (for container-internal communication)
- Domain skill format — for persisting UI-specific gotchas
- `http_get()` — for API/static page validation without browser overhead

### What NOT to use

- The `exec(stdin.read())` pattern — too freeform for Stratum's gated validation
- Self-editing helpers.py — Stratum should control the validation scripts, not the agent
- Browser Use cloud — Stratum should run headless Chrome in its own containers
