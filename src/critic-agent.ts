import type { ILLMProvider } from './llm-provider.js';
import type { CritiqueResult } from './types.js';
import { CritiqueResultSchema } from './types.js';

export class CriticAgent {
  constructor(
    private llmProvider: ILLMProvider,
    private model: string
  ) {}

  async critique(params: {
    architecture: string;
    requirements: string;
    contextSummary: string;
    decisions: string;
    priorEvaluation?: string;
  }): Promise<CritiqueResult> {
    const systemPrompt = `You are the Critic agent. Your role is to review the Designer's proposed architecture and requirements for structural issues before planning begins.
You must analyze the inputs carefully and look for flaws, inconsistent API boundaries, design anti-patterns, missing requirements, or contradictions.

You must reply ONLY with a valid JSON object matching the following structure:
{
  "blocking_issues": ["issue 1", "issue 2", ...],
  "warnings": ["warning 1", ...],
  "suggestions": ["suggestion 1", ...],
  "pass": false
}

Set "pass" to true if there are absolutely no blocking issues. If there are any blocking issues that must be resolved before proceeding, set "pass" to false. Do not include any conversational preamble or postscript. Reply only with the raw JSON.`;

    const userMessage = `## Current Design Drafts

### requirements.md
${params.requirements || 'Not provided'}

### architecture.md
${params.architecture || 'Not provided'}

## Project Context
${params.contextSummary || 'Not provided'}

## Decisions History
${params.decisions || 'Not provided'}

${params.priorEvaluation ? `## Prior Cycle Evaluation\n${params.priorEvaluation}\n` : ''}`;

    const completionParams = {
      model: this.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userMessage }
      ],
      temperature: 0.2, // Low temperature for high precision/consistency
      max_tokens: 4000,
    };

    try {
      const result = await this.llmProvider.complete(completionParams);
      return this.parseCritique(result.content);
    } catch (err) {
      return {
        blocking_issues: [],
        warnings: [`Critic LLM failed to execute: ${(err as Error).message}`],
        suggestions: [],
        pass: true, // Advisory by default
      };
    }
  }

  private parseCritique(rawContent: string): CritiqueResult {
    const trimmed = rawContent.trim();
    
    // Try to extract JSON from a markdown code block if present
    const jsonMatch = trimmed.match(/```(?:json)?\n([\s\S]*?)\n```/) || trimmed.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : trimmed;
    
    try {
      const parsed = JSON.parse(jsonString.trim());
      return CritiqueResultSchema.parse(parsed);
    } catch (err) {
      // Fallback in case of parse/validation failure
      return {
        blocking_issues: [],
        warnings: [`Critic LLM response failed to parse as valid CritiqueResult: ${(err as Error).message}. Raw output: ${trimmed}`],
        suggestions: [],
        pass: true, // Advisory by default, do not block the cycle on failure
      };
    }
  }
}
