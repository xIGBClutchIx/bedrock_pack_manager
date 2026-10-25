/** Audit, rebuild, cleanup and fix-nesting. */
import type { CleanupResult, FixNestingResult, RebuildResult, WorldStatus } from "../../../shared/model";
import { CancelledError, throwIfAborted } from "../../storage/errors";
import { JUNK_NAMES, basename, join } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, plain, section, warn } from "../log";
import { compareVersions, uuidKey } from "../manifests";
import { PackIndex, versionLabel, type InstalledPack } from "../packIndex";
import { WorldJsonError, loadWorldJson, saveWorldJson, type WorldEntry } from "../worlds";
import { loadWorldPacks, otherWorldsUsing, registrationNeeds, worldStatus, worldSummaries, type WorldJsonCache } from "./status";

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

/**
 * Register every pack on the server in the world JSONs (newest version of each). Entries that are
 * already there keep their place in the list (resource pack priority) and extra fields such as
 * `subpack`; packs that are no longer on the server are dropped; new ones go after them.
 */
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
      if (pack.kind !== kind) {
        // Skin packs, world templates and packs in the wrong folder would only confuse the game.
        warn(
          log,
          `Left out ${target.describe(pack.path)}: ${pack.kind ? `a ${pack.kind === "bp" ? "behavior" : "resource"} pack in the wrong folder` : "not a behavior or resource pack"}`,
        );
        continue;
      }
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

    const jsonPath = target.worldJson(world, kind);
    let existing: WorldEntry[] = [];
    try {
      existing = await loadWorldJson(target.storage, jsonPath);
    } catch (error) {
      if (!(error instanceof WorldJsonError)) throw error;
      warn(log, `${error.message} - starting it again from the packs on the server`);
    }
    const entries: WorldEntry[] = [];
    const placed = new Set<string>();
    for (const entry of existing) {
      const pack = newest.get(uuidKey(entry.pack_id));
      if (!pack || placed.has(uuidKey(pack.uuid))) {
        if (!pack && entry.pack_id) info(log, `Dropped ${entry.pack_id}: not on the server`);
        continue;
      }
      placed.add(uuidKey(pack.uuid));
      entries.push({ ...entry, pack_id: pack.uuid, version: pack.version });
      ok(log, `[${kind.toUpperCase()}] ${pack.name} v${versionLabel(pack)}`);
    }
    const added = [...newest.values()]
      .filter((pack) => !placed.has(uuidKey(pack.uuid)))
      .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    for (const pack of added) {
      entries.push({ pack_id: pack.uuid, version: pack.version });
      ok(log, `[${kind.toUpperCase()}] ${pack.name} v${versionLabel(pack)} (added)`);
    }
    await saveWorldJson(target.storage, jsonPath, entries);
    counts[kind] = entries.length;
  }
  ok(log, `Done. Registered ${counts.bp} behavior pack(s) and ${counts.rp} resource pack(s).`);
  const [status, worlds] = await Promise.all([worldStatus(target, world, index), worldSummaries(target)]);
  return { behaviorPacks: counts.bp, resourcePacks: counts.rp, status, worlds };
}

/**
 * Delete pack folders that neither this world nor any other needs (see otherWorldsUsing). With `only`,
 * just those folders (storage paths) are considered.
 */
export async function runCleanup(ctx: CommandContext, world: string, dryRun: boolean, only?: string[]): Promise<CleanupResult> {
  const { target, log } = ctx;
  section(log, dryRun ? "Clean up pack folders (preview)" : "Clean up pack folders");
  const [index, worldPacks] = await Promise.all([PackIndex.build(target, world), loadWorldPacks(target, world)]);
  const cache: WorldJsonCache = new Map();
  const wanted = only?.length ? new Set(only) : null;
  const deleted: string[] = [];
  const kept: string[] = [];
  const keep = (pack: InstalledPack, reason: string) => {
    kept.push(target.describe(pack.path));
    info(log, `Kept ${target.describe(pack.path)}: ${reason}`);
  };

  for (const pack of [...index.packs]) {
    throwIfAborted(ctx.signal);
    if (wanted && !wanted.has(pack.path)) continue;
    // Never touch development copies, the game's own packs, or packs in folders the server ignores.
    if (pack.builtin) {
      if (wanted) keep(pack, "a built-in game pack");
      continue;
    }
    if (pack.scope === "dev") {
      if (wanted) keep(pack, "a development pack");
      continue;
    }
    if (pack.nested) {
      if (wanted) keep(pack, "nested inside another folder - fix the nesting first");
      continue;
    }
    if (registrationNeeds(worldPacks[pack.dirKind], pack.dirKind, pack, index)) {
      if (wanted) keep(pack, "this world uses it");
      continue;
    }
    const others = pack.scope === "shared" ? await otherWorldsUsing(target, world, pack.dirKind, pack, cache, index) : [];
    if (others.length) {
      keep(pack, `still used by ${others.join(", ")}`);
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
  if (!deleted.length) ok(log, "No unused pack folders to delete.");
  else ok(log, `${dryRun ? "Would delete" : "Deleted"} ${deleted.length} unused pack folder(s).`);
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
    // The wrapper goes away only when the pack is all it holds; only then is its name free.
    const others = (await target.storage.listDir(wrapper)).filter(
      (entry) => entry.name !== basename(pack.path) && !JUNK_NAMES.has(entry.name),
    );
    if (!others.length) names.delete(basename(wrapper).toLowerCase());
    let name = basename(pack.path);
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
    if (!others.length) await target.storage.removeTree(wrapper);
    else info(log, `Left ${target.describe(wrapper)} in place: it still holds ${others.length} other item(s)`);
    await target.storage.rename(temp, destination);
    ok(log, `Moved ${basename(pack.path)} up to ${target.describe(destination)}`);
  }
  if (!nested.length) ok(log, "No nested packs to fix.");
  return { moves, dryRun, status: dryRun ? undefined : await worldStatus(target, world) };
}
