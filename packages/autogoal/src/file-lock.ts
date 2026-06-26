/**
 * v0.7.3 / scan 2026-06-25 (C1) — cross-process file lock.
 *
 * `withStateLock` (goal-state.ts) is in-process only: per-directory
 * promise chains serialize mutations within a single JS process.
 * Two plugin instances (or two JS processes) writing the same
 * workspace race on the state file.
 *
 * `withFileLock` adds a cross-process layer using an exclusive
 * lockfile. The lockfile is created with O_EXCL | O_CREAT; if it
 * already exists, another process holds the lock and we wait with
 * exponential backoff. The lockfile path is `<workspace>/.opencode/
 * .goal-state.lock` (next to the state file). Stale lockfiles from
 * crashed processes are detected by mtime and cleared.
 *
 * No external dependencies — uses Node's built-in fs.open. Best-effort:
 * if the lockfile mechanism fails (read-only FS, permission denied),
 * the function logs and proceeds without locking. The in-process
 * withStateLock is still the primary serialization primitive.
 */

import { open, stat, unlink, mkdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, dirname } from "node:path";

const LOCK_FILE_NAME = ".opencode/.goal-state.lock";
const ACQUIRE_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 10_000;
const POLL_BASE_MS = 5;
const POLL_MAX_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(directory: string): string {
  return join(directory, LOCK_FILE_NAME);
}

async function tryAcquire(p: string): Promise<FileHandle | null> {
  // O_EXCL | O_CREAT: open fails if the file already exists.
  // Returns a FileHandle on success, throws on EEXIST.
  try {
    return await open(p, "wx");
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") return null;
    // Other errors (EACCES, ENOENT on parent dir, etc.) — propagate.
    throw err;
  }
}

async function isStale(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return Date.now() - s.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

async function ensureLockDir(p: string): Promise<void> {
  try {
    await mkdir(dirname(p), { recursive: true });
  } catch {
    // mkdir may fail if the dir already exists; that's fine.
  }
}

export interface FileLockOptions {
  /** Max time to wait for the lock before giving up. Default 2000ms. */
  acquireTimeoutMs?: number;
  /** If true, never throw — fall through to running fn unlocked. */
  bestEffort?: boolean;
}

export async function withFileLock<T>(
  directory: string,
  fn: () => Promise<T> | T,
  opts: FileLockOptions = {},
): Promise<T | undefined> {
  const acquireTimeout = opts.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const bestEffort = opts.bestEffort ?? true;
  const p = lockPath(directory);

  let fd: FileHandle | null = null;
  try {
    await ensureLockDir(p);
    const start = Date.now();
    let pollMs = POLL_BASE_MS;
    while (Date.now() - start < acquireTimeout) {
      fd = await tryAcquire(p);
      if (fd !== null) break;
      // Stale-lock check: if older than STALE_LOCK_MS, previous
      // holder likely crashed. Remove and retry.
      if (await isStale(p)) {
        try { await unlink(p); } catch { /* race; ignore */ }
      }
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
    }
    if (fd === null) {
      if (bestEffort) {
        // Could not acquire; in-process withStateLock still serializes
        // within this process. Proceed unlocked cross-process.
        return await fn();
      }
      return undefined;
    }
    // Write the current pid for diagnostics.
    try {
      await writeFile(fd, `${process.pid}\n`);
    } catch {
      // Best-effort; the fd is held which is what matters.
    }
    return await fn();
  } catch (err) {
    if (bestEffort) {
      return await fn();
    }
    throw err;
  } finally {
    if (fd !== null) {
      try { await fd.close(); } catch { /* ignore */ }
      try { await unlink(lockPath(directory)); } catch { /* ignore */ }
    }
  }
}