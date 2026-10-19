/** World status: registered packs, stray folders, problems and level.dat, plus world summaries. */
import type { LevelInfo, PackKind, PackRow, Problem, WorldStatus, WorldSummary } from "../../../shared/model";
import { formatVersion, packKey } from "../../../shared/model";
import { isNotFound } from "../../storage/errors";
import { basename } from "../../storage/path";
import type { Target } from "../layout";
import { uuidKey } from "../manifests";
import { betaEnabled, gamemodeOf, levelNameOf, readLevelDat } from "../nbt";
import { PackIndex, versionLabel } from "../packIndex";
import { WorldJsonError, loadWorldJson, packVersionKey, registeredKeys, type WorldEntry } from "../worlds";

export type WorldPacks = Record<PackKind, WorldEntry[]>;

export async function loadWorldPacks(target: Target, world: string): Promise<WorldPacks> {
  const [bp, rp] = await Promise.all([
    loadWorldJson(target.storage, target.worldJson(world, "bp")),
    loadWorldJson(target.storage, target.worldJson(world, "rp")),
  ]);
  return { bp, rp };
}

/** Names of other worlds that register the same pack version (cached across calls). */
export async function otherWorldsUsing(
  target: Target,
  world: string,
  kind: PackKind,
  uuid: string,
  version: unknown,
  cache: Map<string, Set<string>>,
): Promise<string[]> {
  const others = (await target.listWorlds()).filter((other) => other !== world);
  const key = packVersionKey(uuid, version as never);
  const users: string[] = [];
  await Promise.all(
    others.map(async (other) => {
      const cacheKey = `${other}|${kind}`;
      if (!cache.has(cacheKey)) {
        const entries = await loadWorldJson(target.storage, target.worldJson(other, kind)).catch(() => []);
        cache.set(cacheKey, registeredKeys(entries));
      }
      if (cache.get(cacheKey)!.has(key)) users.push(basename(other));
    }),
  );
  return users.sort();
}

export async function readLevelInfo(target: Target, world: string): Promise<LevelInfo> {
  const level: LevelInfo = { exists: false, beta: null, gamemode: null, levelName: null, error: null };
  try {
    const dat = await readLevelDat(target.storage, target.levelDat(world));
    return { exists: true, beta: betaEnabled(dat), gamemode: gamemodeOf(dat), levelName: levelNameOf(dat), error: null };
  } catch (error) {
    if (isNotFound(error)) return level;
    return { ...level, exists: true, error: (error as Error).message };
  }
}

export async function worldStatus(target: Target, world: string, index?: PackIndex): Promise<WorldStatus> {
  const [packIndex, worldPacks, level] = await Promise.all([
    index ?? PackIndex.build(target, world),
    loadWorldPacks(target, world),
    readLevelInfo(target, world),
  ]);
  const rows: PackRow[] = [];
  const problems: Problem[] = [...packIndex.problems];
  const seen = new Set<string>();

  for (const kind of ["bp", "rp"] as const) {
    for (const entry of worldPacks[kind]) {
      const uuid = String(entry.pack_id ?? "");
      if (!uuid) {
        problems.push({ kind: "registration", message: `${basename(target.worldJson(world, kind))} contains an entry with no pack_id` });
        continue;
      }
      seen.add(`${kind}|${uuidKey(uuid)}`);
      const version = Array.isArray(entry.version) ? entry.version : [];
      const installed = packIndex.find(uuid, kind);
      const exact = installed.filter((pack) => JSON.stringify(pack.version) === JSON.stringify(version));
      const source = exact[0] ?? installed[0];
      rows.push({
        key: Array.isArray(entry.version) ? packKey(kind, uuid, version) : "",
        kind,
        uuid,
        version,
        versionLabel: formatVersion(version),
        name: source?.name ?? uuid,
        status: exact.length ? "ok" : installed.length ? "version-mismatch" : "missing",
        registered: true,
        paths: (exact.length ? exact : installed).map((pack) => target.describe(pack.path)),
        onServerVersions: [...new Set(installed.map(versionLabel))].sort(),
        scope: source?.scope ?? null,
        dependencies: source?.dependencies ?? [],
      });
    }
  }

  let hiddenBuiltin = 0;
  for (const pack of packIndex.packs) {
    if (seen.has(`${pack.dirKind}|${uuidKey(pack.uuid)}`)) continue;
    if (pack.builtin) {
      hiddenBuiltin++;
      continue;
    }
    rows.push({
      key: "",
      kind: pack.dirKind,
      uuid: pack.uuid,
      version: pack.version,
      versionLabel: versionLabel(pack),
      name: pack.name,
      status: "unregistered",
      registered: false,
      paths: [target.describe(pack.path)],
      onServerVersions: [versionLabel(pack)],
      scope: pack.scope,
      dependencies: pack.dependencies,
    });
  }

  const known = new Set([...packIndex.uuids(), ...[...worldPacks.bp, ...worldPacks.rp].map((entry) => uuidKey(entry.pack_id))]);
  const dependencyProblems = new Set<string>();
  for (const row of rows) {
    if (!row.registered) continue;
    for (const dep of row.dependencies) {
      const depUuid = uuidKey(dep.uuid);
      if (depUuid && depUuid !== uuidKey(row.uuid) && !known.has(depUuid)) {
        dependencyProblems.add(
          `'${row.name}' depends on UUID ${dep.uuid} (v${formatVersion(dep.version as never)}) which is not installed - it may not work. Install the matching pack too.`,
        );
      }
    }
  }
  for (const message of [...dependencyProblems].sort()) problems.push({ kind: "dependency", message });

  rows.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      Number(!a.registered) - Number(!b.registered) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  const [bpDir, rpDir] = await Promise.all([target.installDir(world, "bp"), target.installDir(world, "rp")]);
  return {
    world,
    worldName: basename(world) || target.label,
    packs: rows,
    problems,
    notes: [...packIndex.notes],
    hiddenBuiltin,
    level,
    installDirs: { bp: target.describe(bpDir), rp: target.describe(rpDir) },
  };
}

/** One line per world for the sidebar, read in parallel. */
export async function worldSummaries(target: Target): Promise<WorldSummary[]> {
  const worlds = await target.listWorlds();
  return Promise.all(
    worlds.map(async (world) => {
      const names = new Set((await target.storage.listDir(world).catch(() => [])).map((entry) => entry.name.toLowerCase()));
      const count = async (kind: PackKind): Promise<number | null> => {
        if (!names.has(basename(target.worldJson(world, kind)).toLowerCase())) return null;
        return loadWorldJson(target.storage, target.worldJson(world, kind)).then(
          (entries) => entries.length,
          (error) => {
            if (error instanceof WorldJsonError) return null;
            throw error;
          },
        );
      };
      const [bpCount, rpCount] = await Promise.all([count("bp"), count("rp")]);
      return {
        path: world,
        name: basename(world) || target.label,
        hasLevelDat: names.has("level.dat"),
        bpCount,
        rpCount,
        isLevelName: !!target.layout.levelName && basename(world) === target.layout.levelName,
      };
    }),
  );
}
