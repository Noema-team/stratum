// Commit C.3 — bootstrap identity and composition smoke tests
//
// Covers:
//   1. Bootstrap: fresh project → creates workspace + project, writes locator
//   2. Bootstrap: restart → recovers same identity from DB + locator
//   3. Bootstrap: missing locator (1 workspace, 1 project) → recovers silently, writes locator
//   4. Bootstrap: corrupt locator (malformed JSON) → recovers from unambiguous DB
//   5. Bootstrap: ambiguous DB (multiple workspaces, no locator) → fails with useful error
//   6. Bootstrap: locator mismatch with DB → fails with useful error
//   7. Composition smoke: start → GET /projects → POST work → POST ready → stop → restart → same identity

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { bootstrapLocalControlPlane } from '../src/api/bootstrap.js';
import { createStratumApplication } from '../src/application.js';
import { openDatabase } from '../src/storage/database.js';
import { WorkspaceRepository, ProjectRepository } from '../src/storage/repositories.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'sle-c3-test-'));
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function readLocatorFile(dir: string): { workspaceId?: string; projectId?: string } {
  const p = join(dir, '.sle', 'workspace.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as { workspaceId?: string; projectId?: string }; } catch { return {}; }
}

// ── Bootstrap tests ───────────────────────────────────────────────────────────

test('C3.bootstrap: fresh project creates workspace, project, and locator', () => {
  const dir = makeTmpDir();
  try {
    const result = bootstrapLocalControlPlane(dir);

    assert.ok(result.workspaceId, 'workspaceId returned');
    assert.ok(result.projectId, 'projectId returned');

    const locator = readLocatorFile(dir);
    assert.equal(locator.workspaceId, result.workspaceId, 'locator matches returned workspaceId');
    assert.equal(locator.projectId, result.projectId, 'locator matches returned projectId');

    // DB rows must exist
    const db = openDatabase(join(dir, '.sle', 'stratum.db'));
    const ws = new WorkspaceRepository(db);
    const pr = new ProjectRepository(db);
    const workspaces = ws.list();
    const projects = pr.listByWorkspace(result.workspaceId);
    db.close();

    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].id, result.workspaceId);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, result.projectId);
  } finally {
    cleanup(dir);
  }
});

test('C3.bootstrap: restart returns same identity', () => {
  const dir = makeTmpDir();
  try {
    const first = bootstrapLocalControlPlane(dir);
    const second = bootstrapLocalControlPlane(dir);

    assert.equal(second.workspaceId, first.workspaceId, 'workspaceId stable across restart');
    assert.equal(second.projectId, first.projectId, 'projectId stable across restart');
  } finally {
    cleanup(dir);
  }
});

test('C3.bootstrap: missing locator recovers from unambiguous DB', () => {
  const dir = makeTmpDir();
  try {
    const first = bootstrapLocalControlPlane(dir);
    const locatorPath = join(dir, '.sle', 'workspace.json');

    // Delete the locator file to simulate it going missing.
    rmSync(locatorPath);
    assert.ok(!existsSync(locatorPath), 'locator deleted');

    const second = bootstrapLocalControlPlane(dir);
    assert.equal(second.workspaceId, first.workspaceId, 'workspaceId recovered without locator');
    assert.equal(second.projectId, first.projectId, 'projectId recovered without locator');

    // Locator should have been re-written.
    assert.ok(existsSync(locatorPath), 'locator re-written after recovery');
  } finally {
    cleanup(dir);
  }
});

test('C3.bootstrap: corrupt locator (malformed JSON) recovers from unambiguous DB', () => {
  const dir = makeTmpDir();
  try {
    const first = bootstrapLocalControlPlane(dir);
    const locatorPath = join(dir, '.sle', 'workspace.json');

    // Corrupt the locator file.
    writeFileSync(locatorPath, '{ NOT VALID JSON', 'utf8');

    const second = bootstrapLocalControlPlane(dir);
    assert.equal(second.workspaceId, first.workspaceId, 'workspaceId recovered from corrupt locator');
    assert.equal(second.projectId, first.projectId, 'projectId recovered from corrupt locator');
  } finally {
    cleanup(dir);
  }
});

