/** World status: registered packs, stray folders, problems and level.dat, plus world summaries. */
import type { DependencyInfo, LevelInfo, PackKind, PackRow, Problem, Version, WorldStatus, WorldSummary } from "../../../shared/model";
import { formatVersion, packKey } from "../../../shared/model";
import { isNotFound } from "../../storage/errors";
import { basename } from "../../storage/path";
import type { Target } from "../layout";
import { compareVersions, normalizeVersion, uuidKey } from "../manifests";
import { betaEnabled, experimentsOf, gamemodeOf, levelNameOf, readLevelDat } from "../nbt";
import { NO_DETAILS, PackIndex, versionLabel, type InstalledPack } from "../packIndex";
import { WorldJsonError, entryVersion, loadWorldJson, packVersionKey, registeredKeys, type WorldEntry } from "../worlds";

export type WorldPacks = Record<PackKind, WorldEntry[]>;

export async function loadWorldPacks(target: Target, world: string): Promise<WorldPacks> {
  const [bp, rp] = await Promise.all([
    loadWorldJson(target.storage, target.worldJson(world, "bp")),
    loadWorldJson(target.storage, target.worldJson(world, "rp")),
  ]);
  return { bp, rp };
}

/** Other worlds' pack lists, read once per job: entries, or the error that stopped the read. */
export type WorldJsonCache = Map<string, WorldEntry[] | Error>;

async function cachedWorldJson(target: Target, world: string, kind: PackKind, cache: WorldJsonCache): Promise<WorldEntry[] | Error> {
  const cacheKey = `${world}|${kind}`;
  if (!cache.has(cacheKey)) {
    const entries = await loadWorldJson(target.storage, target.worldJson(world, kind)).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    cache.set(cacheKey, entries);
  }
  return cache.get(cacheKey)!;
}

/**
 * Names of other worlds that still need a pack folder (cached across calls). A world needs it when it
 * registers that exact version, or registers the UUID at a version the server has no copy of (this
 * copy is then the closest it has). A world whose pack list cannot be read counts as needing it:
 * deleting must fail safe.
 */
export async function otherWorldsUsing(
  target: Target,
  world: string,
  kind: PackKind,
  pack: { uuid: string; version: Version },
  cache: WorldJsonCache,
  index?: PackIndex,
): Promise<string[]> {
  const others = (await target.listWorlds()).filter((other) => other !== world);
  const users: string[] = [];
  await Promise.all(
    others.map(async (other) => {
      const entries = await cachedWorldJson(target, other, kind, cache);
      if (entries instanceof Error) users.push(`${basename(other)} (its pack list could not be read: ${entries.message})`);
      else if (registrationNeeds(entries, kind, pack, index)) users.push(basename(other));
    }),
  );
  return users.sort();
}

/** Whether a world's entries need this pack copy (see otherWorldsUsing). */
export function registrationNeeds(
  entries: WorldEntry[],
  kind: PackKind,
  pack: { uuid: string; version: Version },
  index?: PackIndex,
): boolean {
  if (registeredKeys(entries).has(packVersionKey(pack.uuid, pack.version))) return true;
  if (!index) return false;
  const versions = entries
    .filter((entry) => uuidKey(entry.pack_id) === uuidKey(pack.uuid))
    .map(entryVersion)
    .filter((version): version is Version => version !== null);
  return versions.length > 0 && versions.every((version) => index.findVersion(pack.uuid, version, kind).length === 0);
}

export async function readLevelInfo(target: Target, world: string): Promise<LevelInfo> {
  const level: LevelInfo = { exists: false, beta: null, gamemode: null, levelName: null, error: null, experiments: [] };
  try {
    const dat = await readLevelDat(target.storage, target.levelDat(world));
    return {
      exists: true,
      beta: betaEnabled(dat),
      gamemode: gamemodeOf(dat),
      levelName: levelNameOf(dat),
      error: null,
      experiments: experimentsOf(dat),
    };
  } catch (error) {
    if (isNotFound(error)) return level;
    return { ...level, exists: true, error: (error as Error).message };
  }
}

const newest = (packs: InstalledPack[]): InstalledPack | undefined => [...packs].sort((a, b) => compareVersions(b.version, a.version))[0];

/** Manifest dependency versions are lists or strings; null when there is nothing to compare. */
const requiredVersion = (version: unknown): Version | null =>
  Array.isArray(version) || typeof version === "string" ? normalizeVersion(version) : null;

function dependencyInfo(pack: InstalledPack | undefined, index: PackIndex, worldPacks: WorldPacks): DependencyInfo[] {
  if (!pack) return [];
  const registered = (uuid: string) => {
    for (const kind of ["bp", "rp"] as const) {
      const entry = worldPacks[kind].find((candidate) => uuidKey(candidate.pack_id) === uuidKey(uuid));
      if (entry) return { kind, version: entryVersion(entry) };
    }
    return null;
  };
  const infos: DependencyInfo[] = pack.moduleDependencies.map((dep) => ({
    uuid: null,
    moduleName: dep.moduleName,
    versionLabel: dep.version,
    name: dep.moduleName,
    state: "module",
    kind: null,
    serverVersion: null,
    tooOld: false,
  }));
  for (const dep of pack.dependencies) {
    const uuid = String(dep.uuid ?? "");
    if (!uuid || uuidKey(uuid) === uuidKey(pack.uuid)) continue;
    const required = requiredVersion(dep.version);
    const copies = index.find(uuid);
    const best = newest(copies);
    const active = registered(uuid);
    const older = (version: Version | null | undefined) => !!required && !!version && compareVersions(version, required) < 0;
    infos.push({
      uuid,
      moduleName: null,
      versionLabel: formatVersion(dep.version as never),
      name: best?.name ?? uuid,
      state: active ? "active" : best ? "inactive" : "missing",
      kind: active?.kind ?? best?.dirKind ?? null,
      serverVersion: !active && best ? best.version : null,
      tooOld: active ? older(active.version) : older(best?.version),
    });
  }
  return infos;
}

