/** One running instance per run folder: a second copy would wipe the first one's staging and logs. */
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Whether a process with this id is running. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type LockResult = { ok: true; release: () => void } | { ok: false; pid: number };

/**
 * Take the lock file for this process. A lock left by a process that is no longer running is taken over;
 * one held by a live process answers with its pid.
 */
export function acquireLock(file: string, pid = process.pid): LockResult {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (createLock(file, pid)) {
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          // Only remove the lock if it is still ours.
          if (readHolder(file) === pid) removeQuietly(file);
        },
      };
    }
    const holder = readHolder(file);
    if (holder !== null && holder !== pid && processAlive(holder)) return { ok: false, pid: holder };
    // Stale (or our own pid from an earlier run). Locks are never seen half-written (see createLock), so an
    // unreadable one is junk too. Move it aside atomically: only one contender can move a given file.
    const aside = `${file}.stale-${pid}`;
    try {
      renameSync(file, aside);
    } catch {
      continue; // another contender moved it first; try again
    }
    // Between our read and the move, another contender may have taken over and created a live lock;
    // if that is what we moved, put it back and report that instance.
    const moved = readHolder(aside);
    if (moved !== null && moved !== pid && moved !== holder && processAlive(moved)) {
      try {
        linkSync(aside, file);
      } catch {
        // someone already created a new lock; it decides
      }
      removeQuietly(aside);
      return { ok: false, pid: moved };
    }
    removeQuietly(aside);
  }
  throw new Error(`Could not take the lock file ${file}`);
}

/**
 * Create the lock with its pid already inside: write a private file, then hard-link it into place.
 * The link fails if the lock exists, so another instance never sees an empty lock while we start.
 */
function createLock(file: string, pid: number): boolean {
  const temp = `${file}.${pid}.tmp`;
  writeFileSync(temp, `${pid}\n`);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    removeQuietly(temp);
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

function readHolder(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}