test('C3.bootstrap: ambiguous DB (multiple workspaces, no locator) throws useful error', () => {
  const dir = makeTmpDir();
  try {
    // Bootstrap once to create the DB and first workspace.
    bootstrapLocalControlPlane(dir);

    // Inject a second workspace directly into the DB.
    const dbPath = join(dir, '.sle', 'stratum.db');
    const db = openDatabase(dbPath);
    const wsRepo = new WorkspaceRepository(db);
    const prRepo = new ProjectRepository(db);
    const ws2Id = randomUUID();
    const p2Id = randomUUID();
    const now = new Date().toISOString();
    wsRepo.save({ id: ws2Id, name: 'other-workspace', createdAt: now });
    prRepo.save({ id: p2Id, workspaceId: ws2Id, name: 'other-project', status: 'active', priority: 0, createdAt: now, updatedAt: now });
    db.close();

    // Delete the locator so there's nothing to disambiguate.
    rmSync(join(dir, '.sle', 'workspace.json'));

    assert.throws(
      () => bootstrapLocalControlPlane(dir, dbPath),
      (err: Error) => err.message.includes('workspaces') && err.message.includes('locator'),
      'should throw with a message mentioning workspaces and locator',
    );
  } finally {
    cleanup(dir);
  }
});

test('C3.bootstrap: locator pointing to non-existent IDs throws useful error', () => {
  const dir = makeTmpDir();
  try {
    bootstrapLocalControlPlane(dir);

    // Overwrite locator with bogus IDs.
    const locatorPath = join(dir, '.sle', 'workspace.json');
    writeFileSync(locatorPath, JSON.stringify({ workspaceId: randomUUID(), projectId: randomUUID() }, null, 2), 'utf8');

    assert.throws(
      () => bootstrapLocalControlPlane(dir),
      (err: Error) => err.message.length > 0,
      'should throw when locator IDs do not exist in DB',
    );
  } finally {
    cleanup(dir);
  }
});

// ── Composition smoke test ────────────────────────────────────────────────────

test('C3.smoke: start → GET /projects → POST work → POST ready → stop → restart same identity', async () => {
  const dir = makeTmpDir();
  try {
    // --- First boot ---
    const { workspaceId, projectId } = bootstrapLocalControlPlane(dir);

    const app = createStratumApplication({ projectRoot: dir, workspaceId, port: 0 });
    await app.start();
    const base = `http://localhost:${app.controlPlaneServer.port}`;

    // GET /projects — should return the bootstrapped project
    const pr = await fetch(`${base}/projects`);
    const prBody = (await pr.json()) as { ok: boolean; data: Array<{ id: string; name: string }> };
    assert.equal(prBody.ok, true, 'GET /projects ok');
    assert.ok(prBody.data.some(p => p.id === projectId), 'bootstrapped project in list');

    // POST /projects/:id/work — create a draft work item
    const workRes = await fetch(`${base}/projects/${projectId}/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test work item', goal: 'Verify the system boots', workflowId: 'draft-artifact' }),
    });
    const workBody = (await workRes.json()) as { ok: boolean; data: { id: string; state: string } };
    assert.equal(workBody.ok, true, 'POST /projects/:id/work ok');
    assert.equal(workBody.data.state, 'draft', 'new work item is draft');
    const workItemId = workBody.data.id;

    // POST /work/:id/ready — draft → ready
    const readyRes = await fetch(`${base}/work/${workItemId}/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const readyBody = (await readyRes.json()) as { ok: boolean; data: { state: string } };
    assert.equal(readyBody.ok, true, 'POST /work/:id/ready ok');
    assert.equal(readyBody.data.state, 'ready', 'work item transitioned to ready');

    await app.stop();

    // --- Restart: same identity ---
    const second = bootstrapLocalControlPlane(dir);
    assert.equal(second.workspaceId, workspaceId, 'workspaceId stable after restart');
    assert.equal(second.projectId, projectId, 'projectId stable after restart');

    const app2 = createStratumApplication({ projectRoot: dir, workspaceId: second.workspaceId, port: 0 });
    await app2.start();
    const base2 = `http://localhost:${app2.controlPlaneServer.port}`;

    // GET /projects — still has the same project
    const pr2 = await fetch(`${base2}/projects`);
    const pr2Body = (await pr2.json()) as { ok: boolean; data: Array<{ id: string }> };
    assert.equal(pr2Body.ok, true);
    assert.ok(pr2Body.data.some(p => p.id === projectId), 'project persists after restart');

    // GET /work/:id — work item state persists
    const wi2 = await fetch(`${base2}/work/${workItemId}`);
    const wi2Body = (await wi2.json()) as { ok: boolean; data: { state: string } };
    assert.equal(wi2Body.ok, true, 'work item accessible after restart');
    assert.equal(wi2Body.data.state, 'ready', 'work item state persists across restart');

    await app2.stop();
  } finally {
    cleanup(dir);
  }
});
