import type { RuntimeMapManager } from '../runtime-map.js';

export async function updateArtifactEntries(
  mapManager: RuntimeMapManager,
  paths: string[],
  role: string,
): Promise<void> {
  if (paths.length === 0) return;
  const now = new Date().toISOString();
  await mapManager.update(m => ({
    ...m,
    artifacts: (() => {
      const updated = [...(m.artifacts ?? [])];
      for (const artifactPath of paths) {
        const idx = updated.findIndex(a => a.path === artifactPath);
        const entry = { path: artifactPath, generator: role, required: true, last_updated: now, dirty: false };
        if (idx >= 0) updated[idx] = { ...updated[idx], ...entry };
        else updated.push(entry as typeof updated[number]);
      }
      return updated;
    })(),
  }));
}
