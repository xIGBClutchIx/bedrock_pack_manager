/** Remove packs from a world, and delete their folders when nothing else uses them. */
import type { PackKind, UninstallResult } from "../../../shared/model";
import { formatVersion, packKey } from "../../../shared/model";
import { CancelledError, throwIfAborted } from "../../storage/errors";
import { basename } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, section, warn } from "../log";
import { PackIndex, type InstalledPack } from "../packIndex";
import { removeEntry, saveWorldJson } from "../worlds";
import { loadWorldPacks, otherWorldsUsing, worldStatus, worldSummaries } from "./status";

const KIND_LABEL = { bp: "Behavior Pack", rp: "Resource Pack" } as const;

export class SelectionError extends Error {}

export async function runUninstall(ctx: CommandContext, world: string, keys: string[], keepFiles: boolean): Promise<UninstallResult> {
  const { target, log } = ctx;
  const [index, worldPacks] = await Promise.all([PackIndex.build(target, world), loadWorldPacks(target, world)]);

  interface Candidate {
    key: string;
    kind: PackKind;
    uuid: string;
    version: unknown[];
    name: string;
    installed: InstalledPack[];
  }
  const candidates = new Map<string, Candidate>();
  for (const kind of ["bp", "rp"] as const) {
    for (const entry of worldPacks[kind]) {
      if (!entry.pack_id || !Array.isArray(entry.version)) continue;
      const installed = index.findVersion(entry.pack_id, entry.version, kind);
      const any = index.find(entry.pack_id, kind);
      const key = packKey(kind, entry.pack_id, entry.version);
      candidates.set(key, {
        key,
        kind,
        uuid: entry.pack_id,
        version: entry.version,
        name: installed[0]?.name ?? any[0]?.name ?? entry.pack_id,
        installed,
      });
    }
  }
  const unknown = keys.filter((key) => !candidates.has(key));
  if (unknown.length) throw new SelectionError(`Unknown uninstall selection(s): ${unknown.join(", ")}`);
  const chosen = [...new Set(keys)].map((key) => candidates.get(key)!);

  section(log, keepFiles ? "Remove packs from world" : "Uninstall packs");

  // Unregister first and save, so an interrupted delete never leaves the world pointing at half a pack.
  let removed = 0;
  const changed = new Set<PackKind>();
  for (const candidate of chosen) {
    if (removeEntry(worldPacks[candidate.kind], candidate.uuid)) {
      changed.add(candidate.kind);
      removed++;
    }
  }
  for (const kind of changed) await saveWorldJson(target.storage, target.worldJson(world, kind), worldPacks[kind]);

  const deleted: string[] = [];
  const cache = new Map<string, Set<string>>();
  for (const candidate of chosen) {
    throwIfAborted(ctx.signal);
    section(log, `[${KIND_LABEL[candidate.kind]}] ${candidate.name} (v${formatVersion(candidate.version as never)})`);
    ok(log, `Unregistered from ${basename(target.worldJson(world, candidate.kind))}`);
    if (!candidate.installed.length) {
      info(log, "No matching pack folder on the server");
      continue;
    }
    if (keepFiles) {
      info(log, "Kept the pack folder on the server");
      continue;
    }
    const others = await otherWorldsUsing(target, world, candidate.kind, candidate.uuid, candidate.version, cache);
    for (const pack of candidate.installed) {
      if (pack.builtin) {
        info(log, `Kept built-in game pack ${target.describe(pack.path)}`);
        continue;
      }
      if (pack.scope === "dev") {
        info(log, `Kept development copy ${target.describe(pack.path)}`);
        continue;
      }
      if (pack.scope === "shared" && others.length) {
        info(log, `Kept ${target.describe(pack.path)} because it is still used by: ${others.join(", ")}`);
        continue;
      }
      try {
        await target.storage.removeTree(pack.path, { signal: ctx.signal });
        index.remove(pack.path);
        deleted.push(target.describe(pack.path));
        ok(log, `Deleted ${target.describe(pack.path)}`);
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        warn(log, `Could not delete ${target.describe(pack.path)}: ${(error as Error).message}`);
      }
    }
  }

  ok(
    log,
    `Done. Removed ${removed} pack(s) from '${basename(world) || target.label}'${keepFiles ? "; folders kept" : `; deleted ${deleted.length} folder(s)`}.`,
  );
  const [status, worlds] = await Promise.all([worldStatus(target, world, index), worldSummaries(target)]);
  return { removed, deleted, status, worlds };
}
