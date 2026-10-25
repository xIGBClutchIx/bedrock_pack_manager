/** Small edits to world pack lists: register a pack that is already on the server, reorder, pick a subpack. */
import type { PackKind, WorldPackChange, WorldPacksResult } from "../../../shared/model";
import { formatVersion } from "../../../shared/model";
import { basename } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, section, warn } from "../log";
import { uuidKey } from "../manifests";
import { PackIndex } from "../packIndex";
import { loadWorldJson, saveWorldJson, upsertEntry, type WorldEntry } from "../worlds";
import { worldStatus, worldSummaries } from "./status";

export async function runWorldPacks(ctx: CommandContext, world: string, changes: WorldPackChange[]): Promise<WorldPacksResult> {
  const { target, log } = ctx;
  section(log, "Update world pack lists");
  const index = await PackIndex.build(target, world);
  const lists = new Map<string, WorldEntry[]>();
  const dirty = new Set<string>();
  const listFor = async (where: string, kind: PackKind) => {
    const path = target.worldJson(where, kind);
    if (!lists.has(path)) lists.set(path, await loadWorldJson(target.storage, path));
    return { path, entries: lists.get(path)! };
  };
  const applied: string[] = [];
  const nameOf = (uuid: string, kind?: PackKind) => index.find(uuid, kind)[0]?.name ?? uuid;

  for (const change of changes) {
    if (change.type === "register") {
      const label = `${nameOf(change.uuid, change.kind)} v${formatVersion(change.version)}`;
      if (!index.findVersion(change.uuid, change.version, change.kind).length)
        warn(log, `${label} is not on the server - the world will list it as missing`);
      for (const where of change.worlds?.length ? change.worlds : [world]) {
        const { path, entries } = await listFor(where, change.kind);
        const result = upsertEntry(entries, change.uuid, change.version);
        const worldName = basename(where) || target.label;
        if (result === "unchanged") info(log, `${label} was already registered in '${worldName}'`);
        else {
          dirty.add(path);
          applied.push(`${result === "added" ? "Registered" : "Switched to"} ${label} in '${worldName}'`);
        }
      }
    } else if (change.type === "order") {
      const { path, entries } = await listFor(world, change.kind);
      const rank = new Map(change.uuids.map((uuid, position) => [uuidKey(uuid), position]));
      // Listed packs first, in the given order; everything else keeps its relative order after them.
      const sorted = entries
        .map((entry, position) => ({ entry, position }))
        .sort((a, b) => {
          const ra = rank.get(uuidKey(a.entry.pack_id)) ?? Number.MAX_SAFE_INTEGER;
          const rb = rank.get(uuidKey(b.entry.pack_id)) ?? Number.MAX_SAFE_INTEGER;
          return ra - rb || a.position - b.position;
        })
        .map(({ entry }) => entry);
      if (sorted.some((entry, position) => entry !== entries[position])) {
        entries.splice(0, entries.length, ...sorted);
        dirty.add(path);
        applied.push(`Reordered ${change.kind === "bp" ? "behavior" : "resource"} packs`);
      }
    } else if (change.type === "subpack") {
      const { path, entries } = await listFor(world, "rp");
      const entry = entries.find((candidate) => uuidKey(candidate.pack_id) === uuidKey(change.uuid));
      if (!entry) {
        warn(log, `${nameOf(change.uuid, "rp")} is not registered in this world - register it before picking a subpack`);
        continue;
      }
      const offered = index.find(change.uuid, "rp").flatMap((pack) => pack.details.subpacks.map((subpack) => subpack.folder));
      if (change.subpack && !offered.includes(change.subpack)) warn(log, `${nameOf(change.uuid, "rp")} has no subpack '${change.subpack}'`);
      if ((entry.subpack ?? null) === change.subpack) continue;
      if (change.subpack) entry.subpack = change.subpack;
      else delete entry.subpack;
      dirty.add(path);
      applied.push(
        change.subpack
          ? `Picked subpack '${change.subpack}' for ${nameOf(change.uuid, "rp")}`
          : `Cleared the subpack of ${nameOf(change.uuid, "rp")}`,
      );
    }
  }

  for (const path of dirty) await saveWorldJson(target.storage, path, lists.get(path)!);
  for (const line of applied) ok(log, line);
  if (!applied.length) info(log, "Nothing needed changing");
  const [status, worlds] = await Promise.all([worldStatus(target, world, index), worldSummaries(target)]);
  return { applied, status, worlds };
}
