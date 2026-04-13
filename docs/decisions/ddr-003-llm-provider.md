# DDR-003 — LLM provider — agnostic with two implementations

**Date:** 2026-04-13 · **Status:** accepted
**Resolves:** —

## Context
SLE needs to support multiple LLM providers. The question is whether to use a single adapter for all providers or separate implementations for providers with different API shapes.

## Options considered
| Option | Pros | Cons |
|--------|------|------|
| Abstract `LLMProvider` with two concrete implementations (`OpenAICompatibleProvider`, `AnthropicProvider`) | Clean separation; each implementation is simple; OpenAI-compatible covers most providers | Two implementations to maintain |
| Single adapter for all providers | One implementation | More complexity; Anthropic's SDK is different enough to require workarounds |

## Decision
Abstract `LLMProvider` with two concrete implementations: `OpenAICompatibleProvider` (covers OpenAI, OpenRouter, GLM, Zai, any compatible API) and `AnthropicProvider` (Claude via native Anthropic SDK).

## Consequences
- Switching providers is a config change in `agents.yaml` — no code changes needed
- Factory reads `agents.yaml` and returns the correct implementation
- Supported targets: OpenAI, OpenRouter, GLM, Zai Coding Plan (all via `OpenAICompatibleProvider`), Claude (via `AnthropicProvider`)
