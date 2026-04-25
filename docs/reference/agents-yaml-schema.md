# agents.yaml Schema

**Type:** reference · **Status:** draft · **Updated:** 2026-04-17

Authoritative schema for `agents.yaml` — the 7th rule file. Configures all 10
agent roles, LLM provider connections, and per-role overrides for model,
temperature, token limits, and system prompts.

Generated at `sle init` with sensible defaults. Users customize provider
credentials and model choices post-init. Merged via the standard rule file
pipeline (defaults → `.sle/rules/agents.yaml` → `.sle/overrides/agents.yaml`).

**Key decisions reflected:**

| Decision | What it sets |
|---|---|
| DDR-003 | LLM provider config: `provider`, `base_url`, `model`, `api_key_env` |
| DDR-019 | Designer owns `requirements.md` + `architecture.md`; Planner owns `test-plan.md` + `plan.md` + `build-plan` (deep/research) |
| DDR-022 | Critic runs at DESIGN node, reviews architecture + requirements |
| DDR-023 | Explorer is user-initiated only; not auto-triggered by `planning.depth` |

---

## Annotated YAML schema

```yaml
defaults:
  llm:
    provider: openai_compatible
    base_url: "https://api.openai.com/v1"
    model: gpt-4o
    api_key_env: OPENAI_API_KEY
  temperature: 0.3
  max_tokens: 8000
  system_prompt_root: ".sle/prompts"


providers:
  openai:
    provider: openai_compatible
    base_url: "https://api.openai.com/v1"
    api_key_env: OPENAI_API_KEY

  openrouter:
    provider: openai_compatible
    base_url: "https://openrouter.ai/api/v1"
    api_key_env: OPENROUTER_API_KEY

  glm:
    provider: openai_compatible
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    api_key_env: GLM_API_KEY

  zai:
    provider: openai_compatible
    base_url: "https://api.zai.dev/v1"
    api_key_env: ZAI_API_KEY

  anthropic:
    provider: anthropic
    base_url: null
    api_key_env: ANTHROPIC_API_KEY


agents:
  designer:
    active: true
    node: design
    llm:
      model: gpt-4o
    temperature: 0.3
    max_tokens: 8000
    system_prompt: ".sle/prompts/designer.md"
    artifact_slice:
      - doc:requirements
      - doc:architecture
      - doc:decisions
      - doc:evaluation
    outputs:
      - doc:requirements
      - doc:architecture
    conditional: false

  explorer:
    active: false
    node: explore
    llm:
      model: gpt-4o
    temperature: 0.5
    max_tokens: 8000
    system_prompt: ".sle/prompts/explorer.md"
    artifact_slice:
      - doc:requirements
      - doc:evaluation
      - doc:decisions
    outputs:
      - doc:research_findings
    conditional: true
    condition: user_initiated

  planner:
    active: true
    node: plan
    llm:
      model: gpt-4o
    temperature: 0.3
    max_tokens: 8000
    system_prompt: ".sle/prompts/planner.md"
    artifact_slice:
      - doc:requirements
      - doc:architecture
      - doc:decisions
      - doc:evaluation
    outputs:
      - doc:test-plan
      - doc:plan
      - doc:build-plan
    conditional: false

  tester:
    active: true
    node: test
    llm:
      model: gpt-4o
    temperature: 0.1
    max_tokens: 8000
    system_prompt: ".sle/prompts/tester.md"
    artifact_slice:
      - doc:requirements
      - doc:test_plan
    outputs:
      - scripts/test_{category}.ts
    conditional: false
    constraints:
      - never_sees_builder_output

  builder:
    active: true
    node: build
    llm:
      model: gpt-4o
    temperature: 0.2
    max_tokens: 16000
    system_prompt: ".sle/prompts/builder.md"
    artifact_slice:
      - doc:requirements
      - doc:architecture
      - doc:test_plan
    outputs:
      - src/**
      - scripts/test_{category}.ts
    conditional: false

  debugger:
    active: true
    node: debug
    llm:
      model: gpt-4o
    temperature: 0.2
    max_tokens: 8000
    system_prompt: ".sle/prompts/debugger.md"
    artifact_slice:
      - doc:requirements
      - doc:test_plan
    outputs:
      - debug:diagnosis
      - debug:fix_recommendation
    conditional: true
    condition: gate_failure

  evaluator:
    active: true
    node: evaluate
    llm:
      model: gpt-4o
    temperature: 0.1
    max_tokens: 4000
    system_prompt: ".sle/prompts/evaluator.md"
    artifact_slice:
      - doc:requirements
      - doc:evaluation
      - doc:test_plan
    outputs:
      - doc:evaluation
    conditional: false

  critic:
    active: true
    node: critique
    llm:
      model: gpt-4o
    temperature: 0.5
    max_tokens: 4000
    system_prompt: ".sle/prompts/critic.md"
    artifact_slice:
      - doc:architecture
      - doc:requirements
      - doc:evaluation
    outputs:
      - critique:verdict
      - critique:issues
      - critique:suggestions
    conditional: true
    condition: depth_deep_or_research
    trigger_node: design

  historian:
    active: true
    node: history
    llm:
      model: gpt-4o
    temperature: 0.1
    max_tokens: 2000
    system_prompt: ".sle/prompts/historian.md"
    artifact_slice:
      - doc:decisions
    outputs:
      - doc:decisions
    conditional: false
    append_only: true

  facilitator:
    active: true
    node: null
    session_types:
      - discovery
      - chat
    llm:
      model: gpt-4o
    temperature: 0.4
    max_tokens: 4000
    system_prompt: ".sle/prompts/facilitator.md"
    artifact_slice:
      - doc:requirements
      - doc:architecture
      - doc:test_plan
      - doc:decisions
    outputs:
      - discovery:product_brief
      - discovery:success_definition
      - discovery:constraints
      - discovery:stakeholders
      - discovery:system_description
      - discovery:vision
      - discovery:open_questions
      - discovery:project_plan
    conditional: false
```

