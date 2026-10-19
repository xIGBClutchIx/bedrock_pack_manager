/**
 * Turn install sources into pack folders on this computer: archives (nested any number of times),
 * zips with odd extensions, and plain folders holding one or many packs.
 */
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

import type { Dependency, PackKind, Version } from "../../../shared/model";
import { formatVersion } from "../../../shared/model";
import { JUNK_NAMES } from "../../storage/path";
import { info, warn, type JobLog } from "../log";
import {
  ARCHIVE_EXTENSIONS,
  ManifestError,
  NON_PACK_MODULE_TYPES,
  classifyPack,
  getDependencies,
  getPackInfo,
  moduleTypes,
  parseManifest,
  usesBetaApis,
} from "../manifests";

const MAX_NESTED_DEPTH = 6;

export class UnsafeArchiveError extends Error {}

export interface IncomingPack {
  folder: string;
  uuid: string;
  version: Version;
  name: string;
  displayName: string;
  kind: PackKind;
  dependencies: Dependency[];
  sourceName: string;
  usesBeta: boolean;
  /** Pack folders nested inside this one, which must not be uploaded twice. */
  exclude: Set<string>;
}

export interface PreparedSource {
  entry: string;
  packs: IncomingPack[];
  extracted: string | null;
  ok: boolean;
}

export const versionText = (pack: { version: Version }) => formatVersion(pack.version);

// ---- archives ------------------------------------------------------------------------------------

export async function isZipFile(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return false;
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    return header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || header.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  } finally {
    await handle.close();
  }
}

/** Extract a zip, refusing members that would land outside `dest`. */
export async function extractZip(archive: string, dest: string): Promise<void> {
  const root = resolve(dest);
  await mkdir(root, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(archive, { lazyEntries: true, decodeStrings: true, strictFileNames: false }, (error, file) =>
      error || !file ? fail(error ?? new Error("Not a zip")) : ok(file),
    ),
  );
  try {
    await new Promise<void>((done, fail) => {
      // yauzl validates entry names itself; report its path errors as unsafe archives too.
      zip.on("error", (error: Error) =>
        fail(/invalid relative path|absolute path/i.test(error.message) ? new UnsafeArchiveError(error.message) : error),
      );
      zip.on("end", () => done());
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName.replaceAll("\\", "/");
        if (name.startsWith("/") || /^[A-Za-z]:/.test(name))
          return fail(new UnsafeArchiveError(`Archive member '${entry.fileName}' uses an absolute path`));
        const target = resolve(root, name);
        if (target !== root && !target.startsWith(root + sep))
          return fail(new UnsafeArchiveError(`Archive member '${entry.fileName}' would extract outside the target folder`));
        if (name.endsWith("/")) {
          mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(error ?? new Error("Unreadable entry"));
          mkdir(dirname(target), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(target)))
            .then(() => zip.readEntry(), fail);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function walkFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    for (const child of await readdir(dir, { withFileTypes: true })) {
      if (JUNK_NAMES.has(child.name)) continue;
      const path = join(dir, child.name);
      if (child.isDirectory()) await visit(path);
      else out.push(path);
    }
  };
  await visit(folder);
  return out;
}

/** Unpack archives inside archives, repeating until none are left. */
export async function extractNestedArchives(folder: string, log: JobLog): Promise<boolean> {
  let foundAny = false;
  for (let depth = 0; depth < MAX_NESTED_DEPTH; depth++) {
    const nested = (await walkFiles(folder)).filter((path) => ARCHIVE_EXTENSIONS.has(extname(path).toLowerCase()));
    if (!nested.length) break;
    for (const file of nested) {
      foundAny = true;
      info(log, `Found nested archive: ${basename(file)} - extracting`);
      try {
        await extractZip(file, join(dirname(file), `_nested_${basename(file, extname(file))}`));
      } catch (error) {
        if (error instanceof UnsafeArchiveError)
          warn(log, `Nested file ${basename(file)} is unsafe to extract, skipping it (${error.message})`);
        else warn(log, `Nested file ${basename(file)} is not a valid archive, skipping it`);
      }
      await unlink(file).catch(() => undefined);
    }
  }
  return foundAny;
}

/** Folders that contain a manifest.json, outermost first. */
export async function findAllPacks(folder: string): Promise<string[]> {
  const packs: string[] = [];
  const visit = async (dir: string) => {
    const children = (await readdir(dir, { withFileTypes: true })).filter((child) => !JUNK_NAMES.has(child.name));
    if (children.some((child) => child.isFile() && child.name.toLowerCase() === "manifest.json")) packs.push(dir);
    for (const child of children.filter((c) => c.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      await visit(join(dir, child.name));
  };
  await visit(folder);
  return packs;
}

async function manifestFile(folder: string): Promise<string | null> {
  const child = (await readdir(folder)).find((name) => name.toLowerCase() === "manifest.json");
  return child ? join(folder, child) : null;
}

// ---- naming --------------------------------------------------------------------------------------

const GENERIC_NAMES = new Set(["", "addon", "addonname", "behaviorpack", "name", "pack", "packname", "resourcepack", "unknown"]);
const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function cleanSourceName(source: string): string {
  return basename(source, extname(source))
    .replace(/\s*[[(](?:bp|rp|beh|res|bh|rs)[\])]\s*/gi, " ")
    .replace(/\s+v\d+(?:\.\d+)*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-_]+|[\s\-_]+$/g, "");
}

/** Prefer manifest names, but fall back to cleaner source names for generic pack titles. */
export function effectivePackName(name: string, folder: string, sourceName = ""): string {
  if (!GENERIC_NAMES.has(normalizeName(name))) return name;
  const cleaned = sourceName ? cleanSourceName(sourceName) : "";
  return cleaned || basename(folder);
}

/** A readable folder name that does not clash with `taken` (lower-cased names). */
export function packFolderName(displayName: string, folder: string, kind: PackKind, taken: Set<string>): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9 \-_]/g, "").trim();
  let name = clean(displayName) || clean(basename(folder)) || "pack";
  if (!/-(BP|RP|BH|RS|BEH|RES)$/i.test(name)) name += kind === "bp" ? "-BP" : "-RP";
  let candidate = name;
  for (let counter = 2; taken.has(candidate.toLowerCase()); counter++) candidate = `${name}_${counter}`;
  return candidate;
}

