# Hermes ↔ Stratum Integration Analysis

**Date:** 2026-04-24
**Status:** discussion
**Context:** Follow-up to `stratum-comparative-analysis.md` and `developmentPlan/hermes-skills-and-tools-research.md`

---

## What this is

Two discussions:

1. **Naming** — whether "Stratum" fits the system, and alternatives
2. **Hermes integration** — three levels at which Hermes and Stratum can cross-pollinate, from borrowing concepts to deep runtime integration

---

## 1. Naming Discussion

### Why "Stratum" works

Stratum means "layer." The system IS layered — 5 platform layers, artifact layers, context layers. It's clean, memorable, and produces good CLI commands (`stratum init`, `stratum start`, `stratum discover`).

### Why it might not work

The name describes the architecture, not the behavior. The defining characteristic of this system is deterministic orchestration of adaptive agents — the layers are implementation detail.

### Proposals

| Name | Rationale | CLI feel | Concerns |
|---|---|---|---|
| **Stratum** (current) | Layered architecture | `stratum init` | Describes structure, not behavior |
| **Forge** | Takes raw intent, applies heat (iterations) and pressure (validation gates), produces tested steel | `forge init` | Industrial, grounded. May conflict with existing tools |
| **Loom** | Thread-by-thread deterministic weaving — each agent contributes one layer, the pattern is fixed | `loom init` | Craftsmanship metaphor. Less common in dev tools |
| **Canon** | Musical form where voices follow strict rules in sequence (literally a DAG of melodies); also means "accepted standard" | `canon init` | Double meaning: rigor AND authority. Strong |
| **Cadence** | Rhythmic cycle — intent → validate → snapshot, repeating with discipline | `cadence init` | Flow, rhythm. Also a Salesforce product |
| **Helix** | Spiral iterations that return to the same point but higher quality | `helix init` | Biological, evolving. Also a code editor |
| **Deteratum / Deterastrum** | "Deterministic" + "Stratum" portmanteau | `deteratum init` | Sounds pharmaceutical. Forced |

**Assessment:** Portmanteaus (deteratum, deterastrum) feel forced — the name shouldn't try to encode the entire philosophy. The deterministic nature is what the system *does*, not what it *is*. "Forge" and "Canon" are the strongest alternatives if Stratum doesn't feel right. Forge for the industrial metaphor (raw intent in, validated steel out). Canon for the musical one (strict sequential rules, multiple voices, beautiful output).

**Recommendation:** Keep Stratum unless a better name resonates on feel. The CLI command test is the real decider — say it out loud, type it 50 times.

---

## 2. Hermes Integration — Three Levels

### Level 1: Borrow Concepts (Stratum steals Hermes ideas)

Three things Hermes does that Stratum should adopt into its architecture.

#### 2.1.1 Self-improving prompts

**What Hermes does:** Agents write and patch their own skills after complex tasks. The skill system is writable by the agent.

**What Stratum currently does:** Prompt templates in `.sle/prompts/` are static — human-authored, never touched by the system.

**Proposal:** Allow agents to *propose* prompt improvements between cycles. The flow:

1. After several cycles, the Evaluator notices a pattern ("the Planner keeps overcomplicating test plans for simple features")
2. Evaluator proposes a prompt tweak as part of its `evaluation.md` output
3. Human reviews the proposal in `sle chat`
4. If approved, applied to the relevant prompt template or `agents.yaml` entry

**What Stratum adds that Hermes doesn't:** Human approval is enforced. Hermes agents modify skills freely; Stratum agents propose, humans decide. This matches the system's philosophy — deterministic with human checkpoints.

**Spec impact:** Add an optional `proposed_prompt_changes` field to the Evaluator's output contract in `agents.yaml`. Add a new section to `evaluation.md` schema. No changes to the DAG or rule files.

#### 2.1.2 Session search across cycles

**What Hermes does:** FTS5 search across all past sessions via `session_search` tool. Agent can query "last time we touched auth, what happened?"

**What Stratum currently has:** `decisions.md` (append-only), `evaluation.md` (per-cycle), but no cross-cycle semantic search. Cognee integration is spec'd but not yet positioned as "session search."

**Proposal:** Position the Cognee integration as Stratum's session search. After 50 cycles, the Planner can search "last time we touched the auth module, what went wrong?" and get relevant past cycle context. This requires:

- Cycle artifacts indexed into Cognee after SNAPSHOT
- A `context_search` provider interface in the context manager
- The Planner and Debugger receive search results as part of their artifact slice when relevant

**Spec impact:** Context manager gains a search capability. Cognee's role shifts from "optional knowledge engine" to "cross-cycle episodic memory." Still optional (`NoopProvider` when disabled), but more central to the architecture.

#### 2.1.3 Adaptive context compression for chat sessions

**What Hermes does:** Compresses conversation history when it hits 50% of context window. Protected head (system prompt + first 3 exchanges) and protected tail (recent turns). Middle gets LLM-summarized.

**What Stratum currently does:** Agent calls are fresh context per DAG node — no compression needed. But `sle chat` sessions grow unbounded.

**Proposal:** Borrow the compression pattern for the Facilitator's chat sessions:

- Protect head: bootstrap pair (agent.md + map.yaml) + first 3 exchanges
- Protect tail: last N exchanges (token-budget-based)
- Summarize middle: periodic compression when chat history exceeds threshold
- Append-only archive: compressed segments saved to `.sle/chat-archive/` for Cognee indexing

**Spec impact:** Facilitator gains a context management concern. `user_validation.yaml` could get a `chat_compression_threshold` setting. No DAG changes.

---

### Level 2: Hermes Skill for Stratum (Hermes learns Stratum's workflow)

**What:** Create a custom Hermes skill that teaches Hermes how Stratum works, so developers can use Hermes standalone on a Stratum-managed project with Stratum's discipline.

**Mechanism:**

```
~/.hermes/skills/stratum-builder/SKILL.md
```

The skill teaches Hermes:

1. **Read `map.yaml`** to understand current cycle state
2. **Read `.sle/rules/`** to understand active configuration
3. **Respect artifact ownership** — know which artifacts it can and cannot touch based on the current role
4. **Follow context isolation** — if acting as the Builder, do NOT seek out the Tester's reasoning
5. **TDD discipline** — tests from requirements, implementation satisfies tests
6. **Understand the DAG** — know the sequence and what each role produces/consumes

**When this is useful:**

- Developer wants the Stratum mental model without running the full 5-layer stack
- Hermes is building Stratum itself — the skill makes Hermes aware of what it's building
- Lightweight mode for small projects where the full daemon is overkill

**What this is NOT:** This is advisory, not enforced. Hermes follows the skill as instructions but nothing prevents it from breaking context isolation. The real Stratum daemon enforces these rules at the DAG level. This skill is a "best effort" mode for standalone Hermes use.

**Cost:** Writing one SKILL.md file. Zero code changes.

---

### Level 3: Hermes as Stratum's Agent Runtime (deep integration)

**What:** Replace raw LLM API calls in the daemon with Hermes subagent dispatches per DAG node.

```
Current:  Daemon → raw LLM API call per DAG node
Proposed: Daemon → Hermes subagent per DAG node
```