/** For each pack (`kind|uuid`), the other worlds that register it and at which version. */
async function usageByOtherWorlds(target: Target, world: string): Promise<Map<string, { world: string; versionLabel: string }[]>> {
  const others = (await target.listWorlds()).filter((other) => other !== world);
  const usage = new Map<string, { world: string; versionLabel: string }[]>();
  const lists = await Promise.all(
    others.flatMap((other) =>
      (["bp", "rp"] as const).map(async (kind) => ({
        other,
        kind,
        entries: await loadWorldJson(target.storage, target.worldJson(other, kind)).catch(() => [] as WorldEntry[]),
      })),
    ),
  );
  for (const { other, kind, entries } of lists) {
    for (const entry of entries) {
      if (!entry.pack_id) continue;
      const key = `${kind}|${uuidKey(entry.pack_id)}`;
      const version = entryVersion(entry);
      usage.set(key, [...(usage.get(key) ?? []), { world: basename(other), versionLabel: version ? formatVersion(version) : "?" }]);
    }
  }
  for (const list of usage.values()) list.sort((a, b) => a.world.localeCompare(b.world));
  return usage;
}

export async function worldStatus(target: Target, world: string, index?: PackIndex): Promise<WorldStatus> {
  const [packIndex, worldPacks, level, usage] = await Promise.all([
    index ?? PackIndex.build(target, world),
    loadWorldPacks(target, world),
    readLevelInfo(target, world),
    usageByOtherWorlds(target, world),
  ]);
  const rows: PackRow[] = [];
  const problems: Problem[] = [...packIndex.problems];
  const seen = new Set<string>();

  const details = (pack: InstalledPack | undefined) => {
    const { description, authors, minEngineVersion, subpacks } = pack?.details ?? NO_DETAILS;
    return { description, authors, minEngineVersion, subpacks };
  };

  for (const kind of ["bp", "rp"] as const) {
    worldPacks[kind].forEach((entry, order) => {
      const uuid = String(entry.pack_id ?? "");
      if (!uuid) {
        problems.push({ kind: "registration", message: `${basename(target.worldJson(world, kind))} contains an entry with no pack_id` });
        return;
      }
      seen.add(`${kind}|${uuidKey(uuid)}`);
      const version = entryVersion(entry);
      const installed = packIndex.find(uuid, kind);
      const exact = version ? installed.filter((pack) => packVersionKey(pack.uuid, pack.version) === packVersionKey(uuid, version)) : [];
      const source = exact[0] ?? installed[0];
      const top = newest(installed);
      rows.push({
        key: version ? packKey(kind, uuid, version) : "",
        kind,
        uuid,
        version: version ?? [],
        versionLabel: formatVersion(version ?? []),
        name: source?.name ?? uuid,
        status: exact.length ? "ok" : installed.length ? "version-mismatch" : "missing",
        registered: true,
        paths: (exact.length ? exact : installed).map((pack) => target.describe(pack.path)),
        path: source?.path ?? null,
        onServerVersions: [...new Set(installed.map(versionLabel))].sort(),
        scope: source?.scope ?? null,
        dependencies: dependencyInfo(source, packIndex, worldPacks),
        order,
        newerOnServer: top && version && compareVersions(top.version, version) > 0 ? top.version : null,
        usedBy: usage.get(`${kind}|${uuidKey(uuid)}`) ?? [],
        ...details(source),
        subpack: kind === "rp" && typeof entry.subpack === "string" ? entry.subpack : null,
      });
    });
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
      path: pack.path,
      onServerVersions: [versionLabel(pack)],
      scope: pack.scope,
      dependencies: dependencyInfo(pack, packIndex, worldPacks),
      order: null,
      newerOnServer: null,
      usedBy: usage.get(`${pack.dirKind}|${uuidKey(pack.uuid)}`) ?? [],
      ...details(pack),
      subpack: null,
    });
  }

  const dependencyProblems = new Set<string>();
  for (const row of rows) {
    if (!row.registered) continue;
    for (const dep of row.dependencies) {
      if (dep.state === "missing") {
        dependencyProblems.add(
          `'${row.name}' depends on UUID ${dep.uuid} (v${dep.versionLabel}) which is not installed - it may not work. Install the matching pack too.`,
        );
      } else if (dep.state === "inactive") {
        dependencyProblems.add(`'${row.name}' needs '${dep.name}', which is on the server but not active in this world`);
      } else if (dep.tooOld) {
        dependencyProblems.add(`'${row.name}' needs '${dep.name}' v${dep.versionLabel} or newer`);
      }
    }
  }
  for (const message of [...dependencyProblems].sort()) problems.push({ kind: "dependency", message });

  rows.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      Number(!a.registered) - Number(!b.registered) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  const [bpDir, rpDir] = await Promise.all([target.installDir(world, "bp"), target.installDir(world, "rp")]);
  return {
    world,
    worldName: basename(world) || target.label,
    isLevelName: !!target.layout.levelName && basename(world) === target.layout.levelName,
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
