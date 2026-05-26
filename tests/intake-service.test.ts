import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { IntakeService, slugify } from '../src/intake-service.js';
import { LinkIndexManager } from '../src/link-index.js';
import type { RuntimeMap } from '../src/runtime-map.js';
import type { RuntimeMapManager } from '../src/runtime-map.js';

class InMemoryMapManager implements RuntimeMapManager {
  public map: RuntimeMap = {
    meta: { status: 'idle', active_cycle_id: null },
    cycle: { number: 1, iteration: 1, planning_depth: 'standard', status: 'idle' },
    artifacts: [],
  } as any;

  async read(): Promise<RuntimeMap> {
    return JSON.parse(JSON.stringify(this.map));
  }

  async update(fn: (m: RuntimeMap) => RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(this.map)))));
  }

  async write(m: RuntimeMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(m));
  }
}

test('slugify - converts names correctly', () => {
  assert.equal(slugify('Requirements-v2.md'), 'requirements-v2-md');
  assert.equal(slugify('Auth   Middleware'), 'auth-middleware');
});

test('IntakeService - scan, parse and generate meta JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-intake-test-'));
  const docsDir = join(root, '.sle', 'project-docs');
  await fs.mkdir(docsDir, { recursive: true });

  const docContent = `# Product Brief

This is a product brief for the authentication cycle.

## User Flow
- Login
- Register

## Security Requirements
**Database**: Postgres
**Port**: 8080
`;

  await fs.writeFile(join(docsDir, 'product-brief.md'), docContent, 'utf8');

  const mapManager = new InMemoryMapManager();
  const linkIndex = new LinkIndexManager(root);
  await linkIndex.load();

  const service = new IntakeService(root, mapManager, linkIndex);
  const docs = await service.runIntake();

  assert.equal(docs.length, 1);
  const doc = docs[0];
  assert.equal(doc.id, 'product-brief');
  assert.equal(doc.title, 'Product Brief');
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].id, 'user-flow');
  assert.equal(doc.sections[0].heading, 'User Flow');
  assert.equal(doc.sections[1].id, 'security-requirements');
  assert.equal(doc.sections[1].heading, 'Security Requirements');

  // Verify sidecar JSON was created
  const metaContent = await fs.readFile(join(docsDir, 'product-brief.md.meta.json'), 'utf8');
  const parsedMeta = JSON.parse(metaContent);
  assert.equal(parsedMeta.id, 'product-brief');
  assert.equal(parsedMeta.title, 'Product Brief');

  await fs.rm(root, { recursive: true, force: true });
});

test('IntakeService - coherence checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-coherence-test-'));
  const docsDir = join(root, '.sle', 'project-docs');
  await fs.mkdir(docsDir, { recursive: true });

  // Let's create two docs: requirements.md and architecture.md
  // requirements.md has conflicting constraint and wikilink to missing section
  const reqsContent = `# Reqs
  
## Requirements Section
**Database**: Postgres
This depends on [[doc:architecture#dangling-section]] and [[doc:non-existent]].

- **Session**: User session token.
`;

  const archContent = `# Arch

## Arch Section
**Database**: MongoDB

- **Session**: Conflicting session definition.
`;

  await fs.writeFile(join(docsDir, 'requirements.md'), reqsContent, 'utf8');
  await fs.writeFile(join(docsDir, 'architecture.md'), archContent, 'utf8');

  const mapManager = new InMemoryMapManager();
  const linkIndex = new LinkIndexManager(root);
  await linkIndex.load();

  const service = new IntakeService(root, mapManager, linkIndex);
  const docs = await service.runIntake();
  const report = await service.getCoherenceReport(docs);

  // Status must be blocked due to:
  // - Dangling reference to missing section 'dangling-section' (blocking)
  // - Direct contradiction database Postgres vs MongoDB (blocking)
  assert.equal(report.status, 'blocked');
  
  const contradictions = report.findings.filter(f => f.type === 'contradiction');
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].severity, 'blocking');
  assert.match(contradictions[0].description, /Postgres/);

  const undefinedRefs = report.findings.filter(f => f.type === 'undefined_reference');
  // 1 warning for non-existent document
  const warnings = undefinedRefs.filter(f => f.severity === 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].description, /non-existent/);

  // 1 blocking dangling section reference
  const blockings = undefinedRefs.filter(f => f.severity === 'blocking');
  assert.equal(blockings.length, 1);
  assert.match(blockings[0].description, /dangling-section/);

  const termConflicts = report.findings.filter(f => f.type === 'terminology_conflict');
  assert.equal(termConflicts.length, 1);
  assert.equal(termConflicts[0].severity, 'warning');

  await fs.rm(root, { recursive: true, force: true });
});

test('IntakeService - promotion creates graph node and link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sle-promote-test-'));
  const docsDir = join(root, '.sle', 'project-docs');
  await fs.mkdir(docsDir, { recursive: true });

  await fs.writeFile(join(docsDir, 'brief.md'), '# Brief\nSome content', 'utf8');

  const mapManager = new InMemoryMapManager();
  const linkIndex = new LinkIndexManager(root);
  await linkIndex.load();

  const service = new IntakeService(root, mapManager, linkIndex);
  await service.runIntake();

  const promoted = await service.promoteDocument('brief');
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.promoted_to_node, 'doc:brief');

  // Verify map updated
  const map = await mapManager.read();
  assert.ok(map.artifacts.some(a => a.path === 'docs/brief.md'));

  // Verify link added
  assert.ok(linkIndex['index'].links.length > 0);
  assert.deepEqual(linkIndex['index'].links[0].source, { kind: 'document', key: 'brief' });

  await fs.rm(root, { recursive: true, force: true });
});
