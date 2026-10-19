/**
 * Where worlds and packs live on a server, detected leniently because real servers vary.
 *
 * Recognised shapes, relative to the folder the user connected to:
 * - a Bedrock Dedicated Server root (worlds/, behavior_packs/, resource_packs/, server.properties)
 * - the same root one or two folders down (common on hosting panels, e.g. /home/container)
 * - the worlds/ folder itself, with pack folders beside it
 * - a single world folder (has level.dat), using that world's own pack folders
 * - the classic local run/ layout
 */
import type { InstallScope, LayoutInfo, LayoutOverrides, PackKind, PackScope } from "../../shared/model";
import { isNotFound } from "../storage/errors";
import { JUNK_NAMES, basename, join } from "../storage/path";
import type { Entry, Storage } from "../storage/storage";

export const WORLD_JSON_NAMES: Record<PackKind, string> = { bp: "world_behavior_packs.json", rp: "world_resource_packs.json" };
const PACK_DIR_NAMES: Record<PackKind, string> = { bp: "behavior_packs", rp: "resource_packs" };
const DEV_PACK_DIR_NAMES: Record<PackKind, string> = { bp: "development_behavior_packs", rp: "development_resource_packs" };
const SERVER_MARKERS = [
  "server.properties",
  "bedrock_server",
  "bedrock_server.exe",
  "worlds",
  "allowlist.json",
  "permissions.json",
  "behavior_packs",
  "resource_packs",
];
const WORLD_MARKERS = ["level.dat", "world_behavior_packs.json", "world_resource_packs.json", "levelname.txt"];

export interface PackDir {
  path: string;
  kind: PackKind;
  scope: PackScope;
}

export interface ServerLayout {
  serverRoot: string;
  worldsDir: string | null;
  singleWorld: string | null;
  bpDir: string | null;
  rpDir: string | null;
  devBpDir: string | null;
  devRpDir: string | null;
  levelName: string | null;
  notes: string[];
}

type Names = Map<string, Entry>;

async function names(storage: Storage, path: string): Promise<Names> {
  try {
    return new Map((await storage.listDir(path)).map((entry) => [entry.name.toLowerCase(), entry]));
  } catch (error) {
    if (isNotFound(error)) return new Map();
    throw error;
  }
}

const childDir = (found: Names, base: string, name: string) => {
  const entry = found.get(name.toLowerCase());
  return entry?.isDir ? join(base, entry.name) : null;
};
const looksLikeServer = (found: Names) => SERVER_MARKERS.some((marker) => found.has(marker));
const looksLikeWorld = (found: Names) => WORLD_MARKERS.some((marker) => found.has(marker)) || found.get("db")?.isDir === true;
const childDirs = (found: Names, base: string) =>
  [...found.values()]
    .filter((entry) => entry.isDir && !JUNK_NAMES.has(entry.name) && !entry.name.startsWith("."))
    .map((entry) => join(base, entry.name))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

