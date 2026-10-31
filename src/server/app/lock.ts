/** One running instance per run folder: a second copy would wipe the first one's staging and logs. */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, `${pid}\n`, { flag: "wx" });
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          // Only remove the lock if it is still ours.
          if (readHolder(file) === pid) {
            try {
              unlinkSync(file);
            } catch {
              // already gone
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readHolder(file);
    if (holder !== null && holder !== pid && processAlive(holder)) return { ok: false, pid: holder };
    // Stale (or unreadable, or our own pid from an earlier run): remove it and try again.
    try {
      unlinkSync(file);
    } catch {
      // another process may have removed it first
    }
  }
  throw new Error(`Could not take the lock file ${file}`);
}

function readHolder(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}