Each DAG node dispatches a Hermes `delegate_task` with:
- **Role-specific system prompt** (from `agents.yaml`)
- **Surgically scoped context** (from Stratum's context manager)
- **Restricted toolset** matching the role's needs

**Toolset mapping per role:**

| Stratum Role | Hermes toolset | Rationale |
|---|---|---|
| Designer | `file`, `terminal` (read-only) | Read specs, write architecture |
| Planner | `file`, `terminal` (read-only) | Read architecture, write plan |
| Tester | `file` only | Write test scripts, nothing else |
| Builder | `file`, `terminal` | Write code, run tests |
| Debugger | `file`, `terminal` | Read run artifacts, run diagnostics |
| Evaluator | `file` (read-only) | Only reads, produces verdict text |
| Explorer | `file`, `terminal`, `web`, `browser` | Research needs full access |
| Critic | `file` (read-only) | Reviews only, produces critique |
| Historian | `file` (read-only + append to decisions.md) | Append-only audit |
| Facilitator | `file`, `terminal`, `clarify` | Interactive Q&A with user |

**What this unlocks:**

- **Builder** gets `patch` (Hermes's fuzzy-matching file editor) instead of rewriting entire files
- **Debugger** gets `terminal` to run actual diagnostic commands instead of just reading logs
- **Explorer** gets `web_search` and `browser` for real research (currently the Explorer role is spec'd but has no search tools)
- **Tester** gets `execute_code` to validate test scripts syntactically before submitting them
- **All roles** benefit from Hermes's error handling (jittered backoff, provider failover, JSON repair)

**What Stratum still enforces that Hermes cannot override:**

| Concern | Enforced by | Hermes can bypass? |
|---|---|---|
| DAG sequence | Daemon state machine | No — daemon controls dispatch order |
| Context isolation | Context manager assembles slice | No — subagent receives only what daemon provides |
| Validation gates | Deterministic boolean logic | No — no LLM involvement in gate decision |
| Rule files | Daemon reads, agents cannot modify | No — rule files not in subagent context |
| Artifact ownership | Output contracts per role | Partially — subagent could write to wrong file, but daemon validates output |
| Iteration caps | Daemon counter | No — daemon tracks iterations, not the subagent |

**Architecture change:**

The daemon's agent runtime interface changes from:

```typescript
interface AgentRuntime {
  invoke(role: AgentRole, context: AgentContext): Promise<AgentOutput>;
}
```

To:

```typescript
interface AgentRuntime {
  invoke(role: AgentRole, context: AgentContext, toolset: string[]): Promise<AgentOutput>;
}
```

The rest of SLE — DAG runner, context manager, rule loader, validation gate, snapshot system — stays identical. The runtime is a pluggable component behind an interface.

**Two implementations:**

| Runtime | How it works | When to use |
|---|---|---|
| `DirectLLMRuntime` | Raw API call with system prompt + context slice | Lightweight, no Hermes dependency |
| `HermesRuntime` | `delegate_task` with scoped toolset | Full tool access per role |

Selected at daemon start via config. Both produce the same `AgentOutput` type. The DAG runner doesn't know which runtime is active.

**Risk assessment:**

| Risk | Impact | Mitigation |
|---|---|---|
| Hermes dependency for core function | Medium | `DirectLLMRuntime` as fallback, Hermes runtime is opt-in |
| Subagent context leakage | High | Context manager still assembles slices; Hermes subagent cannot access files outside its context |
| Latency (subagent startup) | Low | Subagents start fresh per task — no warm pool needed, overhead is ~1-2s |
| Toolset restriction bypass | Medium | Hermes subagent receives restricted toolset list; daemon validates output against role contract |
| Hermes API changes | Low | Interface abstraction insulates SLE from Hermes internals |

---

## 3. Integration Strategy

### Recommended order

1. **Now (planning phase):** Level 2 — write the Hermes skill. Zero cost, immediately useful when Hermes builds Stratum.

2. **Before agent runtime implementation:** Decide on Level 3. The `AgentRuntime` interface needs to support both `DirectLLMRuntime` and `HermesRuntime` from day one. If decided later, it requires refactoring the daemon's core dispatch loop.

3. **As system matures:** Level 1 — adopt self-improving prompts, session search, chat compression. These are enhancements that build on the core system.

### What not to do

- **Don't make Hermes a hard dependency.** Stratum must work with raw LLM calls. Hermes integration is a capability multiplier, not a requirement.
- **Don't let Hermes bypass the DAG.** The whole point of Stratum is deterministic orchestration. If Hermes subagents can skip nodes or reorder the sequence, the system loses its reason to exist.
- **Don't duplicate Hermes's tools.** If using Hermes as the runtime, Stratum doesn't need its own file editor, terminal tool, or browser harness. Delegate to Hermes's built-in tools via the restricted toolset.

---

## 4. See also

| Document | Relationship |
|---|---|
| [stratum-comparative-analysis.md](stratum-comparative-analysis.md) | Earlier Hermes vs Stratum comparison, gaps, skills layer proposal |
| [hermes-agent-architecture.md](../research/hermes-agent-architecture.md) | Hermes architecture deep dive |
| [../developmentPlan/hermes-agent.md](../developmentPlan/hermes-agent.md) | Hermes as the autonomous builder for Stratum |
| [../developmentPlan/hermes-skills-and-tools-research.md](../developmentPlan/hermes-skills-and-tools-research.md) | Hermes built-in dev skills, tools runtime, 53 tools reference |
| [../developmentPlan/hermes-official-docs-research.md](../developmentPlan/hermes-official-docs-research.md) | Hermes agent loop, prompt assembly, context engine, MCP, cron |
| [../overview/what-is-sle.md](../overview/what-is-sle.md) | Stratum core concepts and principles |
| [../overview/agent-roles.md](../overview/agent-roles.md) | All 10 agent roles with artifact ownership |