export function parseServerProperties(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

/** Breadth-first search a couple of levels down for something that looks like a server. */
async function findServerRoot(storage: Storage, start: string, notes: string[], depth = 2): Promise<[string, Names]> {
  const found = await names(storage, start);
  if (looksLikeServer(found) || looksLikeWorld(found)) return [start, found];
  let frontier = childDirs(found, start).slice(0, 40);
  for (let level = 0; level < depth && frontier.length; level++) {
    const listings = await Promise.all(frontier.map((candidate) => names(storage, candidate)));
    const hit = listings.findIndex(looksLikeServer);
    if (hit >= 0) {
      notes.push(`Found the server inside '${frontier[hit]}'`);
      return [frontier[hit]!, listings[hit]!];
    }
    frontier = listings.flatMap((listing, index) => childDirs(listing, frontier[index]!)).slice(0, 30);
  }
  return [start, found];
}

export async function detectLayout(storage: Storage, overrides: Partial<LayoutOverrides> = {}): Promise<ServerLayout> {
  const notes: string[] = [];
  const [root, found] = overrides.serverRoot
    ? [join(overrides.serverRoot), await names(storage, overrides.serverRoot)]
    : await findServerRoot(storage, "", notes);

  const layout: ServerLayout = {
    serverRoot: root,
    worldsDir: null,
    singleWorld: null,
    bpDir: null,
    rpDir: null,
    devBpDir: null,
    devRpDir: null,
    levelName: null,
    notes,
  };

  const properties = found.get("server.properties");
  if (properties && !properties.isDir) {
    try {
      layout.levelName = parseServerProperties(await storage.readText(join(root, properties.name)))["level-name"] || null;
    } catch {
      // unreadable server.properties: no default world, nothing else depends on it
    }
  }

  const foundWorlds = childDir(found, root, "worlds");
  if (overrides.worldsDir) {
    layout.worldsDir = join(overrides.worldsDir);
  } else if (foundWorlds) {
    layout.worldsDir = foundWorlds;
  } else if (looksLikeWorld(found)) {
    layout.singleWorld = root;
    notes.push("The selected folder is a single world; packs go into its own behavior_packs/resource_packs folders");
  } else {
    const subfolders = childDirs(found, root).slice(0, 40);
    const subNames = await Promise.all(subfolders.map((folder) => names(storage, folder)));
    if (subNames.some(looksLikeWorld)) {
      layout.worldsDir = root;
      notes.push("The selected folder looks like a worlds folder");
    } else {
      layout.worldsDir = join(root, "worlds");
      notes.push("No worlds folder found yet");
    }
  }

  if (layout.singleWorld === null && layout.worldsDir === root && !overrides.worldsDir) {
    // Pointed at worlds/: the pack folders sit beside it.
    const siblingRoot = join(root, "..");
    const siblings = await names(storage, siblingRoot);
    layout.bpDir = childDir(siblings, siblingRoot, PACK_DIR_NAMES.bp);
    layout.rpDir = childDir(siblings, siblingRoot, PACK_DIR_NAMES.rp);
    layout.devBpDir = childDir(siblings, siblingRoot, DEV_PACK_DIR_NAMES.bp);
    layout.devRpDir = childDir(siblings, siblingRoot, DEV_PACK_DIR_NAMES.rp);
  } else if (layout.singleWorld === null) {
    layout.bpDir = childDir(found, root, PACK_DIR_NAMES.bp) ?? join(root, PACK_DIR_NAMES.bp);
    layout.rpDir = childDir(found, root, PACK_DIR_NAMES.rp) ?? join(root, PACK_DIR_NAMES.rp);
    layout.devBpDir = childDir(found, root, DEV_PACK_DIR_NAMES.bp);
    layout.devRpDir = childDir(found, root, DEV_PACK_DIR_NAMES.rp);
  }
  if (overrides.bpDir) layout.bpDir = join(overrides.bpDir);
  if (overrides.rpDir) layout.rpDir = join(overrides.rpDir);
  return layout;
}

/** A storage plus its layout: what every command operates on. */
export class Target {
  constructor(
    readonly storage: Storage,
    readonly layout: ServerLayout,
    readonly packScope: InstallScope = "shared",
  ) {}

  static async open(storage: Storage, overrides: Partial<LayoutOverrides> = {}): Promise<Target> {
    return new Target(storage, await detectLayout(storage, overrides), overrides.packScope ?? "shared");
  }

  get label(): string {
    return this.storage.label;
  }

  describe(path: string): string {
    return this.storage.describe(path);
  }

  worldJson(world: string, kind: PackKind): string {
    return join(world, WORLD_JSON_NAMES[kind]);
  }

  levelDat(world: string): string {
    return join(world, "level.dat");
  }

  sharedDir(kind: PackKind): string | null {
    return kind === "bp" ? this.layout.bpDir : this.layout.rpDir;
  }

  devDir(kind: PackKind): string | null {
    return kind === "bp" ? this.layout.devBpDir : this.layout.devRpDir;
  }

  async worldPackDir(world: string, kind: PackKind): Promise<string> {
    return (await this.storage.findChild(world, PACK_DIR_NAMES[kind], "dir")) ?? join(world, PACK_DIR_NAMES[kind]);
  }

  /** Where new packs are uploaded, honouring the install scope and the layout. */
  async installDir(world: string, kind: PackKind): Promise<string> {
    const shared = this.sharedDir(kind);
    if (this.packScope === "world" || shared === null) return this.worldPackDir(world, kind);
    return shared;
  }

  /** Every folder that may hold packs relevant to `world`. */
  async packDirs(world: string | null): Promise<PackDir[]> {
    const dirs: PackDir[] = [];
    for (const kind of ["bp", "rp"] as const) {
      const shared = this.sharedDir(kind);
      if (shared !== null) dirs.push({ path: shared, kind, scope: "shared" });
      const dev = this.devDir(kind);
      if (dev !== null) dirs.push({ path: dev, kind, scope: "dev" });
      if (world !== null) {
        const local = await this.storage.findChild(world, PACK_DIR_NAMES[kind], "dir");
        if (local) dirs.push({ path: local, kind, scope: "world" });
      }
    }
    return dirs;
  }

  async listWorlds(): Promise<string[]> {
    if (this.layout.singleWorld !== null) return [this.layout.singleWorld];
    if (this.layout.worldsDir === null) return [];
    try {
      const entries = await this.storage.listDir(this.layout.worldsDir);
      return entries
        .filter((entry) => entry.isDir && !entry.name.startsWith(".") && !JUNK_NAMES.has(entry.name))
        .map((entry) => join(this.layout.worldsDir!, entry.name));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async findWorld(name: string): Promise<string | null> {
    const worlds = await this.listWorlds();
    return (
      worlds.find((world) => basename(world) === name) ??
      worlds.find((world) => basename(world).toLowerCase() === name.toLowerCase()) ??
      null
    );
  }

  async defaultWorld(worlds?: string[]): Promise<string | null> {
    const all = worlds ?? (await this.listWorlds());
    if (all.length === 1) return all[0]!;
    if (this.layout.levelName) return all.find((world) => basename(world) === this.layout.levelName) ?? null;
    return null;
  }

  /** The layout with full server paths, for people to read. */
  layoutInfo(): LayoutInfo {
    const show = (path: string | null) => (path === null ? null : this.describe(path));
    return {
      serverRoot: this.describe(this.layout.serverRoot),
      worldsDir: show(this.layout.worldsDir),
      singleWorld: show(this.layout.singleWorld),
      bpDir: show(this.layout.bpDir),
      rpDir: show(this.layout.rpDir),
      devBpDir: show(this.layout.devBpDir),
      devRpDir: show(this.layout.devRpDir),
      levelName: this.layout.levelName,
      packScope: this.packScope,
      notes: [...this.layout.notes],
    };
  }
}