---

## Section reference

### `defaults`

Default values applied to every agent unless overridden at the agent level.
Merged first in the resolution chain.

| Field | Type | Description |
|---|---|---|
| `llm.provider` | enum | `openai_compatible` or `anthropic` (DDR-003) |
| `llm.base_url` | string \| null | API base URL (null for Anthropic native SDK) |
| `llm.model` | string | Default model identifier |
| `llm.api_key_env` | string | Environment variable holding the API key |
| `temperature` | number | Default sampling temperature (0.0–1.0) |
| `max_tokens` | number | Default max output tokens |
| `system_prompt_root` | string | Directory containing prompt template files |

---

### `providers`

Named LLM provider configurations. The factory (DDR-003) selects the correct
implementation (`OpenAICompatibleProvider` or `AnthropicProvider`) based on
`provider`.

| Field | Type | Description |
|---|---|---|
| `provider` | enum | `openai_compatible` or `anthropic` |
| `base_url` | string \| null | API endpoint (null for Anthropic — uses native SDK) |
| `api_key_env` | string | Environment variable name for the API key |

**Predefined providers:**

| Key | Implementation | `base_url` |
|---|---|---|
| `openai` | `OpenAICompatibleProvider` | `https://api.openai.com/v1` |
| `openrouter` | `OpenAICompatibleProvider` | `https://openrouter.ai/api/v1` |
| `glm` | `OpenAICompatibleProvider` | `https://open.bigmodel.cn/api/paas/v4` |
| `zai` | `OpenAICompatibleProvider` | Zai endpoint |
| `anthropic` | `AnthropicProvider` | null (native SDK) |

Users add custom providers by appending entries.

---

### `agents`

Per-role configuration. Each key is one of the 10 agent roles.

**Shared fields:**

| Field | Type | Description |
|---|---|---|
| `active` | boolean | Whether the role participates in cycles |
| `node` | string \| null | DAG node where the role executes (null for non-cycle roles) |
| `llm.provider` | enum? | Provider override (falls back to `defaults.llm.provider`) |
| `llm.base_url` | string? | Base URL override |
| `llm.model` | string? | Model override (falls back to `defaults.llm.model`) |
| `llm.api_key_env` | string? | API key env override |
| `temperature` | number | Sampling temperature |
| `max_tokens` | number | Max output tokens |
| `system_prompt` | string | Path to prompt template under `system_prompt_root` |
| `artifact_slice` | string[] | Artifacts loaded into the agent's context window |
| `outputs` | string[] | Artifacts or data the agent produces |
| `conditional` | boolean | Whether the role only runs under specific conditions |
| `condition` | string? | Trigger condition (only when `conditional: true`) |
| `constraints` | string[]? | Behavioral constraints enforced at runtime |
| `append_only` | boolean? | System only appends to the output artifact, never overwrites |
| `session_types` | string[]? | Sessions this role operates in (default: cycle) |
| `trigger_node` | string? | DAG node that triggers this conditional role |

