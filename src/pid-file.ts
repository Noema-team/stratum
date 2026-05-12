import { promises as fs } from 'node:fs';

export async function writePidFile(path: string, pid: number): Promise<void> {
  await fs.writeFile(path, String(pid), 'utf8');
}

export async function readPidFile(path: string): Promise<number | null> {
  try {
    const content = await fs.readFile(path, 'utf8');
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function removePidFile(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
