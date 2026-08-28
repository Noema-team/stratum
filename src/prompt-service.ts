import { promises as nodeFsPromises } from 'fs';
import path from 'path';
import { DEFAULT_ROLE_TEMPLATES, FACILITATOR_TEMPLATES } from './prompt-templates.js';

export type RoleName =
  | 'designer' | 'explorer' | 'planner' | 'tester'
  | 'builder' | 'debugger' | 'evaluator' | 'critic'
  | 'historian'
  | 'facilitator-chat' | 'facilitator-decision' | 'facilitator-scoping';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  token_count: number;
}

export type TemplateSource = 'built-in' | 'project-override';

export interface TemplateInventoryEntry {
  role: RoleName;
  source: TemplateSource;
  version: string;
  token_count: number;
  valid: boolean;
}

export interface PromptTemplate {
  role: RoleName;
  version: string;
  content: string;
  source: TemplateSource;
  validation: ValidationResult;
}

export class PromptTemplateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PromptTemplateError';
    this.code = code;
  }
}

const ROLE_FILES: Record<RoleName, string> = {
  designer: 'designer.md',
  explorer: 'explorer.md',
  planner: 'planner.md',
  tester: 'tester.md',
  builder: 'builder.md',
  debugger: 'debugger.md',
  evaluator: 'evaluator.md',
  critic: 'critic.md',
  historian: 'historian.md',
  'facilitator-chat': 'facilitator-chat.md',
  'facilitator-decision': 'facilitator-decision.md',
  'facilitator-scoping': 'facilitator-scoping.md',
};

export const ALL_ROLES: RoleName[] = Object.keys(ROLE_FILES) as RoleName[];

const BUILT_IN_TEMPLATES: Record<string, string> = {
  ...DEFAULT_ROLE_TEMPLATES,
  ...FACILITATOR_TEMPLATES,
};

const TOKEN_BUDGET = 500;
const CHARS_PER_TOKEN = 4;

// Special resource identifiers referenced by shipped templates that are not
// typed doc:/node: artifacts (file paths, or the source-tree wildcard). Exempt
// from the typed-prefix rule (spec DDR-025) since they identify filesystem
// locations, not artifact-graph entries.
const UNTYPED_REF_EXEMPTIONS = new Set(['source_files']);

