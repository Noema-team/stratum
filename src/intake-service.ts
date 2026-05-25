import { promises as fs } from 'fs';
import path from 'path';
import type { RuntimeMapManager } from './runtime-map.js';
import type { LinkIndexManager } from './link-index.js';
import type { IntakeDocument, DocumentSection, CoherenceFinding, CoherenceReport } from './types.js';
import { IntakeDocumentSchema, CoherenceReportSchema } from './types.js';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export class IntakeService {
  constructor(
    private projectRoot: string,
    private mapManager: RuntimeMapManager,
    private linkIndex: LinkIndexManager
  ) {}

  private getDocsDir(): string {
    return path.join(this.projectRoot, '.sle', 'project-docs');
  }

  async runIntake(documentFilenames?: string[]): Promise<IntakeDocument[]> {
    const docsDir = this.getDocsDir();
    await fs.mkdir(docsDir, { recursive: true });

    let files: string[] = [];
    if (documentFilenames && documentFilenames.length > 0) {
      files = documentFilenames;
    } else {
      const allFiles = await fs.readdir(docsDir);
      files = allFiles.filter(f => f.endsWith('.md') && !f.endsWith('.meta.json'));
    }

    const docs: IntakeDocument[] = [];

    for (const filename of files) {
      const filePath = path.join(docsDir, filename);
      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }

      const id = slugify(path.basename(filename, '.md'));
      
      // Parse Title
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : path.basename(filename, '.md');

      // Parse Sections by walk ## headings
      const sections: DocumentSection[] = [];
      const headingRegex = /^##\s+(.+)$/gm;
      let match;
      const headingIndices: Array<{ heading: string; start: number }> = [];

      while ((match = headingRegex.exec(content)) !== null) {
        headingIndices.push({
          heading: match[1].trim(),
          start: match.index,
        });
      }

      for (let i = 0; i < headingIndices.length; i++) {
        const current = headingIndices[i];
        const sectionId = slugify(current.heading);
        const sectionStart = current.start;
        const nextStart = i + 1 < headingIndices.length ? headingIndices[i + 1].start : content.length;
        const sectionBody = content.slice(sectionStart, nextStart).trim();
        const sectionTokens = Math.ceil(sectionBody.length / 4);

        sections.push({
          id: sectionId,
          heading: current.heading,
          tokens: sectionTokens,
          anchor: `#${sectionId}`,
        });
      }

      // Check if there is already a sidecar meta JSON
      const metaPath = path.join(docsDir, `${filename}.meta.json`);
      let existingMeta: any = {};
      try {
        const metaContent = await fs.readFile(metaPath, 'utf8');
        existingMeta = JSON.parse(metaContent);
      } catch {}

      const now = new Date().toISOString();
      const doc: IntakeDocument = {
        id,
        filename,
        title,
        description: existingMeta.description || `Metadata derived for ${title}`,
        tags: existingMeta.tags || [],
        status: existingMeta.status || 'ungraphed',
        source: existingMeta.source || 'user',
        version: existingMeta.version || 1,
        sections,
        last_modified: now,
        promoted_to_node: existingMeta.promoted_to_node,
      };

      // Validate schema
      IntakeDocumentSchema.parse(doc);

      // Write sidecar JSON
      await fs.writeFile(metaPath, JSON.stringify(doc, null, 2), 'utf8');
      docs.push(doc);
    }

    return docs;
  }

  async getCoherenceReport(docs: IntakeDocument[]): Promise<CoherenceReport> {
    const findings: CoherenceFinding[] = [];
    const docMap = new Map<string, IntakeDocument>();
    const docContents = new Map<string, string>();

    const docsDir = this.getDocsDir();

    for (const doc of docs) {
      docMap.set(doc.id, doc);
      try {
        const content = await fs.readFile(path.join(docsDir, doc.filename), 'utf8');
        docContents.set(doc.id, content);
      } catch {}
    }

    // 1. Completeness Check
    if (docs.length === 0) {
      findings.push({
        type: 'missing_document',
        severity: 'blocking',
        document_a: 'doc:all',
        description: 'No documents exist in .sle/project-docs/ for the planned scope.',
      });
    }

    for (const doc of docs) {
      const content = docContents.get(doc.id) || '';
      if (content.trim().length === 0) {
        findings.push({
          type: 'missing_document',
          severity: 'blocking',
          document_a: `doc:${doc.id}`,
          description: `Document ${doc.filename} is completely empty.`,
        });
      }
    }

    // Terminology maps for Terminology Consistency
    const terminologyDefinitions = new Map<string, { docId: string; definition: string; heading: string }>();

    // Contradiction key-value pairs
    const constraints = new Map<string, { docId: string; value: string; heading: string }>();

    for (const doc of docs) {
      const content = docContents.get(doc.id) || '';

      // Parse wikilinks [[doc:target]] or [[doc:target#section-id]]
      const wikilinkRegex = /\[\[(doc:[a-zA-Z0-9_-]+)(#[a-zA-Z0-9_-]+)?\]\]/g;
      let linkMatch;
      while ((linkMatch = wikilinkRegex.exec(content)) !== null) {
        const ref = linkMatch[1];
        const targetId = ref.replace(/^doc:/, '');
        const anchor = linkMatch[2]; // e.g. '#auth-section'

        const targetDoc = docMap.get(targetId);
        if (!targetDoc) {
          // Undefined reference warning
          findings.push({
            type: 'undefined_reference',
            severity: 'warning',
            document_a: `doc:${doc.id}`,
            description: `Link to undefined document [[doc:${targetId}]]`,
          });
        } else if (anchor) {
          const sectionId = anchor.substring(1);
          const sectionExists = targetDoc.sections.some(s => s.id === sectionId);
          if (!sectionExists) {
            // Dangling reference is blocking
            findings.push({
              type: 'undefined_reference',
              severity: 'blocking',
              document_a: `doc:${doc.id}`,
              document_b: `doc:${targetId}`,
              section_b: sectionId,
              description: `Link references non-existent section '${sectionId}' in document ${targetDoc.filename}`,
            });
          }
        }
      }

      // Terminology consistency: bullet points like: - **Term**: Definition or - Term: Definition
      const glossaryRegex = /^-\s+\*\*([^*]+)\*\*:\s*(.+)$/gm;
      let glossaryMatch;
      while ((glossaryMatch = glossaryRegex.exec(content)) !== null) {
        const term = glossaryMatch[1].trim().toLowerCase();
        const definition = glossaryMatch[2].trim();

        const existing = terminologyDefinitions.get(term);
        if (existing && existing.docId !== doc.id && existing.definition !== definition) {
          findings.push({
            type: 'terminology_conflict',
            severity: 'warning',
            document_a: `doc:${existing.docId}`,
            document_b: `doc:${doc.id}`,
            description: `Conflicting definitions for term '${glossaryMatch[1].trim()}' between ${existing.docId} and ${doc.id}`,
          });
        } else {
          terminologyDefinitions.set(term, { docId: doc.id, definition, heading: glossaryMatch[1].trim() });
        }
      }

      // Contradiction detection: key-value constraints e.g., "**Database**: Postgres"
      const constraintRegex = /^\*\*(Database|Port|Environment|AuthMethod)\*\*:\s*(.+)$/gm;
      let constraintMatch;
      while ((constraintMatch = constraintRegex.exec(content)) !== null) {
        const key = constraintMatch[1].trim().toLowerCase();
        const value = constraintMatch[2].trim();

        const existing = constraints.get(key);
        if (existing && existing.docId !== doc.id && existing.value !== value) {
          findings.push({
            type: 'contradiction',
            severity: 'blocking',
            document_a: `doc:${existing.docId}`,
            document_b: `doc:${doc.id}`,
            description: `Direct contradiction found for constraint '${constraintMatch[1]}': '${existing.value}' in ${existing.docId} vs '${value}' in ${doc.id}`,
          });
        } else {
          constraints.set(key, { docId: doc.id, value, heading: constraintMatch[1] });
        }
      }
    }

    let status: CoherenceReport['status'] = 'clean';
    if (findings.some(f => f.severity === 'blocking')) {
      status = 'blocked';
    } else if (findings.some(f => f.severity === 'warning')) {
      status = 'flagged';
    }

    const report: CoherenceReport = {
      status,
      findings,
      document_count: docs.length,
      checked_at: new Date().toISOString(),
    };

    CoherenceReportSchema.parse(report);

    // Save report to disk
    const reportPath = path.join(this.projectRoot, '.sle', 'coherence-report.json');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

    return report;
  }

  async promoteDocument(id: string): Promise<IntakeDocument> {
    const docsDir = this.getDocsDir();
    const files = await fs.readdir(docsDir);
    const filename = files.find(f => slugify(path.basename(f, '.md')) === id && !f.endsWith('.meta.json'));

    if (!filename) {
      throw Object.assign(new Error(`Document not found for id: ${id}`), { code: 'document_not_found' });
    }

    const metaPath = path.join(docsDir, `${filename}.meta.json`);
    let doc: IntakeDocument;
    try {
      const metaContent = await fs.readFile(metaPath, 'utf8');
      doc = JSON.parse(metaContent);
    } catch {
      throw new Error(`Intake metadata is missing for document: ${filename}. Run intake first.`);
    }

    const nodeId = `doc:${id}`;
    doc.status = 'promoted';
    doc.promoted_to_node = nodeId;

    await fs.writeFile(metaPath, JSON.stringify(doc, null, 2), 'utf8');

    // Create document node in project graph via mapManager
    await this.mapManager.update(m => {
      const artifacts = [...m.artifacts];
      const exists = artifacts.some(a => a.path === `docs/${doc.filename}`);
      if (!exists) {
        artifacts.push({
          path: `docs/${doc.filename}`,
          generator: 'designer',
          required: true,
          last_updated: new Date().toISOString(),
          dirty: false,
        });
      }
      return {
        ...m,
        artifacts,
      };
    });

    // Add backlink index structural declaration
    await this.linkIndex.addLink({
      source: { kind: 'document', key: id },
      target: { kind: 'document', key: id }, // structural self link
      link_type: 'structural_declaration',
      context: `Promoted document ${doc.filename}`,
    });

    return doc;
  }

  async listDocuments(): Promise<IntakeDocument[]> {
    const docsDir = this.getDocsDir();
    try {
      const files = await fs.readdir(docsDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));
      const docs: IntakeDocument[] = [];
      for (const metaFile of metaFiles) {
        const metaContent = await fs.readFile(path.join(docsDir, metaFile), 'utf8');
        docs.push(JSON.parse(metaContent));
      }
      return docs;
    } catch {
      return [];
    }
  }
}
