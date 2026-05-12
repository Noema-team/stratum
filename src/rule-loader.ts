import { readFile } from 'fs/promises';
import { join } from 'path';
import { load as parseYAML } from 'js-yaml';
import type { RuleFileName } from './rule-files.js';

export interface LoadResult<T = unknown> {
  fileName: RuleFileName;
  path: string;
  content: T;
  loadedAt: string;
}

export class RuleLoadError extends Error {
  constructor(
    public readonly fileName: RuleFileName,
    public readonly path: string,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RuleLoadError';
  }
}

export class RuleParseError extends Error {
  constructor(
    public readonly fileName: RuleFileName,
    public readonly path: string,
    message: string,
    public readonly yamlError?: Error
  ) {
    super(message);
    this.name = 'RuleParseError';
  }
}

export function getRuleFilePath(projectRoot: string, fileName: RuleFileName): string {
  return join(projectRoot, '.sle', `${fileName}.yaml`);
}

export async function loadRuleFile(projectRoot: string, fileName: RuleFileName): Promise<LoadResult> {
  const filePath = getRuleFilePath(projectRoot, fileName);

  try {
    const rawContent = await readFile(filePath, 'utf-8');
    const parsed = parseYAML(rawContent);

    return {
      fileName,
      path: filePath,
      content: parsed,
      loadedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ENOENT') {
        throw new RuleLoadError(fileName, filePath, `Rule file not found: ${filePath}`);
      }
      if (error.code === 'EACCES') {
        throw new RuleLoadError(fileName, filePath, `Permission denied reading rule file: ${filePath}`);
      }
    }

    if (error instanceof Error && error.name === 'YAMLException') {
      throw new RuleParseError(fileName, filePath, `Failed to parse YAML: ${error.message}`, error);
    }

    throw new RuleLoadError(fileName, filePath, `Failed to load rule file: ${filePath}`, error instanceof Error ? error : undefined);
  }
}

export async function loadAllRuleFiles(projectRoot: string, fileNames: readonly RuleFileName[]): Promise<LoadResult[]> {
  const results: LoadResult[] = [];
  const errors: Array<{ fileName: RuleFileName; error: Error }> = [];

  for (const fileName of fileNames) {
    try {
      const result = await loadRuleFile(projectRoot, fileName);
      results.push(result);
    } catch (error) {
      errors.push({
        fileName,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  if (errors.length > 0) {
    const errorMessages = errors.map(e => `${e.fileName}: ${e.error.message}`).join('; ');
    throw new RuleLoadError('planning' as RuleFileName, projectRoot, `Failed to load rule files: ${errorMessages}`);
  }

  return results;
}

export function ruleFileExists(projectRoot: string, fileName: RuleFileName): boolean {
  try {
    const filePath = getRuleFilePath(projectRoot, fileName);
    const { accessSync } = require('fs');
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadRuleFilesIfExists(projectRoot: string, fileNames: readonly RuleFileName[]): Promise<LoadResult[]> {
  const results: LoadResult[] = [];

  for (const fileName of fileNames) {
    if (ruleFileExists(projectRoot, fileName)) {
      const result = await loadRuleFile(projectRoot, fileName);
      results.push(result);
    }
  }

  return results;
}
