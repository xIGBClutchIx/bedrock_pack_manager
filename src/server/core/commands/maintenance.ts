/** Audit, rebuild, cleanup and fix-nesting. */
import type { CleanupResult, FixNestingResult, RebuildResult, WorldStatus } from "../../../shared/model";
import { CancelledError, throwIfAborted } from "../../storage/errors";
import { basename, join } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, plain, section, warn } from "../log";
import { compareVersions, uuidKey } from "../manifests";
import { PackIndex, versionLabel, type InstalledPack } from "../packIndex";
import { packVersionKey, registeredKeys, saveWorldJson, type WorldEntry } from "../worlds";
import { loadWorldPacks, otherWorldsUsing, worldStatus, worldSummaries } from "./status";

export { worldSummaries };

const STATUS_WARNINGS: Record<string, (label: string, json: string, row: WorldStatus["packs"][number]) => string> = {
  missing: (label, json, row) => `${label} ${row.name} (${row.uuid}) is registered in ${json} but missing on the server`,
  "version-mismatch": (label, json, row) =>
    `${label} ${row.name} is registered in ${json} at v${row.versionLabel} but the server has ${row.onServerVersions.join(", ")}`,
  unregistered: (label, json, row) => `${label} '${row.name}' is installed but not registered in ${json}`,
};

/** Read-only check of a world: changes nothing. */
export async function runAudit(ctx: CommandContext, world: string): Promise<WorldStatus> {
  const { target, log } = ctx;
  section(log, "Audit world and installed packs");
  plain(log, `Server: ${target.label}`);
  const status = await worldStatus(target, world);
  for (const row of status.packs) {
    const label = row.kind === "bp" ? "Behavior Pack" : "Resource Pack";
    const json = row.kind === "bp" ? "world_behavior_packs.json" : "world_resource_packs.json";
    const make = STATUS_WARNINGS[row.status];
    if (make) warn(log, make(label, json, row));
    else ok(log, `[${row.kind.toUpperCase()}] ${row.name} v${row.versionLabel}`);
  }
  for (const problem of status.problems) warn(log, problem.message);
  for (const note of status.notes) info(log, note);
  if (status.hiddenBuiltin) info(log, `Ignored ${status.hiddenBuiltin} built-in game pack(s) that ship with the server`);
  if (!log.warnings.length) ok(log, "Audit clean.");
  return status;
}

/** Overwrite the world JSONs with every pack on the server (newest version of each). */
export async function runRebuild(ctx: CommandContext, world: string): Promise<RebuildResult> {
  const { target, log } = ctx;
  section(log, "Rebuild world JSONs");
  const index = await PackIndex.build(target, world);
  for (const problem of index.problems) warn(log, problem.message);
  const counts = { bp: 0, rp: 0 };
  for (const kind of ["bp", "rp"] as const) {
    const newest = new Map<string, InstalledPack>();
    for (const pack of index.ofKind(kind)) {
      if (pack.nested || pack.builtin) continue;
      const current = newest.get(uuidKey(pack.uuid));
      if (current) {
        if (versionLabel(current) !== versionLabel(pack))
          warn(
            log,
            `'${pack.name}' has several versions installed (${versionLabel(current)}, ${versionLabel(pack)}) - registering the newest`,
          );
        if (compareVersions(pack.version, current.version) <= 0) continue;
      }
      newest.set(uuidKey(pack.uuid), pack);
    }
    const entries: WorldEntry[] = [...newest.values()]
      .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
      .map((pack) => {
        ok(log, `[${kind.toUpperCase()}] ${pack.name} v${versionLabel(pack)}`);
        return { pack_id: pack.uuid, version: pack.version };
      });
    await saveWorldJson(target.storage, target.worldJson(world, kind), entries);
    counts[kind] = entries.length;
  }
  ok(log, `Done. Registered ${counts.bp} behavior pack(s) and ${counts.rp} resource pack(s).`);
  const [status, worlds] = await Promise.all([worldStatus(target, world, index), worldSummaries(target)]);
  return { behaviorPacks: counts.bp, resourcePacks: counts.rp, status, worlds };
}

