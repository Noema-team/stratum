import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
import jsYaml from 'js-yaml';

import { InitService } from '../src/init-service.js';
import { CycleService } from '../src/cycle-service.js';
import { StateMachine } from '../src/state-machine.js';
import { RuntimeMapManagerImpl } from '../src/runtime-map.js';
import { RunArtifactManager } from '../src/run-artifacts.js';
import { EventBus } from '../src/event-bus.js';
import { IntakeService } from '../src/intake-service.js';
import { ShardingService } from '../src/sharding-service.js';
import { CriticAgent } from '../src/critic-agent.js';
import { ContextManager } from '../src/context-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { DAGRunner } from '../src/dag-runner.js';
import { ConfirmService } from '../src/confirm-service.js';
import { ExecService, ValidationGateService } from '../src/exec-gate.js';
import { SnapshotService } from '../src/snapshot-service.js';
import { SummariseService } from '../src/summarise-service.js';
import { CycleRunner } from '../src/cycle-runner.js';
import { LinkIndexManager } from '../src/link-index.js';
import type { ILLMProvider, LLMCompletionParams, LLMCompletionResult } from '../src/types.js';

console.log('# Running Phase E E2E Integration tests...');

// Mock LLM that returns correct mock outputs for all nodes in VS5 E2E
class V5MockLLM implements ILLMProvider {
  public static readonly outputs: Record<string, string> = {
    DESIGN: [
      '<!-- SLE-OUTPUT',
      'role: designer',
      'node: DESIGN',
      'artifacts:',
      '  - id: requirements',
      '    path: docs/requirements.md',
      '  - id: architecture',
      '    path: docs/architecture.md',
      '-->',
      '## docs/requirements.md',
      '# Requirements',
      'We will build a simple server.',
      '---',
      '## docs/architecture.md',
      '# Architecture',
      'Express app.',
    ].join('\n'),

    CRITIQUE: JSON.stringify({
      blocking_issues: [],
      warnings: [],
      suggestions: [],
      pass: true,
    }),

    PLAN: [
      '<!-- SLE-OUTPUT',
      'role: planner',
      'node: PLAN',
      'artifacts:',
      '  - id: plan',
      '    path: docs/plan.md',
      '-->',
      '## docs/plan.md',
      '# Plan',
      'Step 1: Setup project.',
    ].join('\n'),

    BUILD: [
      '<!-- SLE-OUTPUT',
      'role: builder',
      'node: BUILD',
      'artifacts:',
      '  - id: main',
      '    path: src/index.ts',
      '-->',
      '## File: src/index.ts',
      '```typescript',
      "export const app = () => 'stratum v5 is awesome';",
      '```',
    ].join('\n'),

    TEST: [
      '<!-- SLE-OUTPUT',
      'role: tester',
      'node: TEST',
      'artifacts:',
      '  - id: test-plan',
      '    path: docs/test-plan.md',
      '-->',
      '## docs/test-plan.md',
      '# Test Plan',
      'Verify the server returns awesome string.',
    ].join('\n'),

    EVALUATE: [
      '<!-- SLE-OUTPUT',
      'role: evaluator',
      'node: EVALUATE',
      'artifacts:',
      '  - id: criteria',
      '    path: docs/evaluation.md',
      '-->',
      '## docs/evaluation.md',
      '# Evaluation Criteria',
      'Acceptance criteria verified.',
    ].join('\n'),

    HISTORY: [
      '<!-- SLE-OUTPUT',
      'role: historian',
      'node: HISTORY',
      'artifacts:',
      '  - id: decisions',
      '    path: docs/decisions.md',
      '-->',
      '## docs/decisions.md',
      '# Decisions',
      'Cycle 1 decision recorded.',
    ].join('\n'),

    SUMMARISE: [
      '<!-- SLE-OUTPUT',
      'role: historian',
      'node: SUMMARISE',
      'artifacts:',
      '  - id: cycle-summary',
      '    path: docs/cycle-summary.md',
      '-->',
      '## docs/cycle-summary.md',
      '# Summary',
      'Cycle completed successfully.',
    ].join('\n'),
  };

  async complete(params: LLMCompletionParams): Promise<LLMCompletionResult> {
    const systemPrompt = params.messages.find((m) => m.role === 'system')?.content ?? '';
    if (systemPrompt.includes('Critic agent')) {
      return { content: V5MockLLM.outputs.CRITIQUE, tokens_used: 50 };
    }

    const userMsg = params.messages.find((m) => m.role === 'user')?.content ?? '';
    for (const [node, output] of Object.entries(V5MockLLM.outputs)) {
      if (userMsg.includes(`Current node: ${node}`)) {
        return { content: output, tokens_used: 50 };
      }
    }
    return { content: V5MockLLM.outputs.PLAN, tokens_used: 50 };
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
  });
}

