// E11 review — credential migration on POST /api/v2/settings.
//
// The masked-key contract ("keep the stored credential") is valid ONLY for
// a SAME-provider edit. When the provider CHANGES (legacy Z.ai Coding Plan
// 'glm' → OpenRouter), the old credential must NEVER be carried across:
// the migration either requires an explicit new key, or deliberately uses
// the NEW provider's configured environment credential — and a failed
// migration must not corrupt the previous configuration.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { DaemonServer } from '../src/daemon.js';

const MASKED = '••••••••';
const LEGACY_SETTINGS = JSON.stringify({
  provider: 'glm',
  model: 'glm-5.3-flash',
  base_url: 'https://api.z.ai/api/coding/paas/v4',
  api_key: 'zai-secret-cred',
}, null, 2);

interface Res { statusCode: number; body: string }

function makeRequest(server: DaemonServer, method: string, path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port: server.getPort(), method, path, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode as number, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withMigrationServer(
  fn: (server: DaemonServer, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'e11-migration-'));
  const prevCwd = process.cwd();
  const prevOpenrouter = process.env.OPENROUTER_API_KEY;
  const prevSle = process.env.SLE_LLM_API_KEY;
  mkdirSync(join(root, '.sle'), { recursive: true });
  writeFileSync(join(root, '.sle', 'settings.json'), LEGACY_SETTINGS, 'utf-8');
  process.chdir(root);
  const server = new DaemonServer();
  try {
    await server.start({ port: 0 } as never, {
      stateAPI: { onStateChanged: () => {} } as never,
      pidFile: { writePidFile: () => {}, removePidFile: () => {} },
    } as never);
    await fn(server, root);
  } finally {
    await server.stop();
    process.chdir(prevCwd);
    if (prevOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenrouter;
    if (prevSle === undefined) delete process.env.SLE_LLM_API_KEY;
    else process.env.SLE_LLM_API_KEY = prevSle;
    rmSync(root, { recursive: true, force: true });
  }
}

test('E11: legacy glm → openrouter with masked key and NO new credential is rejected, previous config intact', async () => {
  await withMigrationServer(async (server, root) => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SLE_LLM_API_KEY;

    const res = await makeRequest(server, 'POST', '/api/v2/settings', {
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'z-ai/glm-5.3-flash',
      api_key: MASKED,
    });

    assert.strictEqual(res.statusCode, 422, 'missing new credential must be rejected');
    const err = JSON.parse(res.body);
    assert.match(err.error?.message ?? err.message ?? '', /never reused|OPENROUTER_API_KEY/);
    // The previous configuration is NOT corrupted: settings still name glm.
    const onDisk = JSON.parse(readFileSync(join(root, '.sle', 'settings.json'), 'utf-8'));
    assert.strictEqual(onDisk.provider, 'glm');
    assert.strictEqual(onDisk.api_key, 'zai-secret-cred');
    // Nothing was activated either.
    assert.strictEqual(process.env.OPENROUTER_API_KEY, undefined);
  });
});

test('E11: legacy glm → openrouter with masked key uses the OpenRouter env credential, never the Z.ai key', async () => {
  await withMigrationServer(async (server, root) => {
    process.env.OPENROUTER_API_KEY = 'or-env-cred';

    const res = await makeRequest(server, 'POST', '/api/v2/settings', {
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'z-ai/glm-5.3-flash',
      api_key: MASKED,
    });

    assert.strictEqual(res.statusCode, 200, res.body);
    const onDisk = JSON.parse(readFileSync(join(root, '.sle', 'settings.json'), 'utf-8'));
    assert.strictEqual(onDisk.provider, 'openrouter');
    // The Z.ai credential was NOT carried across — no stored key at all.
    assert.notStrictEqual(onDisk.api_key, 'zai-secret-cred');
    assert.strictEqual(onDisk.api_key, '');
    // The environment credential was NOT overwritten by the old provider's key.
    assert.strictEqual(process.env.OPENROUTER_API_KEY, 'or-env-cred');
  });
});

test('E11: same-provider masked edit still reuses the stored credential', async () => {
  await withMigrationServer(async (server, root) => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SLE_LLM_API_KEY;
    // Existing OPENROUTER project with a stored key: masked edit keeps it.
    writeFileSync(
      join(root, '.sle', 'settings.json'),
      JSON.stringify({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', base_url: 'https://openrouter.ai/api/v1', api_key: 'stored-or-key' }, null, 2),
      'utf-8',
    );

    const res = await makeRequest(server, 'POST', '/api/v2/settings', {
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'z-ai/glm-5.3-flash',
      api_key: MASKED,
    });

    assert.strictEqual(res.statusCode, 200, res.body);
    const onDisk = JSON.parse(readFileSync(join(root, '.sle', 'settings.json'), 'utf-8'));
    assert.strictEqual(onDisk.provider, 'openrouter');
    assert.strictEqual(onDisk.api_key, 'stored-or-key');
  });
});
