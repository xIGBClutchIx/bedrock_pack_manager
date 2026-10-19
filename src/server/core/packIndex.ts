/**
 * One scan of every pack folder on the server, reused for a whole operation. Manifests are
 * fetched in parallel; the index is then updated in memory as commands upload or delete.
 */
import type { Dependency, PackKind, PackScope, Problem, Version } from "../../shared/model";
import { formatVersion } from "../../shared/model";
import { NotFoundError, isNotFound } from "../storage/errors";
import { JUNK_NAMES, basename, join } from "../storage/path";
import type { Entry } from "../storage/storage";
import { PACK_CONTENT_DIRS, isBuiltinFolder, isTranslationKey } from "./builtins";
import type { PackDir, Target } from "./layout";
import { ManifestError, classifyPack, getDependencies, getPackInfo, parseManifest, uuidKey } from "./manifests";
import { packVersionKey } from "./worlds";

export interface InstalledPack {
  uuid: string;
  version: Version;
  name: string;
  /** What the manifest says it is. */
  kind: PackKind | null;
  /** Which kind of folder it sits in. */
  dirKind: PackKind;
  scope: PackScope;
  path: string;
  packDir: string;
  dependencies: Dependency[];
  nested: boolean;
  builtin: boolean;
}

export const folderOf = (pack: InstalledPack): string => basename(pack.path);
export const versionLabel = (pack: { version: Version }): string => formatVersion(pack.version);

function looksLikePackContent(children: Entry[]): boolean {
  const real = children.filter((child) => !JUNK_NAMES.has(child.name));
  if (!real.some((child) => child.isDir)) return true; // empty or only files: a broken pack
  return real.some((child) => !child.isDir || PACK_CONTENT_DIRS.has(child.name.toLowerCase()));
}

export class PackIndex {
  packs: InstalledPack[] = [];
  problems: Problem[] = [];
  /** Remarks that need no action, e.g. folders used to store old packs. */
  notes: string[] = [];
  scannedDirs: PackDir[] = [];

  private constructor(private readonly target: Target) {}

