import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { WorkLease } from './types.js';

// SQLite-backed write-lease manager implementing §16.2 repository write safety.
// A write lease on (repositoryId) prevents a second work item from writing the
// same repository concurrently. A null repositoryId records a work-item-level
// lease for items with no associated repositories.
export class LeaseManager {
  private readonly acquireStmt: Database.Statement;
  private readonly releaseByWorkItemStmt: Database.Statement;
  private readonly activeWritesByRepoStmt: Database.Statement;
  private readonly expireStmt: Database.Statement;
  private readonly activeByWorkItemStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.acquireStmt = db.prepare(`
      INSERT INTO scheduler_leases (id, work_item_id, repository_id, lease_type, acquired_at, expires_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.releaseByWorkItemStmt = db.prepare('DELETE FROM scheduler_leases WHERE work_item_id = ?');
    this.activeWritesByRepoStmt = db.prepare(
      "SELECT * FROM scheduler_leases WHERE repository_id = ? AND lease_type = 'write' AND expires_at > ?"
    );
    this.expireStmt = db.prepare('DELETE FROM scheduler_leases WHERE expires_at <= ?');
    this.activeByWorkItemStmt = db.prepare(
      'SELECT * FROM scheduler_leases WHERE work_item_id = ? AND expires_at > ?'
    );
  }

  // Attempts to acquire a write lease for (workItemId, repositoryId).
  // Returns null if another work item holds an active write lease on the same repository.
  tryAcquireWrite(workItemId: string, repositoryId: string | null, expiryMs: number): WorkLease | null {
    const now = new Date().toISOString();

    if (repositoryId !== null) {
      const existing = this.activeWritesByRepoStmt.all(repositoryId, now) as Record<string, unknown>[];
      const conflict = existing.find(r => r.work_item_id !== workItemId);
      if (conflict) return null;
    }

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + expiryMs).toISOString();
    this.acquireStmt.run(id, workItemId, repositoryId, 'write', now, expiresAt, now);
    return { id, workItemId, repositoryId, leaseType: 'write', acquiredAt: now, expiresAt, heartbeatAt: now };
  }

  // Releases all leases held by a work item.
  releaseAll(workItemId: string): void {
    this.releaseByWorkItemStmt.run(workItemId);
  }

  // Deletes leases whose expiry has passed. Returns the count removed.
  expireOld(): number {
    const now = new Date().toISOString();
    return (this.expireStmt.run(now) as { changes: number }).changes;
  }

  // True if the work item holds at least one non-expired lease.
  hasActiveLease(workItemId: string): boolean {
    const now = new Date().toISOString();
    const rows = this.activeByWorkItemStmt.all(workItemId, now) as Record<string, unknown>[];
    return rows.length > 0;
  }
}
