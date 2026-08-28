import type { RuntimeMapManager } from './runtime-map.js';
import type { NodeTag, TagPrefix } from './types.js';

export class TagServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TagServiceError';
    this.code = code;
  }
}

export interface AddTagParams {
  prefix: TagPrefix;
  target_ref: string;
  value?: string;
  source?: 'user' | 'facilitator' | 'system';
}

/**
 * Tag CRUD over map.yaml → tags[]. Implements DDR-028's node/layer/group tagging
 * system: tags mark priority inputs for the next cycle's SCOPING node
 * (`#next-cycle`), scope drafts (`#scope:{draft-id}`), or arbitrary areas
 * (`#area:{name}`). `target_ref` identifies what's tagged, e.g. `node:{id}`,
 * `layer:{node_id}:{layer_id}`, or `group:{id}`.
 */
export class TagService {
  constructor(private mapManager: RuntimeMapManager) {}

  async addTag(params: AddTagParams): Promise<NodeTag> {
    if (!params.target_ref || params.target_ref.trim().length === 0) {
      throw new TagServiceError('invalid_target_ref', 'target_ref must be a non-empty string');
    }
    const tag: NodeTag = {
      prefix: params.prefix,
      target_ref: params.target_ref,
      value: params.value,
      source: params.source ?? 'user',
      applied_at: new Date().toISOString(),
    };
    await this.mapManager.update((m) => ({
      ...m,
      tags: [...(m.tags ?? []), tag],
    }));
    return tag;
  }

  async removeTag(targetRef: string, prefix: TagPrefix, value?: string): Promise<boolean> {
    let removed = false;
    await this.mapManager.update((m) => {
      const tags = (m.tags ?? []).filter((t) => {
        const matches =
          t.target_ref === targetRef &&
          t.prefix === prefix &&
          (value === undefined || t.value === value);
        if (matches) removed = true;
        return !matches;
      });
      return { ...m, tags };
    });
    return removed;
  }

  async getTagged(prefix: TagPrefix): Promise<NodeTag[]> {
    const map = await this.mapManager.read();
    return (map.tags ?? []).filter((t) => t.prefix === prefix);
  }

  /**
   * Clears all tags with the given prefix. When `targetRefs` is provided, only
   * tags whose target_ref is in that list are cleared — per DDR-028, `#next-cycle`
   * tags persist on nodes/layers the cycle did not actually modify.
   */
  async clearTag(prefix: TagPrefix, targetRefs?: string[]): Promise<number> {
    let clearedCount = 0;
    await this.mapManager.update((m) => {
      const tags = (m.tags ?? []).filter((t) => {
        if (t.prefix !== prefix) return true;
        if (targetRefs && !targetRefs.includes(t.target_ref)) return true;
        clearedCount++;
        return false;
      });
      return { ...m, tags };
    });
    return clearedCount;
  }
}