  static async build(target: Target, world: string | null, packDirs?: PackDir[]): Promise<PackIndex> {
    const index = new PackIndex(target);
    const dirs = packDirs ?? (await target.packDirs(world));
    // Scan every pack folder at once; each scan fetches its manifests in parallel too.
    const scans = await Promise.all(dirs.map((dir) => index.scanDir(dir)));
    for (const scan of scans) {
      if (!scan) continue;
      index.scannedDirs.push(scan.dir);
      index.packs.push(...scan.packs);
    }
    // Scans run concurrently; keep reports in a stable order.
    index.problems.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.message.localeCompare(b.message));
    index.notes.sort();
    index.flagDuplicates();
    return index;
  }

  private async scanDir(dir: PackDir): Promise<{ dir: PackDir; packs: InstalledPack[] } | null> {
    const storage = this.target.storage;
    let entries: Entry[];
    try {
      entries = await storage.listDir(dir.path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const folders = entries
      .filter((entry) => entry.isDir && !JUNK_NAMES.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => join(dir.path, entry.name));
    const manifests = await storage.readMany(folders.map((folder) => join(folder, "manifest.json")));
    const packs: InstalledPack[] = [];

    await Promise.all(
      folders.map(async (folder) => {
        const { pack, missing } = await this.readPack(dir, folder, { prefetched: manifests.get(join(folder, "manifest.json")) });
        if (pack) return void packs.push(pack);
        if (missing) await this.inspectWrapper(dir, folder, packs);
      }),
    );
    packs.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    return { dir, packs };
  }

  /** A folder without manifest.json: odd casing, a wrapper around a pack, storage, or a broken pack. */
  private async inspectWrapper(dir: PackDir, folder: string, packs: InstalledPack[]): Promise<void> {
    let children: Entry[];
    try {
      children = await this.target.storage.listDir(folder);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (children.some((child) => !child.isDir && child.name.toLowerCase() === "manifest.json")) {
      const { pack } = await this.readPack(dir, folder, { findManifest: true });
      if (pack) packs.push(pack);
      return;
    }
    const subfolders = children.filter((child) => child.isDir && !JUNK_NAMES.has(child.name)).map((child) => join(folder, child.name));
    const nested = (await Promise.all(subfolders.map((sub) => this.readPack(dir, sub, { findManifest: true, report: false })))).flatMap(
      ({ pack }) => (pack ? [pack] : []),
    );

    if (nested.length === 1) {
      // One pack inside an extra folder: the classic extraction mistake.
      const pack = { ...nested[0]!, nested: true };
      packs.push(pack);
      this.problems.push({
        kind: "nested",
        path: pack.path,
        fixable: true,
        message: `${this.target.describe(pack.path)} is nested one folder too deep - the server will not load it. Move it up into ${this.target.describe(dir.path)}`,
      });
    } else if (nested.length > 1) {
      // Several packs in a subfolder is somebody's storage (e.g. "old/"); the server ignores it and so do we.
      this.notes.push(
        `${this.target.describe(folder)} holds ${nested.length} packs the server does not load (treated as a storage folder)`,
      );
    } else if (looksLikePackContent(children)) {
      this.problems.push({
        kind: "partial",
        path: folder,
        message: `${this.target.describe(folder)} has no manifest.json - not a valid pack (partial upload or leftover folder?)`,
      });
    } else {
      this.notes.push(`${this.target.describe(folder)} is not a pack (no manifest.json) and is ignored`);
    }
  }

  private async readPack(
    dir: PackDir,
    folder: string,
    options: { prefetched?: Buffer | Error; findManifest?: boolean; report?: boolean } = {},
  ): Promise<{ pack: InstalledPack | null; missing: boolean }> {
    const storage = this.target.storage;
    const report = options.report ?? true;
    const manifestPath = options.findManifest ? await storage.findChild(folder, "manifest.json", "file") : join(folder, "manifest.json");
    if (!manifestPath) return { pack: null, missing: true };
    let manifest;
    try {
      const data = options.prefetched ?? (await storage.readFile(manifestPath));
      if (data instanceof Error) throw data;
      manifest = parseManifest(data);
    } catch (error) {
      if (error instanceof NotFoundError) return { pack: null, missing: true };
      if (error instanceof ManifestError) {
        if (report)
          this.problems.push({
            kind: "broken",
            path: folder,
            message: `${this.target.describe(manifestPath)} is not valid JSON (${error.message})`,
          });
        return { pack: null, missing: false };
      }
      throw error;
    }

    const info = getPackInfo(manifest);
    if (!info.uuid) {
      if (report)
        this.problems.push({
          kind: "broken",
          path: folder,
          message: `${this.target.describe(folder)} has no UUID in its manifest - skipping it`,
        });
      return { pack: null, missing: false };
    }
    const builtin = dir.scope === "shared" && join(dir.path, basename(folder)) === folder && isBuiltinFolder(basename(folder));
    const kind = classifyPack(manifest);
    if (report && !builtin && kind && kind !== dir.kind) {
      const expected = kind === "bp" ? "behavior_packs" : "resource_packs";
      this.problems.push({
        kind: "misplaced",
        path: folder,
        message: `${this.target.describe(folder)} is a ${kind === "bp" ? "behavior" : "resource"} pack but sits in ${this.target.describe(dir.path)} - move it to ${expected}`,
      });
    }
    return {
      pack: {
        uuid: info.uuid,
        version: info.version,
        name: isTranslationKey(info.name) ? basename(folder) : info.name,
        kind,
        dirKind: dir.kind,
        scope: dir.scope,
        path: folder,
        packDir: dir.path,
        dependencies: getDependencies(manifest),
        nested: false,
        builtin,
      },
      missing: false,
    };
  }

  private flagDuplicates(): void {
    const byKey = new Map<string, InstalledPack[]>();
    for (const pack of this.packs) {
      if (pack.builtin) continue;
      const key = packVersionKey(pack.uuid, pack.version);
      byKey.set(key, [...(byKey.get(key) ?? []), pack]);
    }
    for (const copies of byKey.values()) {
      if (copies.length > 1) {
        const first = copies[0]!;
        this.problems.push({
          kind: "duplicate",
          path: first.path,
          message: `'${first.name}' v${versionLabel(first)} is installed ${copies.length} times (${copies.map(folderOf).join(", ")})`,
        });
      }
    }
  }

  // ---- queries ------------------------------------------------------------------------------------

  find(uuid: string, kind?: PackKind): InstalledPack[] {
    const wanted = uuidKey(uuid);
    return this.packs
      .filter((pack) => uuidKey(pack.uuid) === wanted && (!kind || pack.dirKind === kind))
      .sort((a, b) => folderOf(a).toLowerCase().localeCompare(folderOf(b).toLowerCase()));
  }

  findVersion(uuid: string, version: Version, kind?: PackKind): InstalledPack[] {
    return this.find(uuid, kind).filter((pack) => JSON.stringify(pack.version) === JSON.stringify(version));
  }

  ofKind(kind: PackKind): InstalledPack[] {
    return this.packs.filter((pack) => pack.dirKind === kind);
  }

  uuids(): Set<string> {
    return new Set(this.packs.map((pack) => uuidKey(pack.uuid)));
  }

  add(pack: InstalledPack): void {
    this.packs.push(pack);
  }

  remove(path: string): void {
    this.packs = this.packs.filter((pack) => pack.path !== path);
    this.problems = this.problems.filter((problem) => problem.path !== path);
  }
}
