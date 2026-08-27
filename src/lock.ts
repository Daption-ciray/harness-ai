import { existsSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LockHolder = { pid: number; owner: string; at: string };

export class LockBusy extends Error {
  holder: LockHolder;
  constructor(holder: LockHolder) {
    super(`held by ${holder.owner} (pid ${holder.pid}) since ${holder.at}`);
    this.holder = holder;
  }
}

function readHolder(file: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockHolder;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Advisory mutual exclusion between the daemon and any CLI invocation. Without
 * it, `harness run` and a daemon tick can advance the same task at once and
 * produce two worktrees and two pull requests for one backlog item.
 *
 * `wx` makes creation atomic, so two processes racing to create it cannot both
 * win. A lock whose owner is dead is stolen rather than waited on — a killed
 * daemon must not wedge the repository forever.
 */
export function acquire(file: string, owner: string): () => void {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      const holder: LockHolder = { pid: process.pid, owner, at: new Date().toISOString() };
      writeSync(fd, JSON.stringify(holder));
      closeSync(fd);
      return () => {
        // Only ever remove our own lock: a stolen-then-reacquired lock belongs
        // to someone else, and releasing it would hand out a second copy.
        const current = readHolder(file);
        if (current?.pid === process.pid) rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readHolder(file);
      if (holder && alive(holder.pid)) throw new LockBusy(holder);
      rmSync(file, { force: true }); // stale: the owner is gone
    }
  }
  throw new LockBusy(readHolder(file) ?? { pid: -1, owner: "unknown", at: "" });
}

export async function withLock<T>(file: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const release = acquire(file, owner);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function lockHolder(file: string): LockHolder | null {
  if (!existsSync(file)) return null;
  const holder = readHolder(file);
  return holder && alive(holder.pid) ? holder : null;
}
