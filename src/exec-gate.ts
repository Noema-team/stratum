import type { RuntimeMapManager } from './runtime-map.js';
import type { RunArtifactManager } from './run-artifacts.js';
import type { FailureReport } from './types.js';
import { ExecServiceReal, type ExecResult } from './exec-service.js';
import { promises as fs } from 'fs';
import path from 'path';
import { load as parseYAML } from 'js-yaml';

// ─── Types ────────────────────────────────────────────────────────────────────

export { ExecResult };

export interface ValidationGateResult {
  passed: boolean;
  next_node: 'EVALUATE' | null;
  failed_nodes: string[];
  failure_report?: FailureReport;
}

// ─── ExecService (Delegating to ExecServiceReal) ─────────────────────────────

export class ExecService {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async run(cycleNumber: number, iteration: number): Promise<ExecResult> {
    const projectRoot = (this.mapManager as any).projectRoot || process.cwd();
    const realService = new ExecServiceReal(this.mapManager, this.runArtifacts, projectRoot);
    return realService.run(cycleNumber, iteration);
  }
}

// ─── ValidationGateService (Deterministic validation.md Gate Verdict Evaluator) ──

export const VALIDATION_REQUIRED_NODES = ['BUILD', 'EXEC'] as const;

export class ValidationGateService {
  constructor(
    private mapManager: RuntimeMapManager,
    private runArtifacts: RunArtifactManager
  ) {}

  async run(
    cycleNumber: number,
    iteration: number,
    cycleId: string
  ): Promise<ValidationGateResult> {
    const startedAt = new Date().toISOString();
    const runDir = this.runArtifacts.runDir(cycleNumber, iteration);

    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'VALIDATION_GATE', {
      status: 'running',
      started_at: startedAt,
    });

    await this.mapManager.update((m) => ({
      ...m,
      meta: {
        ...m.meta,
        dag: m.meta.dag ? { ...m.meta.dag, current_node: 'VALIDATION_GATE' } : undefined,
      },
    }));

    // ─── Deterministic Gate Verdict Evaluation ───

    // 1. Load validation rules from rules/validation.yaml
    let validationConfig: any = null;
    try {
      const projectRoot = (this.mapManager as any).projectRoot || process.cwd();
      const configPath = path.join(projectRoot, '.sle', 'rules', 'validation.yaml');
      const content = await fs.readFile(configPath, 'utf-8');
      validationConfig = parseYAML(content);
    } catch {
      // Use fallback defaults
    }

    // 2. Load static analysis results from runs/{runId}/static-analysis/results.json
    let staticAnalysisResult = {
      lint: { errors: 0, warnings: 0, output: '' },
      typecheck: { errors: 0, output: '' },
      complexity: { files_over_threshold: [], max: 0 },
      passed: true,
    };

    try {
      const staticPath = path.join(runDir, 'static-analysis', 'results.json');
      const content = await fs.readFile(staticPath, 'utf-8');
      staticAnalysisResult = JSON.parse(content);
    } catch {
      // If file doesn't exist, check if static job failed in Exec
      const map = await this.mapManager.read();
      const execResult = (map.meta as any).dag?.exec_result;
      if (execResult && execResult.exit_code !== 0) {
        staticAnalysisResult.passed = false;
        staticAnalysisResult.lint.errors = 1;
      }
    }

    // 3. Load category results and merge with cached ones
    const map = await this.mapManager.read();
    const activeCategories = validationConfig?.categories?.map((c: any) => c.name) 
      || map.validation?.categories?.map((c: any) => c.name) 
      || ['correctness', 'performance', 'security'];

    const categoryResults: any[] = [];
    const failedCategories: string[] = [];
    const passedCategories: string[] = [];

    for (const catName of activeCategories) {
      // Check if category passed previously and is cached in map.yaml
      const mapCat = map.validation?.categories?.find((c: any) => c.name === catName);
      const isCached = mapCat?.status === 'passed';

      let catResult: any = {
        name: catName,
        method: mapCat?.method || 'executable',
        passed: true,
      };

      if (isCached) {
        // Cached pass!
        catResult.passed = true;
        passedCategories.push(catName);
      } else {
        // Read from test results runs/{runId}/tests/{category}/result.json
        try {
          const testPath = path.join(runDir, 'tests', catName, 'result.json');
          const content = await fs.readFile(testPath, 'utf-8');
          const testResult = JSON.parse(content);

          catResult.executable = {
            passed: testResult.passed ?? (testResult.failed_cases?.length === 0 && testResult.errors?.length === 0),
            passed_cases: testResult.passed_cases || [],
            failed_cases: testResult.failed_cases || [],
            errors: testResult.errors || [],
            metrics: testResult.metrics || {},
          };

          // Also check LLM checks if applicable
          if (catResult.method === 'llm' || catResult.method === 'both') {
            catResult.llm = {
              verdict: testResult.verdict || 'pass',
              confidence: testResult.confidence ?? 1.0,
              issues: testResult.issues || [],
              evidence: testResult.evidence || [],
            };
          }

          // Evaluate pass condition
          let passed = true;
          if (catResult.method === 'both') {
            passed = catResult.executable.passed && catResult.llm.verdict === 'pass' && catResult.llm.confidence >= (validationConfig?.categories?.find((c: any) => c.name === catName)?.llm?.pass_threshold ?? 0.85);
          } else if (catResult.method === 'llm') {
            passed = catResult.llm.verdict === 'pass' && catResult.llm.confidence >= (validationConfig?.categories?.find((c: any) => c.name === catName)?.llm?.pass_threshold ?? 0.85);
          } else {
            passed = catResult.executable.passed;
          }

          catResult.passed = passed;
        } catch {
          // Missing test results or run crash
          catResult.passed = false;
        }

        if (catResult.passed) {
          passedCategories.push(catName);
        } else {
          failedCategories.push(catName);
        }
      }

      categoryResults.push(catResult);
    }

