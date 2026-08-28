import { promises as fs } from 'fs';
import path from 'path';
import type { 
  LinkIndex, 
  ForwardLink, 
  Backlink, 
  FileEntry, 
  DocumentEntry, 
  LinkSource, 
  LinkTarget
} from './types.js';
import type { RuntimeMap, RuntimeMapManager } from './runtime-map.js';
import { parseWikilinks } from './wikilink-parser.js';

// Ignores for directory walking
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /build/,
  /coverage/
];

export class LinkIndexManager {
  private index: LinkIndex;
  private linkIndexDir: string;

  constructor(
    private projectRoot: string,
    private mapManager?: RuntimeMapManager
  ) {
    this.linkIndexDir = path.join(projectRoot, '.sle', 'link-index');
    this.index = {
      version: 1,
      last_rebuilt_at: new Date().toISOString(),
      links: [],
      backlinks: new Map<string, Backlink[]>(),
      file_index: { files: new Map<string, FileEntry>() },
      document_index: { documents: new Map<string, DocumentEntry>() }
    };
  }

  async load(): Promise<void> {
    try {
      await fs.mkdir(this.linkIndexDir, { recursive: true });

      let links: ForwardLink[] = [];
      try {
        const content = await fs.readFile(path.join(this.linkIndexDir, 'forward-links.json'), 'utf-8');
        links = JSON.parse(content);
      } catch {
        // Fallback to empty
      }

      const fileMap = new Map<string, FileEntry>();
      try {
        const content = await fs.readFile(path.join(this.linkIndexDir, 'file-index.json'), 'utf-8');
        const parsed = JSON.parse(content);
        for (const [k, v] of Object.entries(parsed)) {
          fileMap.set(k, v as FileEntry);
        }
      } catch {
        // Fallback to empty
      }

      const docMap = new Map<string, DocumentEntry>();
      try {
        const content = await fs.readFile(path.join(this.linkIndexDir, 'document-index.json'), 'utf-8');
        const parsed = JSON.parse(content);
        for (const [k, v] of Object.entries(parsed)) {
          docMap.set(k, v as DocumentEntry);
        }
      } catch {
        // Fallback to empty
      }

      this.index.links = links;
      this.index.file_index.files = fileMap;
      this.index.document_index.documents = docMap;

      this.computeBacklinks();
    } catch (err) {
      console.error('Failed to load link index:', err);
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(this.linkIndexDir, { recursive: true });

      // Serialize maps as objects
      const fileIndexObj: Record<string, FileEntry> = {};
      for (const [k, v] of this.index.file_index.files.entries()) {
        fileIndexObj[k] = v;
      }

      const docIndexObj: Record<string, DocumentEntry> = {};
      for (const [k, v] of this.index.document_index.documents.entries()) {
        docIndexObj[k] = v;
      }

      await fs.writeFile(
        path.join(this.linkIndexDir, 'forward-links.json'),
        JSON.stringify(this.index.links, null, 2),
        'utf-8'
      );
      await fs.writeFile(
        path.join(this.linkIndexDir, 'file-index.json'),
        JSON.stringify(fileIndexObj, null, 2),
        'utf-8'
      );
      await fs.writeFile(
        path.join(this.linkIndexDir, 'document-index.json'),
        JSON.stringify(docIndexObj, null, 2),
        'utf-8'
      );

      // Save to map.yaml metadata if available
      if (this.mapManager) {
        await this.mapManager.update((m: RuntimeMap) => ({
          ...m,
          graph: {
            link_count: this.index.links.length,
            last_rebuilt_at: this.index.last_rebuilt_at,
          }
        }));
      }
    } catch (err) {
      console.error('Failed to save link index:', err);
    }
  }

