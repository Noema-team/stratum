import type Database from 'better-sqlite3';
import { DecisionRepository, WorkItemRepository } from '../storage/repositories.js';

export type AttentionCategory = 'decision_required' | 'work_failed' | 'work_blocked';
export type AttentionUrgency = 'blocking' | 'urgent' | 'normal';

export interface AttentionItem {
  category: AttentionCategory;
  urgency: AttentionUrgency;
  workItemId?: string;
  decisionId?: string;
  title: string;
  summary: string;
}

const URGENCY_ORDER: Record<AttentionUrgency, number> = { blocking: 0, urgent: 1, normal: 2 };

export class AttentionService {
  private readonly decisions: DecisionRepository;
  private readonly workItems: WorkItemRepository;

  constructor(db: Database.Database) {
    this.decisions = new DecisionRepository(db);
    this.workItems = new WorkItemRepository(db);
  }

  list(projectIds: string[]): AttentionItem[] {
    const items: AttentionItem[] = [];

    for (const projectId of projectIds) {
      // Pending decisions requiring human input.
      // Checkpoint Decisions always surface — the workflow cannot proceed without them.
      // Advisory decisions surface only when urgent or high-impact.
      for (const d of this.decisions.listPending(projectId)) {
        const isCheckpoint = d.type === 'checkpoint';
        const isUrgent = d.urgency === 'blocking' || d.urgency === 'urgent';
        const isHighImpact = d.impact === 'critical' || d.impact === 'high';
        if (isCheckpoint || isUrgent || isHighImpact) {
          items.push({
            category: 'decision_required',
            urgency: d.urgency as AttentionUrgency,
            workItemId: d.workItemId,
            decisionId: d.id,
            title: d.title,
            summary: d.summary,
          });
        }
      }

      // Failed work items
      for (const wi of this.workItems.listByState(projectId, 'failed')) {
        items.push({
          category: 'work_failed',
          urgency: 'urgent',
          workItemId: wi.id,
          title: wi.title,
          summary: `Work item failed`,
        });
      }

      // Blocked work items
      for (const wi of this.workItems.listByState(projectId, 'blocked')) {
        items.push({
          category: 'work_blocked',
          urgency: 'normal',
          workItemId: wi.id,
          title: wi.title,
          summary: `Work item is blocked`,
        });
      }
    }

    items.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
    return items;
  }
}