---

### Per-role reference

| Role | Node | Temp | Tokens | Slice in | Outputs | Notes |
|---|---|---|---|---|---|---|
| **Designer** | `design` | 0.3 | 8000 | requirements, architecture, decisions, evaluation | requirements, architecture | Owns architecture + requirements (DDR-019). Critic reviews output (DDR-022). |
| **Explorer** | `explore` | 0.5 | 8000 | requirements, evaluation, decisions | research_findings | User-initiated only (DDR-023). Disabled by default. |
| **Planner** | `plan` | 0.3 | 8000 | requirements, architecture, decisions, evaluation | test-plan, plan, build-plan (deep/research) | Consumes Designer output (DDR-019). |
| **Tester** | `test` | 0.1 | 8000 | requirements, test_plan | test scripts | TDD separation: never sees Builder output. |
| **Builder** | `build` | 0.2 | 16000 | requirements, architecture, test_plan | implementation, test scripts | Highest token budget. Test scripts as contract. |
| **Debugger** | `debug` | 0.2 | 8000 | requirements, test_plan | diagnosis, fix_recommendation | Only on gate failure. Diagnoses only — never plans or builds. |
| **Evaluator** | `evaluate` | 0.1 | 4000 | requirements, evaluation, test_plan | evaluation | Structured verdict post-execution. |
| **Critic** | `critique` | 0.5 | 4000 | architecture, requirements, evaluation | verdict, issues, suggestions | At DESIGN node (DDR-022). Only at deep/research depth. |
| **Historian** | `history` | 0.1 | 2000 | decisions | decisions | Append-only. Runs after every agent turn. |
| **Facilitator** | null | 0.4 | 4000 | requirements, architecture, test_plan, decisions | 8 discovery docs | Discovery + chat only. Never builds. |

---

## Merge semantics

```
defaults.llm                        (shipped with @sle/sdk)
  ↓ deep merge
.sle/rules/agents.yaml → defaults  (project-level default overrides)
  ↓ deep merge per agent
.sle/rules/agents.yaml → agents.*  (per-role overrides)
  ↓ deep merge
.sle/overrides/agents.yaml          (user-created, highest priority)
  ↓
RuntimeConfig
```

**Resolution order for each agent field:**

1. Agent-level override in `.sle/overrides/agents.yaml`
2. Agent-level override in `.sle/rules/agents.yaml`
3. Default in `.sle/rules/agents.yaml → defaults`
4. Shipped default from `@sle/sdk`

`temperature`, `max_tokens`, and `system_prompt` resolve identically:
agent-level override wins, then `defaults`, then shipped values.

---

## Supported provider configurations

| Provider | `provider` value | `base_url` | `api_key_env` |
|---|---|---|---|
| OpenAI | `openai_compatible` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| OpenRouter | `openai_compatible` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| GLM (ZhipuAI) | `openai_compatible` | `https://open.bigmodel.cn/api/paas/v4` | `GLM_API_KEY` |
| Zai Coding Plan | `openai_compatible` | Zai endpoint | `ZAI_API_KEY` |
| Claude (Anthropic) | `anthropic` | null (native SDK) | `ANTHROPIC_API_KEY` |

---

## Mixed provider example

To route specific agents through Anthropic while keeping others on OpenAI,
override only the agents that change in `.sle/rules/agents.yaml`:

```yaml
agents:
  designer:
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      api_key_env: ANTHROPIC_API_KEY

  planner:
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      api_key_env: ANTHROPIC_API_KEY

  builder:
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      api_key_env: ANTHROPIC_API_KEY

  critic:
    llm:
      provider: anthropic
      model: claude-sonnet-4-20250514
      api_key_env: ANTHROPIC_API_KEY
```

All other fields inherit from `defaults`. Only the `llm` override is needed.

---

## LLM write boundary

The LLM may **only** append new categories to `validation.yaml → categories[]`
at planning time. No modifications to `agents.yaml` are permitted at runtime.
Enforced by the daemon's gated write API.