function estimateTokenCount(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function extractSection(content: string, heading: string): string | null {
  const re = new RegExp(`##\\s*${heading}([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const match = content.match(re);
  return match ? match[1] : null;
}

/**
 * Extracts artifact references from an ## Artifact access section, which may be
 * written as a markdown table (`| doc:x | read | notes |`) or a bullet list
 * (`- doc:x (read)`).
 */
function extractArtifactRefCells(section: string): string[] {
  const refs: string[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) {
      if (/^\|?\s*-+\s*\|/.test(trimmed)) continue; // markdown table separator row
      const firstCell = trimmed.split('|')[1]?.trim().replace(/`/g, '');
      if (!firstCell || /^artifact$/i.test(firstCell)) continue;
      refs.push(firstCell);
    } else if (trimmed.startsWith('-')) {
      const bulletBody = trimmed.replace(/^-\s*/, '').replace(/`/g, '');
      const ref = bulletBody.split(/\s*[\s(]/)[0]?.replace(/:$/, '').trim();
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function isPathLike(ref: string): boolean {
  return ref.includes('/') || ref.includes('.') || ref.includes('{') || /^[A-Z]/.test(ref);
}

export function validateTemplate(content: string): ValidationResult {
  const errors: string[] = [];

  if (!/##\s*role identity/i.test(content)) {
    errors.push('Missing required section: ## Role identity');
  }

  const behavioral = extractSection(content, 'behavioral constraints');
  if (behavioral === null) {
    errors.push('Missing required section: ## Behavioral constraints');
  } else if (!behavioral.split('\n').some((l) => /^\s*-/.test(l))) {
    errors.push('## Behavioral constraints must contain at least 1 entry');
  }

  const artifactAccess = extractSection(content, 'artifact access');
  if (artifactAccess === null) {
    errors.push('Missing required section: ## Artifact access');
  } else {
    const refs = extractArtifactRefCells(artifactAccess);
    if (refs.length === 0) {
      errors.push('## Artifact access must contain at least 1 typed artifact reference');
    }
    for (const ref of refs) {
      if (isPathLike(ref) || UNTYPED_REF_EXEMPTIONS.has(ref)) continue;
      if (!/^(doc|node):/.test(ref)) {
        errors.push(`Artifact reference "${ref}" must use a typed prefix (doc: or node:)`);
      }
    }
  }

  if (!/##\s*output format/i.test(content)) {
    errors.push('Missing required section: ## Output format');
  }

  const tokenCount = estimateTokenCount(content);
  if (tokenCount > TOKEN_BUDGET) {
    errors.push(`Template exceeds ${TOKEN_BUDGET}-token budget (estimated ${tokenCount} tokens)`);
  }

  return { valid: errors.length === 0, errors, token_count: tokenCount };
}

/**
 * Loads, validates, and lists prompt templates per docs/specs/prompt-templates.md.
 * Project-local overrides at `.sle/prompts/{role}.md` take precedence over the
 * built-in templates bundled in prompt-templates.ts.
 */
export class PromptService {
  private fs: typeof import('fs').promises;

  constructor(
    private projectRoot: string,
    fsModule?: typeof import('fs').promises
  ) {
    this.fs = fsModule ?? nodeFsPromises;
  }

  async getTemplate(role: RoleName): Promise<PromptTemplate> {
    const file = ROLE_FILES[role];
    if (!file) {
      throw new PromptTemplateError('template_missing', `Unknown role: ${role}`);
    }

    const overridePath = path.join(this.projectRoot, '.sle', 'prompts', file);
    let content: string | null = null;
    let source: TemplateSource = 'built-in';

    try {
      content = await this.fs.readFile(overridePath, 'utf-8');
      source = 'project-override';
    } catch {
      content = BUILT_IN_TEMPLATES[file] ?? null;
      source = 'built-in';
    }

    if (content === null) {
      throw new PromptTemplateError('template_missing', `No template found for role: ${role}`);
    }

    const validation = validateTemplate(content);
    if (!validation.valid) {
      throw new PromptTemplateError(
        'template_invalid',
        `Template for role ${role} failed validation: ${validation.errors.join('; ')}`
      );
    }

    return { role, version: '1.0.0', content, source, validation };
  }

  validateTemplate(content: string): ValidationResult {
    return validateTemplate(content);
  }

  async listTemplates(): Promise<TemplateInventoryEntry[]> {
    const entries: TemplateInventoryEntry[] = [];
    for (const role of ALL_ROLES) {
      const file = ROLE_FILES[role];
      const overridePath = path.join(this.projectRoot, '.sle', 'prompts', file);
      let content: string | null = null;
      let source: TemplateSource = 'built-in';

      try {
        content = await this.fs.readFile(overridePath, 'utf-8');
        source = 'project-override';
      } catch {
        content = BUILT_IN_TEMPLATES[file] ?? null;
        source = 'built-in';
      }

      if (content === null) {
        entries.push({ role, source, version: '1.0.0', token_count: 0, valid: false });
        continue;
      }

      const validation = validateTemplate(content);
      entries.push({
        role,
        source,
        version: '1.0.0',
        token_count: validation.token_count,
        valid: validation.valid,
      });
    }
    return entries;
  }

  /** Validates every role's template at daemon start; logs warnings, never throws. */
  async validateAll(): Promise<TemplateInventoryEntry[]> {
    const entries = await this.listTemplates();
    for (const entry of entries) {
      if (!entry.valid) {
        // eslint-disable-next-line no-console
        console.warn(
          `[stratum] Warning: prompt template for role "${entry.role}" is missing or invalid ` +
          `(source: ${entry.source}). Agent calls for this role will fail until fixed.`
        );
      }
    }
    return entries;
  }
}
