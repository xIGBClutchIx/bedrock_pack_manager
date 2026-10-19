/** Stream a zip of a world (or every world) plus the pack folders, straight from the server. */
import type { Writable } from "node:stream";

import { ZipArchive } from "archiver";

import { isNotFound } from "../../storage/errors";
import { basename, join } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, section } from "../log";

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
  zip.pipe(output);
  let files = 0;
  let bytes = 0;
  try {
    for (const [folder, inZip] of await backupFolders(ctx, world)) {
      if (!(await target.storage.isDir(folder))) {
        info(log, `${target.describe(folder)} does not exist - skipping`);
        continue;
      }
      info(log, `Adding ${target.describe(folder)}`);
      try {
        for await (const [relativePath, data] of target.storage.downloadFiles(folder, ctx.signal)) {
          zip.append(data, { name: `${inZip}/${relativePath}` });
          files++;
          bytes += data.length;
          if (files % 25 === 0) log.progress("Backing up", files, files, "files");
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    await zip.finalize();
    await done;
  } catch (error) {
    zip.abort();
    throw error;
  }
  ok(log, `Backed up ${files} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return { files, bytes };
}