// ---- reading packs -------------------------------------------------------------------------------

export async function readIncomingPack(
  folder: string,
  sourceName: string,
  log: JobLog,
  betaEnabled: boolean | null = null,
): Promise<IncomingPack | null> {
  const file = await manifestFile(folder);
  if (!file) {
    warn(log, `Folder '${basename(folder)}' has no manifest.json - not a valid pack`);
    return null;
  }
  let manifest;
  try {
    manifest = parseManifest(await readFile(file));
  } catch (error) {
    if (error instanceof ManifestError) {
      warn(log, `Corrupt manifest.json in '${basename(folder)}' from ${sourceName}: ${error.message}`);
      return null;
    }
    throw error;
  }

  const kind = classifyPack(manifest);
  const { uuid, version, name } = getPackInfo(manifest);
  const displayName = effectivePackName(name, folder, sourceName);
  if (!kind) {
    const types = moduleTypes(manifest);
    if (types.some((type) => NON_PACK_MODULE_TYPES.has(type)))
      warn(log, `'${displayName}' is a ${types.join(", ")}, not a behavior or resource pack - skipping`);
    else warn(log, `Cannot determine type for '${displayName}' (module types: ${JSON.stringify(types)}) - skipping`);
    return null;
  }
  if (!uuid) {
    warn(log, `Pack '${displayName}' has no UUID in manifest - skipping (broken pack?)`);
    return null;
  }
  const formatVersionValue = manifest.format_version;
  if (formatVersionValue === undefined) warn(log, `Pack '${displayName}' is missing format_version - may be an old or broken pack`);
  else if (typeof formatVersionValue === "number" && formatVersionValue < 2)
    warn(log, `Pack '${displayName}' uses format_version ${formatVersionValue} (old format, may have issues)`);

  const usesBeta = usesBetaApis(manifest);
  if (usesBeta && betaEnabled !== true) warn(log, `Pack '${displayName}' uses beta API versions - enable Beta APIs for this world`);

  return {
    folder,
    uuid,
    version,
    name,
    displayName,
    kind,
    dependencies: getDependencies(manifest),
    sourceName,
    usesBeta,
    exclude: new Set(),
  };
}

