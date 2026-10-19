/** The run/ folder: everything the app writes lives here, next to the exe (or the repo). */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AppPaths {
  runDir: string;
  logsDir: string;
  stagingDir: string;
  uploadsDir: string;
  unpackDir: string;
  knownHostsFile: string;
  profilesFile: string;
}

export function isSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

/** Folder the app treats as "home": beside the exe when packaged, else the current folder. */
export function defaultBaseDir(): string {
  return isSea() ? dirname(process.execPath) : process.cwd();
}

export function buildPaths(dataDir?: string): AppPaths {
  const runDir = resolve(dataDir ?? join(defaultBaseDir(), "run"));
  const stagingDir = join(runDir, "staging");
  return {
    runDir,
    logsDir: join(runDir, "logs"),
    stagingDir,
    uploadsDir: join(stagingDir, "uploads"),
    unpackDir: join(stagingDir, "unpack"),
    knownHostsFile: join(runDir, "known_hosts"),
    profilesFile: join(runDir, "profiles.json"),
  };
}

export function ensureDirs(paths: AppPaths): void {
  for (const dir of [paths.runDir, paths.logsDir, paths.stagingDir, paths.uploadsDir, paths.unpackDir]) mkdirSync(dir, { recursive: true });
}