  async rebuildAll(map: RuntimeMap): Promise<void> {
    this.index.last_rebuilt_at = new Date().toISOString();
    this.index.links = [];
    this.index.file_index.files.clear();
    this.index.document_index.documents.clear();

    // 1. Index Project Documents
    for (const art of map.artifacts || []) {
      if (art.scope === 'project') {
        const docKey = path.basename(art.path, path.extname(art.path));
        const docEntry: DocumentEntry = {
          key: docKey,
          path: art.path,
          title: docKey,
          description: `Project document: ${docKey}`,
          tags: [],
          source: 'user',
          last_modified: art.last_updated || new Date().toISOString(),
          modified_by: 'user',
          backlink_count: 0
        };
        this.index.document_index.documents.set(docKey, docEntry);

        // Parse document content for wikilinks
        try {
          const fullPath = path.isAbsolute(art.path) ? art.path : path.join(this.projectRoot, art.path);
          const content = await fs.readFile(fullPath, 'utf-8');
          const wikilinks = parseWikilinks(content);

          for (const wl of wikilinks) {
            if ('kind' in wl.target && wl.target.kind === 'group') {
              // Resolve group:id to all group nodes
              const groupId = wl.target.id;
              const groupArts = (map.artifacts || []).filter((a: any) => a.scope === 'group' && a.path.includes(groupId));
              for (const ga of groupArts) {
                const gaKey = path.basename(ga.path, path.extname(ga.path));
                this.addForwardLink(
                  { kind: 'document', key: docKey },
                  { kind: 'node', group: groupId, key: gaKey },
                  wl.context
                );
              }
            } else {
              this.addForwardLink(
                { kind: 'document', key: docKey },
                wl.target as LinkTarget,
                wl.context
              );
            }
          }
        } catch {
          // Ignore read failures
        }
      }
    }

    // 2. Index Source & Test Files
    const srcDirs = ['src'];

    for (const sDir of srcDirs) {
      const fullSrcDir = path.join(this.projectRoot, sDir);
      try {
        const files = await this.walkDir(fullSrcDir);
        for (const file of files) {
          const relPath = path.relative(this.projectRoot, file);
          const ext = path.extname(file);
          const lang = this.inferLanguage(ext);
          const stat = await fs.stat(file);
          const content = await fs.readFile(file, 'utf-8');
          const lineCount = content.split('\n').length;

          const fileEntry: FileEntry = {
            path: relPath,
            language: lang,
            last_modified: stat.mtime.toISOString(),
            line_count: lineCount,
            referencing_nodes: [],
            group_id: null,
            layer: null
          };
          this.index.file_index.files.set(relPath, fileEntry);
        }
      } catch {
        // Source dir might not exist
      }
    }

    // 3. Compute backlinks
    this.computeBacklinks();

    // 4. Save to disk
    await this.save();
  }

  async addLink(params: {
    source: LinkSource;
    target: LinkTarget;
    link_type: 'structural_dag' | 'structural_declaration' | 'contextual_execution' | 'manual';
    context: string;
  }): Promise<void> {
    const exists = this.index.links.some(
      l => JSON.stringify(l.source) === JSON.stringify(params.source) && 
           JSON.stringify(l.target) === JSON.stringify(params.target)
    );

    if (!exists) {
      this.index.links.push({
        source: params.source,
        target: params.target,
        link_type: params.link_type as any,
        context: params.context,
        created_at: new Date().toISOString()
      });
      this.computeBacklinks();
      await this.save();
    }
  }

  private addForwardLink(source: LinkSource, target: LinkTarget, context: string): void {
    // Avoid duplicates
    const exists = this.index.links.some(
      l => JSON.stringify(l.source) === JSON.stringify(source) && 
           JSON.stringify(l.target) === JSON.stringify(target)
    );

    if (!exists) {
      this.index.links.push({
        source,
        target,
        link_type: 'manual',
        context,
        created_at: new Date().toISOString()
      });
    }
  }

