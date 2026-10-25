import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readlinkSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { AppProcess } from '../../storage/repositories.js';
import { canonicalRepositoryIdentity } from '../../storage/repositories.js';
import type { Repository } from '../../domain/repository.js';
import { ProcessServiceError } from '../processes/service.js';

export interface AuthorizedCheckout {
  path: string;
  commit: string;
}

export function createReadOnlySnapshot(checkoutPath: string, commit: string, statePath: string): string {
  const snapshotPath = path.join(statePath, 'workspace');
  const archivePath = path.join(statePath, 'source.tar');
  mkdirSync(snapshotPath, { recursive: false, mode: 0o700 });
  try {
    execFileSync('git', ['-C', checkoutPath, 'archive', '--format=tar', `--output=${archivePath}`, commit],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore'] });
    if (statSync(archivePath).size > 1024 * 1024 * 1024) throw new Error('repository snapshot exceeds 1 GiB');
    execFileSync('tar', ['--extract', `--file=${archivePath}`, `--directory=${snapshotPath}`, '--no-same-owner', '--no-same-permissions'],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore'] });
    verifySnapshotSymlinks(snapshotPath, snapshotPath);
    return realpathSync(snapshotPath);
  } catch {
    throw new ProcessServiceError('a bounded read-only snapshot could not be created for this repository commit', 'INVALID');
  } finally {
    try { unlinkSync(archivePath); } catch { /* archive may not have been created */ }
  }
}

/** Create a private, empty workspace for repository-free sessions. */
export function createEmptyReadOnlyWorkspace(engineStatePath: string): string {
  mkdirSync(engineStatePath, { recursive: true, mode: 0o700 });
  const statePath = realpathSync(engineStatePath);
  if (lstatSync(engineStatePath).isSymbolicLink()) throw new Error('AgentSession engine state path may not be a symlink');
  chmodSync(statePath, 0o700);
  const workspacePath = path.join(statePath, 'workspace');
  mkdirSync(workspacePath, { recursive: false, mode: 0o700 });
  chmodSync(workspacePath, 0o500);
  assertEmptyReadOnlyWorkspace(workspacePath, statePath);
  return realpathSync(workspacePath);
}

/** Verify that an empty-mode bind mount is private, empty, read-only and session-local. */
export function assertEmptyReadOnlyWorkspace(workspacePath: string, engineStatePath: string): void {
  const statePath = realpathSync(engineStatePath);
  const expected = path.join(statePath, 'workspace');
  const info = lstatSync(workspacePath);
  const resolved = realpathSync(workspacePath);
  if (info.isSymbolicLink() || !info.isDirectory() || resolved !== expected) {
    throw new Error('empty AgentSession workspace must be a real session-private directory');
  }
  if ((info.mode & 0o222) !== 0) throw new Error('empty AgentSession workspace must not be host-writable');
  if (readdirSync(resolved).length !== 0) throw new Error('repository-free AgentSession workspace must remain empty');
}

/** Resolve and verify the exact linked checkout before it can be mounted into an agent container. */
export function resolveAuthorizedCheckout(process: AppProcess, repository: Repository): AuthorizedCheckout {
  if (!process.repositoryIds.includes(repository.id)) throw new ProcessServiceError('repository is outside this Process definition', 'INVALID');
  return resolveLinkedRepositoryCheckout(repository);
}

/** Resolve a repository explicitly linked to a Project, without inventing Process authority. */
export function resolveProjectAuthorizedCheckout(repository: Repository): AuthorizedCheckout {
  return resolveLinkedRepositoryCheckout(repository);
}

function resolveLinkedRepositoryCheckout(repository: Repository): AuthorizedCheckout {
  if (repository.status !== 'active') throw new ProcessServiceError('repository is disabled', 'CONFLICT');
  if (!repository.localWorkspace || !path.isAbsolute(repository.localWorkspace)) {
    throw new ProcessServiceError('repository needs an explicit absolute local checkout path before an agent can use it', 'INVALID');
  }

  try {
    const pathInfo = lstatSync(repository.localWorkspace);
    if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) throw new Error('checkout root is not a real directory');
    const checkoutPath = realpathSync(repository.localWorkspace);
    const gitRoot = execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const realGitRoot = realpathSync(gitRoot);
    if (realGitRoot !== checkoutPath || !statSync(realGitRoot).isDirectory()) throw new Error('local path is not the checkout root');
    const remote = execFileSync('git', ['-C', checkoutPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (canonicalRepositoryIdentity(repository.provider, remote) !== canonicalRepositoryIdentity(repository.provider, repository.remote)) {
      throw new Error('checkout origin does not match the linked repository');
    }
    const commit = execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('checkout has no verified commit');
    return { path: checkoutPath, commit };
  } catch {
    throw new ProcessServiceError('local checkout could not be verified against the linked GitHub repository', 'INVALID');
  }
}

function verifySnapshotSymlinks(root: string, current: string): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(full);
      const resolved = path.resolve(path.dirname(full), target);
      const relative = path.relative(root, resolved);
      if (path.isAbsolute(target) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('repository contains a symlink that escapes its snapshot');
      }
    } else if (entry.isDirectory()) verifySnapshotSymlinks(root, full);
  }
}

export function resolveWorkspaceReadPath(root: string, requested: string): string {
  if (!requested || requested.includes('\0')) throw new Error('invalid workspace path');
  const lexical = path.resolve(root, requested);
  const relative = path.relative(root, lexical);
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('workspace reads must name a file inside the selected repository');
  }
  const actual = realpathSync(lexical);
  const actualRelative = path.relative(root, actual);
  if (actualRelative.startsWith(`..${path.sep}`) || actualRelative === '..' || path.isAbsolute(actualRelative)) {
    throw new Error('workspace symlinks may not escape the selected repository');
  }
  const info = statSync(actual);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('workspace read must target a regular file under 1 MiB');
  return actual;
}
