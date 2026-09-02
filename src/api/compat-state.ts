// Canonical compatibility status projection scoped to a single workspace.
// All counts and pending-Decision queries join through projects.workspace_id
// so results are never polluted by a second workspace sharing the same DB.

import type Database from 'better-sqlite3';

export interface CompatSystemState {
  state: 'idle' | 'cycling' | 'halted';
  awaitingConfirmation: boolean;
  awaitingShardingApproval: boolean;
}

export function getCompatSystemState(
  db: Database.Database,
  workspaceId: string,
): CompatSystemState {
  const rows = db.prepare(`
    SELECT wi.state, COUNT(*) as n
    FROM work_items wi
    JOIN projects p ON wi.project_id = p.id
    WHERE p.workspace_id = ?
      AND wi.state IN ('running', 'in_review', 'needs_decision', 'failed')
    GROUP BY wi.state
  `).all(workspaceId) as Array<{ state: string; n: number }>;

  const by: Record<string, number> = {};
  for (const r of rows) by[r.state] = r.n;

  let state: CompatSystemState['state'];
  if ((by['running'] ?? 0) > 0 || (by['in_review'] ?? 0) > 0) state = 'cycling';
  else if ((by['needs_decision'] ?? 0) > 0 || (by['failed'] ?? 0) > 0) state = 'halted';
  else state = 'idle';

  const pending = db.prepare(`
    SELECT d.subject_ref_json
    FROM decisions d
    JOIN work_items wi ON d.work_item_id = wi.id
    JOIN projects p ON wi.project_id = p.id
    WHERE p.workspace_id = ?
      AND d.status = 'pending'
      AND d.type = 'checkpoint'
  `).all(workspaceId) as Array<{ subject_ref_json: string }>;

  let awaitingConfirmation = false;
  let awaitingShardingApproval = false;

  for (const row of pending) {
    try {
      const ref = JSON.parse(row.subject_ref_json) as { stepId?: string };
      if (ref.stepId === 'confirm') awaitingConfirmation = true;
      if (ref.stepId === 'sharding_approval') awaitingShardingApproval = true;
    } catch {}
  }

  return { state, awaitingConfirmation, awaitingShardingApproval };
}

// Returns decision IDs of pending checkpoint Decisions scoped to the workspace
// whose subjectRef.stepId matches the given stepId.
export function findPendingCheckpointsByStep(
  db: Database.Database,
  workspaceId: string,
  stepId: string,
): string[] {
  const rows = db.prepare(`
    SELECT d.id, d.subject_ref_json
    FROM decisions d
    JOIN work_items wi ON d.work_item_id = wi.id
    JOIN projects p ON wi.project_id = p.id
    WHERE p.workspace_id = ?
      AND d.status = 'pending'
      AND d.type = 'checkpoint'
  `).all(workspaceId) as Array<{ id: string; subject_ref_json: string }>;

  return rows
    .filter(r => {
      try {
        const ref = JSON.parse(r.subject_ref_json) as { stepId?: string };
        return ref.stepId === stepId;
      } catch { return false; }
    })
    .map(r => r.id);
}
