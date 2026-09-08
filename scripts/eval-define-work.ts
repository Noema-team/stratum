#!/usr/bin/env node
// D.3d — Layer B: live-provider behavioral qualification for define-work.
//
// Runs the SAME three scenarios as tests/d3d-behavioral-qualification.test.ts
// (Layer A) — early/partial/mature Evershift-style Objectives, against
// isolated Git fixture repositories — but through the ACTUAL configured
// production provider/model (resolveLLMProvider, the same function
// createStratumApplication uses), not a scripted one. Layer A proves the
// mechanism; this proves the real model follows the methodology.
//
// Deliberately NOT part of `npm test`/`npm run verify`: it needs network
// access and real LLM credentials, and its output is not reproducible
// (a live model's exact wording varies run to run) — CI must stay
// deterministic and credential-free.
//
// Usage: npm run eval:define-work
//
// Provider/model resolution: reads `.sle/settings.json` under a fixture
// project root exactly the way createStratumApplication does (via
// resolveLLMProvider) — set STRATUM_EVAL_SETTINGS to a JSON file to copy
// into each fixture root's `.sle/settings.json` before the run, or rely on
// the provider's own default env-var lookup (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, or SLE_LLM_API_KEY). No model is hard-coded here.

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { resolveLLMProvider } from '../src/application.js';
import {
  EARLY_OBJECTIVE, EARLY_FIXTURE_FILES,
  PARTIAL_OBJECTIVE, PARTIAL_FIXTURE_FILES,
  MATURE_OBJECTIVE, MATURE_FIXTURE_FILES,
  findSamePlatformOnlyOption,
  type FixtureFile, type ObjectiveIntent,
} from '../tests/fixtures/d3d/fixtures.js';
import {
  driveDefineWorkRun, runOracle,
  type DefineWorkTrace, type ScenarioId, type OracleResult,
} from '../tests/fixtures/d3d/harness.js';

interface ScenarioDef {
  scenarioId: ScenarioId;
  objectiveIntent: ObjectiveIntent;
  fixtureFiles: FixtureFile[];
}

const SCENARIOS: ScenarioDef[] = [
  { scenarioId: 'early', objectiveIntent: EARLY_OBJECTIVE, fixtureFiles: EARLY_FIXTURE_FILES },
  { scenarioId: 'partial', objectiveIntent: PARTIAL_OBJECTIVE, fixtureFiles: PARTIAL_FIXTURE_FILES },
  { scenarioId: 'mature', objectiveIntent: MATURE_OBJECTIVE, fixtureFiles: MATURE_FIXTURE_FILES },
];

// D.3d.2 — cheap scenario-selective screening: `--scenario <early|partial|mature>`
// runs ONE scenario (candidate-model screening without paying for the full
// suite); no argument runs all three exactly as before. A full QUALIFIED
// verdict always requires the final combined run — screening never closes D.3d.
function parseScenarioFilter(argv: string[]): ScenarioDef[] {
  const flagIndex = argv.indexOf('--scenario');
  if (flagIndex === -1) return SCENARIOS;
  const id = argv[flagIndex + 1];
  const selected = SCENARIOS.find((s) => s.scenarioId === id);
  if (!selected) {
    console.error(
      `Unknown or missing --scenario value: ${id ?? '(none)'} — expected one of: ${SCENARIOS.map((s) => s.scenarioId).join(', ')}`,
    );
    process.exit(1);
  }
  return [selected];
}

