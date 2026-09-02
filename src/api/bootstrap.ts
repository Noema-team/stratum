// bootstrapLocalControlPlane — SQLite is the identity authority.
//
// Opens (and migrates) the database, then resolves the canonical Workspace+Project
// identity for this project directory.  When the database is genuinely fresh it
// creates both rows transactionally.  The filesystem locator file at
// .sle/workspace.json is a validated pointer to those rows; it never mints identity
// that the database does not contain.
//
// Fail-closed rules:
//   - Multiple workspaces AND no locator → error (ambiguous)
//   - Multiple projects in workspace AND no locator → error (ambiguous)
//   - Locator points to IDs that do not exist in the DB → error (stale locator)
//   - Corrupt/missing locator with exactly one workspace+project → recover silently

import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../storage/database.js';
import { WorkspaceRepository, ProjectRepository } from '../storage/repositories.js';

export interface BootstrapResult {
  workspaceId: string;
  projectId: string;
}

interface Locator {
  workspaceId: string;
  projectId: string;
}

export function bootstrapLocalControlPlane(
  projectRoot: string,
  dbPath?: string,
): BootstrapResult {
  const sleDir = path.join(projectRoot, '.sle');
  mkdirSync(sleDir, { recursive: true });

  const resolvedDbPath = dbPath ?? path.join(sleDir, 'stratum.db');
  const locatorPath = path.join(sleDir, 'workspace.json');

  const db = openDatabase(resolvedDbPath);
  try {
    const wsRepo = new WorkspaceRepository(db);
    const prRepo = new ProjectRepository(db);

    const workspaces = wsRepo.list();

    if (workspaces.length === 0) {
      // Fresh DB — create canonical rows transactionally, then write locator.
      const workspaceId = randomUUID();
      const projectId = randomUUID();
      const now = new Date().toISOString();
      const name = path.basename(projectRoot) || 'default';

      db.transaction(() => {
        wsRepo.save({ id: workspaceId, name, createdAt: now });
        prRepo.save({
          id: projectId,
          workspaceId,
          name,
          status: 'active',
          priority: 0,
          createdAt: now,
          updatedAt: now,
        });
      })();

      writeLocator(locatorPath, { workspaceId, projectId });
      return { workspaceId, projectId };
    }

    const locator = readLocator(locatorPath);

    if (workspaces.length === 1) {
      const workspace = workspaces[0];
      const projects = prRepo.listByWorkspace(workspace.id);

      if (projects.length === 0) {
        // Workspace present but no project — create one.
        const projectId = randomUUID();
        const now = new Date().toISOString();
        prRepo.save({
          id: projectId,
          workspaceId: workspace.id,
          name: workspace.name,
          status: 'active',
          priority: 0,
          createdAt: now,
          updatedAt: now,
        });
        writeLocator(locatorPath, { workspaceId: workspace.id, projectId });
        return { workspaceId: workspace.id, projectId };
      }

      if (projects.length === 1) {
        const projectId = projects[0].id;
        if (locator && (locator.workspaceId !== workspace.id || locator.projectId !== projectId)) {
          throw new Error(
            `Locator at ${locatorPath} points to workspace=${locator.workspaceId} ` +
            `project=${locator.projectId}, but the database contains ` +
            `workspace=${workspace.id} project=${projectId}. ` +
            `Remove the locator file to let the database be the sole authority.`,
          );
        }
        writeLocator(locatorPath, { workspaceId: workspace.id, projectId });
        return { workspaceId: workspace.id, projectId };
      }

      // Multiple projects — locator required to disambiguate.
      if (!locator) {
        throw new Error(
          `Database has ${projects.length} projects in workspace '${workspace.name}' ` +
          `and no locator file was found at ${locatorPath}. ` +
          `Create a locator file with { "workspaceId": "...", "projectId": "..." } to identify the active project.`,
        );
      }
      if (locator.workspaceId !== workspace.id) {
        throw new Error(
          `Locator workspaceId '${locator.workspaceId}' does not match the database workspace '${workspace.id}'.`,
        );
      }
      const project = projects.find(p => p.id === locator.projectId);
      if (!project) {
        throw new Error(
          `Locator projectId '${locator.projectId}' not found among ${projects.length} projects ` +
          `in workspace '${workspace.name}'. Check ${locatorPath}.`,
        );
      }
      return { workspaceId: workspace.id, projectId: project.id };
    }

    // Multiple workspaces — locator required.
    if (!locator) {
      throw new Error(
        `Database has ${workspaces.length} workspaces and no locator file at ${locatorPath}. ` +
        `Create a locator file with { "workspaceId": "...", "projectId": "..." } to identify the active workspace.`,
      );
    }

    const workspace = workspaces.find(w => w.id === locator.workspaceId);
    if (!workspace) {
      throw new Error(
        `Locator workspaceId '${locator.workspaceId}' not found in the database ` +
        `(${workspaces.length} workspaces present). Check ${locatorPath}.`,
      );
    }

    const projects = prRepo.listByWorkspace(workspace.id);
    const project = projects.find(p => p.id === locator.projectId);
    if (!project) {
      throw new Error(
        `Locator projectId '${locator.projectId}' not found in workspace '${workspace.name}'. ` +
        `Check ${locatorPath}.`,
      );
    }

    return { workspaceId: workspace.id, projectId: project.id };
  } finally {
    db.close();
  }
}

function readLocator(locatorPath: string): Locator | null {
  if (!existsSync(locatorPath)) return null;
  try {
    const data = JSON.parse(readFileSync(locatorPath, 'utf8')) as Record<string, unknown>;
    if (typeof data.workspaceId === 'string' && data.workspaceId &&
        typeof data.projectId === 'string' && data.projectId) {
      return { workspaceId: data.workspaceId, projectId: data.projectId };
    }
    return null;
  } catch {
    return null;
  }
}

function writeLocator(locatorPath: string, locator: Locator): void {
  writeFileSync(locatorPath, JSON.stringify(locator, null, 2) + '\n', 'utf8');
}
