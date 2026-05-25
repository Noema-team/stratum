import type { LinkTarget } from './types.js';

export interface ParsedWikilink {
  target: LinkTarget | { kind: 'group'; id: string };
  context: string;
}

const WIKILINK_REGEX = /\[\[(doc:[a-zA-Z0-9_-]+(?:#[a-zA-Z0-9_-]+)?|node:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+|src\/[^\]]+|tests\/[^\]]+|group:[a-zA-Z0-9_-]+)\]\]/g;

export function parseWikilinks(text: string): ParsedWikilink[] {
  const links: ParsedWikilink[] = [];
  const regex = new RegExp(WIKILINK_REGEX);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[1];

    if (raw.startsWith('doc:')) {
      const parts = raw.substring(4).split('#');
      const key = parts[0];
      const section = parts[1] || '';
      links.push({
        target: { kind: 'document', key },
        context: section ? `#${section}` : '',
      });
    } else if (raw.startsWith('node:')) {
      const parts = raw.substring(5).split(':');
      const group = parts[0];
      const key = parts[1];
      links.push({
        target: { kind: 'node', group, key },
        context: '',
      });
    } else if (raw.startsWith('src/')) {
      const path = raw;
      links.push({
        target: { kind: 'source_file', path },
        context: '',
      });
    } else if (raw.startsWith('tests/')) {
      const path = raw;
      links.push({
        target: { kind: 'test_file', path },
        context: '',
      });
    } else if (raw.startsWith('group:')) {
      const id = raw.substring(6);
      links.push({
        target: { kind: 'group', id },
        context: '',
      });
    }
  }

  return links;
}