// D.3d spec item 4: the human question must be resolved by matching a
// genuine option the workflow itself offered, never a hardcoded option id
// the live model has no obligation to reproduce. Only 'early' is expected
// to raise a legitimate Decision at all — any Decision on partial/mature is
// itself an oracle failure, not something this policy should paper over by
// guessing an answer.
//
// Chained decisions: the workflow explicitly supports several real human
// decisions in one run (one checkpoint per question). The scenario's scripted
// answer exists only for the cross-platform scope question — when that choice
// is among the offered options it is selected (findSamePlatformOnlyOption);
// for any OTHER genuine product question the run raises along the chain, the
// policy resolves the first offered option with a transparent rationale so
// the chain can proceed to the scope question. The specific resolution of
// non-scope questions is not under test — the fact that a genuine,
// non-repository-lookup question was asked IS — and every resolution lands in
// the report for human review.
function decisionPolicy(scenarioId: ScenarioId) {
  return (
    options: Array<{ id: string; label: string; description?: string }>,
    decision: { title: string },
  ): { selectedOptionId: string; rationale: string } | undefined => {
    if (scenarioId !== 'early') return undefined;
    const scripted = findSamePlatformOnlyOption(options);
    if (scripted) {
      return {
        selectedOptionId: scripted.id,
        rationale: `Same-platform only for this bounded increment (eval scenario policy; decision: "${decision.title}").`,
      };
    }
    const any = options[0];
    if (!any) return undefined;
    return {
      selectedOptionId: any.id,
      rationale: `Eval scenario policy — qualification proceeds past this additional genuine product question ("${decision.title}"); its specific resolution is not under test.`,
    };
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface ScenarioReport {
  scenarioId: ScenarioId;
  provider: string;
  model: string;
  runId: string;
  objective: { title: string; description: string };
  iterationsUsed: number;
  stepTrace: Array<{ stepId: string; success: boolean; reviewVerdict?: string; reviewRoute?: string; error?: string }>;
  decisionsRequested: Array<{
    title: string; summary: string;
    options: Array<{ id: string; label: string; description?: string }>;
    selectedOptionId?: string;
    resolved: boolean;
  }>;
  explorationArtifactPresent: boolean;
  finalArtifacts: Array<{ type: string; ref: string; path: string; hash: string }>;
  finalDefinitionHash: string | null;
  finalReadinessHash: string | null;
  oracle: OracleResult;
  overall: 'PASS' | 'FAIL' | 'ERROR';
  errorMessage?: string;
}

function providerLabel(provider: unknown): string {
  const ctor = (provider as { constructor?: { name?: string } })?.constructor?.name;
  return ctor ?? 'unknown';
}

async function runOneScenario(scenario: ScenarioDef, outDir: string): Promise<ScenarioReport> {
  const root = mkdtempSync(path.join(tmpdir(), `d3d-eval-${scenario.scenarioId}-`));
  try {
    const settingsOverride = process.env.STRATUM_EVAL_SETTINGS;
    if (settingsOverride && existsSync(settingsOverride)) {
      await fs.mkdir(path.join(root, '.sle'), { recursive: true });
      await fs.copyFile(settingsOverride, path.join(root, '.sle', 'settings.json'));
    }

    // D.3d — the SAME provider/model/completion-budget resolution
    // createStratumApplication uses. No bespoke provider path, no hard-coded
    // eval-only model or budget.
    const { provider, model, maxTokens } = resolveLLMProvider(root);

    let trace: DefineWorkTrace;
    let errorMessage: string | undefined;
    try {
      trace = await driveDefineWorkRun({
        scenarioId: scenario.scenarioId,
        root,
        fixtureFiles: scenario.fixtureFiles,
        objectiveIntent: scenario.objectiveIntent,
        provider,
        model,
        maxTokens,
        resolveDecision: decisionPolicy(scenario.scenarioId),
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      trace = {
        scenarioId: scenario.scenarioId, workflowRunId: '(none — run threw before completion)',
        finalStatus: 'halted', finalStepId: null, iterationsUsed: 0, steps: [], decisions: [],
        artifacts: [], definitionText: '', readinessText: null, explorationNeedText: null,
        toolUseRoundTrips: 0, noExtraWorkItemsCreated: true,
      };
    }

    const oracle = errorMessage
      ? { scenarioId: scenario.scenarioId, checks: [{ name: 'run completed without throwing', pass: false, detail: errorMessage }], pass: false }
      : runOracle(trace);

    // Persist the final artifacts (not the JSON report) so a human can read
    // the actual Definition/readiness/exploration-need text this run
    // produced — the JSON report itself carries only paths + hashes, never
    // full content or hidden reasoning.
    const scenarioOutDir = path.join(outDir, scenario.scenarioId);
    await fs.mkdir(scenarioOutDir, { recursive: true });
    if (trace.definitionText) await fs.writeFile(path.join(scenarioOutDir, 'definition.md'), trace.definitionText, 'utf-8');
    if (trace.readinessText) await fs.writeFile(path.join(scenarioOutDir, 'readiness.md'), trace.readinessText, 'utf-8');
    if (trace.explorationNeedText) await fs.writeFile(path.join(scenarioOutDir, 'exploration-need.md'), trace.explorationNeedText, 'utf-8');

    const report: ScenarioReport = {
      scenarioId: scenario.scenarioId,
      provider: providerLabel(provider),
      model,
      runId: trace.workflowRunId,
      objective: { title: scenario.objectiveIntent.title, description: scenario.objectiveIntent.description },
      iterationsUsed: trace.iterationsUsed,
      stepTrace: trace.steps.map((s) => ({
        stepId: s.stepId, success: s.success, reviewVerdict: s.reviewVerdict, reviewRoute: s.reviewRoute, error: s.error,
      })),
      decisionsRequested: trace.decisions.map((d) => ({
        title: d.title, summary: d.summary, options: d.options, selectedOptionId: d.selectedOptionId,
        resolved: d.selectedOptionId !== undefined,
      })),
      explorationArtifactPresent: trace.explorationNeedText !== null,
      finalArtifacts: trace.artifacts,
      finalDefinitionHash: trace.definitionText ? sha256(trace.definitionText) : null,
      finalReadinessHash: trace.readinessText ? sha256(trace.readinessText) : null,
      oracle,
      overall: errorMessage ? 'ERROR' : (oracle.pass ? 'PASS' : 'FAIL'),
      errorMessage,
    };
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function renderSummary(reports: ScenarioReport[]): string {
  const lines: string[] = [];
  lines.push('# D.3d define-work live-provider qualification');
  lines.push('');
  lines.push(`Provider: ${reports[0]?.provider ?? '(unknown)'}   Model: ${reports[0]?.model ?? '(unknown)'}`);
  lines.push('');
  lines.push('| Scenario | Iterations | Decisions | Exploration | Outcome |');
  lines.push('| -------- | ---------: | --------: | ----------: | ------- |');
  for (const r of reports) {
    lines.push(`| ${r.scenarioId} | ${r.iterationsUsed} | ${r.decisionsRequested.length} | ${r.explorationArtifactPresent ? 1 : 0} | ${r.overall} |`);
  }
  lines.push('');
  for (const r of reports) {
    lines.push(`## ${r.scenarioId} — ${r.overall}`);
    if (r.errorMessage) {
      lines.push(`Run error: ${r.errorMessage}`);
    } else {
      for (const c of r.oracle.checks) {
        lines.push(`- [${c.pass ? 'x' : ' '}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
    lines.push('');
  }
  lines.push('## Human-review checklist (short — not reducible to regexes)');
  lines.push('- [ ] Was the human question genuinely irreducible (a real product/architecture tradeoff, not a repository lookup)?');
  lines.push('- [ ] Was EXPLORE_AS_WORK genuinely build/measure work, not a repository lookup mislabeled as exploration?');
  lines.push('- [ ] Did the partial/mature cases avoid unnecessary scope expansion (no invented systems, no unasked-for brainstorming)?');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'eval-reports', `define-work-${timestamp}`);
  await fs.mkdir(outDir, { recursive: true });

  const reports: ScenarioReport[] = [];
  const selected = parseScenarioFilter(process.argv.slice(2));
  process.stdout.write(`Scenarios: ${selected.map((s) => s.scenarioId).join(', ')}\n`);
  for (const scenario of selected) {
    process.stdout.write(`Running scenario '${scenario.scenarioId}'...\n`);
    const report = await runOneScenario(scenario, outDir);
    reports.push(report);
    process.stdout.write(`  -> ${report.overall}\n`);
  }

  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(reports, null, 2), 'utf-8');
  const summary = renderSummary(reports);
  await fs.writeFile(path.join(outDir, 'summary.md'), summary, 'utf-8');

  process.stdout.write('\n' + summary + '\n');
  process.stdout.write(`Full report: ${path.join(outDir, 'report.json')}\n`);
  process.stdout.write(`Summary: ${path.join(outDir, 'summary.md')}\n`);

  const overallPass = reports.every((r) => r.overall === 'PASS');
  process.exitCode = overallPass ? 0 : 1;
}

main().catch((err) => {
  console.error('eval-define-work failed to run:', err);
  process.exitCode = 1;
});