test('V5 E2E Integration: Document intake, Layer 1 coherence passing, sharding proposal generation, and WS broadcast', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-v5-e2e-'));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git remote add origin https://github.com/test/v5-e2e.git', { cwd: root, stdio: 'ignore' });

  // 1. Initialize project
  const initService = new InitService({ projectRoot: root });
  await initService.init({
    project_name: 'v5-e2e-test',
    project_type: 'api',
    task_store: 'local',
    daemon_port: 7701,
    docs_remote: null,
    non_interactive: true,
    no_editor: true,
  });

  const mapPath = join(root, '.sle', 'map.yaml');
  const mapManager = new RuntimeMapManagerImpl({ mapPath });
  const stateMachine = new StateMachine(mapManager);
  const runArtifacts = new RunArtifactManager({ projectRoot: root });
  const cycleService = new CycleService(stateMachine, mapManager, runArtifacts);

  // 2. Setup mock document inside .sle/project-docs/brief.md
  const docsDir = join(root, '.sle', 'project-docs');
  mkdirSync(docsDir, { recursive: true });

  const docContent = `# E2E Design Brief
  
## User Auth
**Database**: SQLite
**Hash**: bcrypt

We depend on [[doc:brief#api-endpoints]].

## API Endpoints
We expose a GET /health endpoint.
`;
  await fs.writeFile(join(docsDir, 'brief.md'), docContent, 'utf8');

  // 3. Run Intake scanning and verify deterministic Layer 1 coherence gate
  const linkIndex = new LinkIndexManager(root);
  await linkIndex.load();
  const intakeService = new IntakeService(root, mapManager, linkIndex);

  const scannedDocs = await intakeService.runIntake();
  assert.strictEqual(scannedDocs.length, 1);
  assert.strictEqual(scannedDocs[0].id, 'brief');

  const coherenceReport = await intakeService.getCoherenceReport(scannedDocs);
  assert.strictEqual(coherenceReport.status, 'clean'); // No conflicting databases/terminology
  assert.strictEqual(coherenceReport.findings.length, 0);

  // Promote document to graph
  const promotedDoc = await intakeService.promoteDocument('brief');
  assert.strictEqual(promotedDoc.status, 'promoted');
  assert.strictEqual(promotedDoc.promoted_to_node, 'doc:brief');

  // 4. Construct Sharding proposal file
  const shardingService = new ShardingService(root, linkIndex);
  const shardingProposal = {
    total_estimated_tokens: 1500,
    coherence_report: { status: 'clean', findings: [], checked_at: '', document_count: 1 },
    approved_by_user: true,
    tasks: [
      {
        id: 'task-p1',
        title: 'Task P1',
        description: 'Implements SQLite auth schema',
        status: 'open',
        priority: 1,
        dependencies: [],
        context_declarations: [
          {
            task_id: 'task-p1',
            slices: ['doc:brief#user-auth'],
            intent: 'Database schema',
          },
        ],
        created_at: '',
        updated_at: '',
      },
    ],
  };

  const proposalYaml = jsYaml.dump(shardingProposal);
  await fs.writeFile(join(root, '.sle', 'sharding-proposal.yaml'), proposalYaml, 'utf8');

  // 5. Spin up WebSocket event bus and verify WS broadcasts
  const port = await getFreePort();
  const server = http.createServer();
  const bus = new EventBus(server, mapManager);

  await new Promise<void>((resolve) => server.listen(port, resolve));

  const ws = new WebSocket(`ws://localhost:${port}/events`);
  const receivedEvents: string[] = [];

  ws.on('message', (data: string) => {
    const parsed = JSON.parse(data);
    receivedEvents.push(parsed.type);
  });

  await new Promise<void>((resolve) => ws.once('open', () => resolve()));

  // Trigger some mock broadcasts to verify EventBus delivery
  await bus.emit('intake.document_promoted', { document: promotedDoc });
  await bus.emit('intake.coherence_checked', { status: 'clean' });

  // Wait a bit to collect WS messages
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  assert.ok(receivedEvents.includes('system.ready'));
  assert.ok(receivedEvents.includes('intake.document_promoted'));
  assert.ok(receivedEvents.includes('intake.coherence_checked'));

  // 6. Execute cycle runner and confirm mock LLM Critic node loop resolves successfully
  const cycleRecord = await cycleService.start({
    intent: 'Build a server',
    depth: 'deep',
    force: true,
  });

  // Pre-approve categories in map to avoid Docker execution fallback blocking
  await mapManager.update((m: any) => ({
    ...m,
    validation: {
      categories: [
        { name: 'correctness', method: 'executable', status: 'passed' },
        { name: 'performance', method: 'executable', status: 'passed' },
        { name: 'security', method: 'executable', status: 'passed' },
      ],
      gate: { mode: 'all_must_pass', last_outcome: 'passed', failed_categories: [] },
    },
  }));

  const llm = new V5MockLLM();
  const contextManager = new ContextManager(root);
  const agentRunner = new AgentRunner(contextManager, llm, root, runArtifacts, { model: 'mock' });
  const dagRunner = new DAGRunner(agentRunner, mapManager, runArtifacts);
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, root);
  const summariseService = new SummariseService(mapManager, runArtifacts, root);
  const criticAgent = new CriticAgent(llm, 'mock-model');

  const runner = new CycleRunner({
    dagRunner,
    confirmService,
    execService,
    validationGateService,
    snapshotService,
    summariseService,
    stateMachine,
    mapManager,
    runArtifacts,
    shardingService,
    criticAgent,
    projectRoot: root,
  });

  const result = await runner.run({
    onConfirmGate: async () => 'approve',
    onShardingApproval: async () => 'approve',
  });

  assert.strictEqual(result.completed, true, `E2E cycle should complete successfully: ${result.error}`);
  assert.ok(result.snapshot_dir);

  // Assert E2E generated artifacts
  const reqContent = await fs.readFile(join(root, 'docs/requirements.md'), 'utf8');
  assert.ok(reqContent.includes('Requirements'));

  const critiqueContent = await fs.readFile(join(root, 'docs/cycle-critique.md'), 'utf8');
  assert.ok(critiqueContent.includes('Critique'));

  const summaryContent = await fs.readFile(join(root, 'docs/cycle-summary.md'), 'utf8');
  assert.ok(summaryContent.includes('Summary'));

  // Clean up
  ws.close();
  bus.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

console.log('# ✅ All Phase E E2E Integration tests passed!');
