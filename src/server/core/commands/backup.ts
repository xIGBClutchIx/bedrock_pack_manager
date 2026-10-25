/** Stream a zip of a world (or every world) plus the pack folders, straight from the server. */
import type { Writable } from "node:stream";

import { ZipArchive } from "archiver";

import { isNotFound, throwIfAborted } from "../../storage/errors";
import { basename, join } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, section, warn } from "../log";

export interface BackupSummary {
  files: number;
  bytes: number;
}

export function backupFileName(world: string | null): string {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const name = world ? basename(world).replace(/[^\w.-]+/g, "_") || "world" : "server";
  return `Backup_${name}_${stamp}.zip`;
}

/** Folders to back up and where each lands inside the zip. */
async function backupFolders(ctx: CommandContext, world: string | null): Promise<[string, string][]> {
  const { layout } = ctx.target;
  const folders: [string, string][] = [];
  if (world !== null) folders.push([world, join("worlds", basename(world) || "world")]);
  else if (layout.singleWorld !== null) folders.push([layout.singleWorld, "world"]);
  else if (layout.worldsDir !== null) folders.push([layout.worldsDir, "worlds"]);
  for (const dir of [layout.bpDir, layout.devBpDir, layout.rpDir, layout.devRpDir]) {
    if (dir !== null) folders.push([dir, basename(dir) || "packs"]);
  }
  return folders;
}

/** How much downloaded data may wait for the zip (and the browser) before downloading pauses. */
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export async function runBackup(ctx: CommandContext, world: string | null, output: Writable): Promise<BackupSummary> {
  const { target, log } = ctx;
  section(log, world ? `Back up ${basename(world)}` : "Back up the server");
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("finish", resolve);
    zip.on("error", reject);
    output.on("error", reject);
  });
  done.catch(() => undefined); // awaited below; a failure before then is handled by the catch
  zip.pipe(output);

  // Entries leave the queue in order as the zip takes them; wait while too much is queued, so a slow
  // download pauses reading from the server instead of piling it up in memory.
  const queued: number[] = [];
  let queuedBytes = 0;
  let processed = 0;
  let wake: (() => void) | null = null;
  zip.on("progress", (progress: { entries: { processed: number } }) => {
    while (processed < progress.entries.processed && queued.length) {
      queuedBytes -= queued.shift()!;
      processed++;
    }
    wake?.();
  });
  const roomInQueue = async () => {
    while (queuedBytes > MAX_QUEUED_BYTES) {
      throwIfAborted(ctx.signal);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 1000).unref();
      });
      wake = null;
    }
  };

  let files = 0;
  let bytes = 0;
  let skipped = 0;
  try {
    for (const [folder, inZip] of await backupFolders(ctx, world)) {
      if (!(await target.storage.isDir(folder))) {
        info(log, `${target.describe(folder)} does not exist - skipping`);
        continue;
      }
      info(log, `Adding ${target.describe(folder)}`);
      try {
        const onSkip = (path: string, reason: string) => {
          skipped++;
          warn(log, `Skipped ${inZip}/${path}: ${reason}`);
        };
        for await (const [relativePath, data] of target.storage.downloadFiles(folder, { signal: ctx.signal, onSkip })) {
          await roomInQueue();
          queued.push(data.length);
          queuedBytes += data.length;
          zip.append(data, { name: `${inZip}/${relativePath}` });
          files++;
          bytes += data.length;
          if (files % 25 === 0) log.progress("Backing up", files, files, "files");
        }
      } catch (error) {
        // The whole folder vanished between the check and the scan.
        if (!isNotFound(error)) throw error;
        warn(log, `${target.describe(folder)} disappeared while backing up - skipped`);
      }
    }
    await zip.finalize();
    await done;
  } catch (error) {
    zip.abort();
    throw error;
  }
  ok(log, `Backed up ${files} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (skipped) warn(log, `${skipped} file(s) were skipped - stop the server for a complete backup`);
  return { files, bytes };
}