/** Unpack one install source locally and read every pack inside it. */
export async function prepareSource(
  entry: string,
  scratchDir: string,
  log: JobLog,
  betaEnabled: boolean | null = null,
): Promise<PreparedSource> {
  const name = basename(entry);
  log.log("section", name);
  const source: PreparedSource = { entry, packs: [], extracted: null, ok: true };
  const info_ = await stat(entry).catch(() => null);
  let searchRoot: string;

  if (info_?.isFile()) {
    const extension = extname(entry).toLowerCase();
    if (!ARCHIVE_EXTENSIONS.has(extension) && !(await isZipFile(entry))) {
      warn(log, `Unknown file type '${extension}' for '${name}' - only .mcaddon, .mcpack, .zip (or zip files) are supported`);
      return { ...source, ok: false };
    }
    if (!ARCHIVE_EXTENSIONS.has(extension)) info(log, `'${name}' is a zip file with an unusual extension - treating it as an archive`);
    source.extracted = join(scratchDir, `_extracted_${basename(entry, extname(entry))}_${Date.now().toString(36)}`);
    try {
      await extractZip(entry, source.extracted);
    } catch (error) {
      if (error instanceof UnsafeArchiveError) warn(log, `'${name}' contains unsafe archive paths - skipping it (${error.message})`);
      else warn(log, `'${name}' is not a valid zip archive - the file may be corrupt`);
      await rm(source.extracted, { recursive: true, force: true });
      source.extracted = null;
      return { ...source, ok: false };
    }
    await extractNestedArchives(source.extracted, log);
    searchRoot = source.extracted;
  } else if (info_?.isDirectory()) {
    await extractNestedArchives(entry, log);
    searchRoot = entry;
  } else {
    warn(log, `'${name}' is not a file or folder - skipping`);
    return { ...source, ok: false };
  }

  const folders = await findAllPacks(searchRoot);
  if (!folders.length) {
    warn(
      log,
      `No manifest.json found anywhere inside '${name}' - ${info_.isFile() ? "archive may not be a valid Minecraft pack" : "not a valid pack or addon"}`,
    );
    return { ...source, ok: false };
  }
  if (folders.length > 1 || folders[0] !== searchRoot) info(log, `Found ${folders.length} pack(s) inside`);
  const extension = info_.isFile() ? extname(entry).toLowerCase() : "";
  if (extension === ".mcpack" && folders.length > 1)
    warn(log, `'${name}' is a .mcpack but contains ${folders.length} packs - unusual, processing all`);

  for (const folder of folders) {
    const pack = await readIncomingPack(folder, name, log, betaEnabled);
    if (!pack) {
      source.ok = false;
      continue;
    }
    for (const other of folders) {
      if (other !== folder && !relative(folder, other).startsWith("..")) pack.exclude.add(other);
    }
    source.packs.push(pack);
  }
  if (extension === ".mcaddon" && source.packs.length === 1) {
    warn(
      log,
      `'${name}' is an .mcaddon but only contains 1 pack - it might be missing its ${source.packs[0]!.kind === "bp" ? "Resource Pack" : "Behavior Pack"}`,
    );
  }
  return source;
}

/** Count files a pack upload will send (for progress). */
export async function countUploadFiles(folder: string, exclude: Set<string>): Promise<number> {
  let count = 0;
  const visit = async (dir: string) => {
    for (const child of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, child.name);
      if (JUNK_NAMES.has(child.name) || exclude.has(path)) continue;
      if (child.isDirectory()) await visit(path);
      else count++;
    }
  };
  await visit(folder);
  return count;
}