    const staticPassed = staticAnalysisResult.passed;
    const gatePassed = staticPassed && failedCategories.length === 0;

    // 4. Update map.yaml validation status
    await this.mapManager.update((m) => {
      const completed = [...(m.meta.dag?.completed_nodes ?? [])];
      if (gatePassed && !completed.includes('VALIDATION_GATE')) {
        completed.push('VALIDATION_GATE');
      }
      const updated = {
        ...m,
        meta: {
          ...m.meta,
          dag: m.meta.dag
            ? { ...m.meta.dag, current_node: gatePassed ? 'EVALUATE' : null, completed_nodes: completed }
            : undefined,
        },
      };

      if (m.validation) {
        const categories = m.validation.categories.map((c: any) => {
          if (failedCategories.includes(c.name)) {
            return { ...c, status: 'failed' as const };
          }
          if (passedCategories.includes(c.name)) {
            return { ...c, status: 'passed' as const };
          }
          return c;
        });

        return {
          ...updated,
          validation: {
            ...m.validation,
            gate: {
              ...m.validation.gate,
              last_outcome: gatePassed ? ('passed' as const) : ('failed' as const),
              failed_categories: failedCategories,
            },
            categories,
          },
        };
      }
      return updated;
    });

    const completedAt = new Date().toISOString();
    await this.runArtifacts.updateNodeStatus(cycleNumber, iteration, 'VALIDATION_GATE', {
      status: gatePassed ? 'complete' : 'failed',
      completed_at: completedAt,
    });

    // Write manifest.json with outcome and lists
    let updatedManifest: any = {};
    try {
      const manifest = await this.runArtifacts.readManifest(cycleNumber, iteration);
      updatedManifest = {
        ...manifest,
        outcome: gatePassed ? 'complete' : 'halted',
        completed_at: completedAt,
        failed_categories: failedCategories,
        passed_categories: passedCategories,
        static_analysis: staticPassed ? 'passed' : 'failed',
        quick_summary: gatePassed
          ? `All ${passedCategories.length} validation categories passed successfully`
          : `Validation failed: static_check passed=${staticPassed}, ${failedCategories.length} categories failed`,
      };
      await fs.writeFile(
        path.join(runDir, 'manifest.json'),
        JSON.stringify(updatedManifest, null, 2),
        'utf-8'
      );
    } catch {
      // Manifest not found, construct default
      updatedManifest = {
        cycle_id: cycleId,
        cycle_number: cycleNumber,
        iteration: iteration,
        started_at: startedAt,
        outcome: gatePassed ? 'complete' : 'halted',
        completed_at: completedAt,
        failed_categories: failedCategories,
        passed_categories: passedCategories,
        static_analysis: staticPassed ? 'passed' : 'failed',
        quick_summary: gatePassed
          ? `All ${passedCategories.length} validation categories passed successfully`
          : `Validation failed: static_check passed=${staticPassed}, ${failedCategories.length} categories failed`,
      };
      await fs.writeFile(
        path.join(runDir, 'manifest.json'),
        JSON.stringify(updatedManifest, null, 2),
        'utf-8'
      );
    }

    const failureReport: FailureReport = {
      cycle: cycleNumber,
      iteration,
      run_dir: runDir,
      run_id: cycleId,
      quick_summary: updatedManifest.quick_summary,
      failed_categories: failedCategories.map((cat) => ({
        name: cat,
        method: 'executable',
        error_summary: `Category ${cat} failed validation gate checks`,
      })),
      passed_categories: passedCategories,
    };

    if (!gatePassed) {
      await this.runArtifacts.writeFailureReport(cycleNumber, iteration, failureReport);
      return { passed: false, next_node: null, failed_nodes: failedCategories, failure_report: failureReport };
    }

    return { passed: true, next_node: 'EVALUATE', failed_nodes: [] };
  }
}