  private computeBacklinks(): void {
    this.index.backlinks.clear();

    // Reset document backlink counts
    for (const doc of this.index.document_index.documents.values()) {
      doc.backlink_count = 0;
    }

    for (const link of this.index.links) {
      const targetStr = JSON.stringify(link.target);
      const backlinks = this.index.backlinks.get(targetStr) || [];

      let label = '';
      if (link.source.kind === 'document') {
        label = `${link.source.key} (Document)`;
      } else {
        label = `${link.source.key} (${link.source.group} · Node)`;
      }

      backlinks.push({
        from: link.source,
        context: link.context,
        link_type: link.link_type,
        resolved_label: label
      });

      this.index.backlinks.set(targetStr, backlinks);

      // Increment backlink count if document
      if (link.target.kind === 'document') {
        const doc = this.index.document_index.documents.get(link.target.key);
        if (doc) {
          doc.backlink_count++;
        }
      }
    }
  }

  // APIs

  queryByTopic(topic: string, options?: { limit?: number }): LinkTarget[] {
    const limit = options?.limit ?? 50;
    const lowerTopic = topic.toLowerCase();
    const results: Array<{ target: LinkTarget; score: number }> = [];

    // Search documents
    for (const doc of this.index.document_index.documents.values()) {
      let score = 0;
      if (doc.tags.some(t => t.toLowerCase() === lowerTopic)) {
        score = 100;
      } else if (doc.title.toLowerCase().includes(lowerTopic) || doc.description.toLowerCase().includes(lowerTopic)) {
        score = 50;
      }

      if (score > 0) {
        results.push({
          target: { kind: 'document', key: doc.key },
          score
        });
      }
    }

    // Search files
    for (const file of this.index.file_index.files.values()) {
      if (file.path.toLowerCase().includes(lowerTopic)) {
        results.push({
          target: { kind: 'source_file', path: file.path },
          score: 30
        });
      }
    }

    // Sort by score then alphabetical
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return JSON.stringify(a.target).localeCompare(JSON.stringify(b.target));
    });

    return results.slice(0, limit).map(r => r.target);
  }

  getAncestors(source: LinkSource, depth: number = 5): any[] {
    const results: any[] = [];
    const visited = new Set<string>();

    const walk = (curr: LinkSource, currentDepth: number) => {
      if (currentDepth > depth) return;
      const currStr = JSON.stringify(curr);
      if (visited.has(currStr)) return;
      visited.add(currStr);

      const matchingLinks = this.index.links.filter(
        l => JSON.stringify(l.source) === currStr
      );

      for (const link of matchingLinks) {
        results.push({
          target: link.target,
          link_type: link.link_type,
          context: link.context,
          depth: currentDepth
        });

        if (link.target.kind === 'document' || link.target.kind === 'node') {
          walk(link.target as LinkSource, currentDepth + 1);
        }
      }
    };

    walk(source, 1);
    return results;
  }

  getDescendants(target: LinkTarget, depth: number = 5): any[] {
    const results: any[] = [];
    const visited = new Set<string>();

    const walk = (curr: LinkTarget, currentDepth: number) => {
      if (currentDepth > depth) return;
      const currStr = JSON.stringify(curr);
      if (visited.has(currStr)) return;
      visited.add(currStr);

      const backlinks = this.index.backlinks.get(currStr) || [];
      for (const bl of backlinks) {
        results.push({
          source: bl.from,
          link_type: bl.link_type,
          context: bl.context,
          depth: currentDepth
        });

        walk(bl.from as LinkTarget, currentDepth + 1);
      }
    };

    walk(target, 1);
    return results;
  }

  // Helpers

  private async walkDir(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const list = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of list) {
        const res = path.resolve(dir, entry.name);
        if (IGNORE_PATTERNS.some(p => p.test(res))) continue;
        if (entry.isDirectory()) {
          files.push(...(await this.walkDir(res)));
        } else {
          files.push(res);
        }
      }
    } catch {
      // Ignore
    }
    return files;
  }

  private inferLanguage(ext: string): string {
    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.py':
        return 'python';
      case '.rs':
        return 'rust';
      case '.go':
        return 'go';
      default:
        return 'unknown';
    }
  }
}