/** Delete pack folders this world does not register and no other world uses. */
export async function runCleanup(ctx: CommandContext, world: string, dryRun: boolean): Promise<CleanupResult> {
  const { target, log } = ctx;
  section(log, dryRun ? "Clean up pack folders (preview)" : "Clean up pack folders");
  const [index, worldPacks] = await Promise.all([PackIndex.build(target, world), loadWorldPacks(target, world)]);
  const registered = { bp: registeredKeys(worldPacks.bp), rp: registeredKeys(worldPacks.rp) };
  const cache = new Map<string, Set<string>>();
  const deleted: string[] = [];
  const kept: string[] = [];

  for (const pack of [...index.packs]) {
    throwIfAborted(ctx.signal);
    // Never touch development copies, the game's own packs, or packs in folders the server ignores.
    if (pack.scope === "dev" || pack.nested || pack.builtin) continue;
    if (registered[pack.dirKind].has(packVersionKey(pack.uuid, pack.version))) continue;
    const others = pack.scope === "shared" ? await otherWorldsUsing(target, world, pack.dirKind, pack.uuid, pack.version, cache) : [];
    if (others.length) {
      kept.push(target.describe(pack.path));
      info(log, `Kept ${target.describe(pack.path)} because it is still used by: ${others.join(", ")}`);
      continue;
    }
    if (dryRun) {
      deleted.push(target.describe(pack.path));
      info(log, `Would delete ${target.describe(pack.path)}`);
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
  if (!deleted.length) ok(log, "No unregistered pack folders to delete.");
  else ok(log, `${dryRun ? "Would delete" : "Deleted"} ${deleted.length} unregistered pack folder(s).`);
  return { deleted, kept, dryRun, status: dryRun ? undefined : await worldStatus(target, world, index) };
}

/** Move packs that sit one folder too deep up into their pack folder. */
export async function runFixNesting(ctx: CommandContext, world: string, paths: string[], dryRun: boolean): Promise<FixNestingResult> {
  const { target, log } = ctx;
  section(log, dryRun ? "Fix nested packs (preview)" : "Fix nested packs");
  const index = await PackIndex.build(target, world);
  const wanted = new Set(paths);
  const nested = index.packs.filter((pack) => pack.nested && (!wanted.size || wanted.has(pack.path)));
  const moves: { from: string; to: string }[] = [];

  for (const pack of nested) {
    throwIfAborted(ctx.signal);
    const wrapper = pack.path.slice(0, pack.path.lastIndexOf("/"));
    const names = new Set((await target.storage.listDir(pack.packDir)).map((entry) => entry.name.toLowerCase()));
    let name = basename(pack.path);
    // The wrapper itself goes away, so its name is free unless the pack keeps it.
    names.delete(basename(wrapper).toLowerCase());
    for (let counter = 2; names.has(name.toLowerCase()); counter++) name = `${basename(pack.path)}_${counter}`;
    const destination = join(pack.packDir, name);
    moves.push({ from: target.describe(pack.path), to: target.describe(destination) });
    if (dryRun) {
      info(log, `Would move ${target.describe(pack.path)} to ${target.describe(destination)}`);
      continue;
    }
    // Move out to a temporary name first: the destination may be the wrapper's own name.
    const temp = join(pack.packDir, `${name}.bpm-move`);
    await target.storage.rename(pack.path, temp);
    const leftovers = await target.storage.listDir(wrapper).catch(() => []);
    if (!leftovers.length) await target.storage.removeTree(wrapper);
    else info(log, `Left ${target.describe(wrapper)} in place: it still holds ${leftovers.length} other item(s)`);
    await target.storage.rename(temp, destination);
    ok(log, `Moved ${basename(pack.path)} up to ${target.describe(destination)}`);
  }
  if (!nested.length) ok(log, "No nested packs to fix.");
  return { moves, dryRun, status: dryRun ? undefined : await worldStatus(target, world) };
}
