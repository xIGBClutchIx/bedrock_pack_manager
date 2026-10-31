/** Manifest parsing and pack classification, tolerant of the JSON people actually ship. */
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import type { Dependency, PackKind, Version } from "../../shared/model";
import { stripBom } from "../storage/storage";

export const BP_MODULE_TYPES = new Set(["data", "script", "client_data", "javascript"]);
export const RP_MODULE_TYPES = new Set(["resources"]);
export const NON_PACK_MODULE_TYPES = new Set(["world_template", "skin_pack"]);
export const ARCHIVE_EXTENSIONS = new Set([".mcaddon", ".mcpack", ".zip"]);

export class ManifestError extends Error {}

export type Manifest = Record<string, unknown>;

/** Parse JSON with comments, trailing commas and a BOM. Throws ManifestError. */
export function parseJsonLenient(data: Buffer | string): unknown {
  const text = stripBom(typeof data === "string" ? data : data.toString("utf8"));
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  if (errors.length) {
    const first = errors[0]!;
    throw new ManifestError(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
}

export function parseManifest(data: Buffer | string): Manifest {
  const value = parseJsonLenient(data);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManifestError("manifest.json is not a JSON object");
  return value as Manifest;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function moduleTypes(manifest: Manifest): string[] {
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  return modules.map((module) => String(asRecord(module).type ?? "").toLowerCase()).filter(Boolean);
}

/** Map manifest module types to behavior ("bp") or resource ("rp") packs. */
export function classifyPack(manifest: Manifest): PackKind | null {
  const types = moduleTypes(manifest);
  if (types.some((type) => BP_MODULE_TYPES.has(type))) return "bp";
  if (types.some((type) => RP_MODULE_TYPES.has(type))) return "rp";
  return null;
}

const versionPart = (part: unknown): number | string =>
  typeof part === "number" ? part : /^\d+$/.test(String(part)) ? Number(part) : String(part);

/**
 * Manifests use [1, 0, 0]; some newer ones use "1.0.0" or semver strings such as "1.0.0-beta.2". The result
 * always has at least three parts; a prerelease follows them as one text part ([1, 0, 0, "beta.2"]), so that
 * compareVersions puts 1.0.0-beta.2 before 1.0.0. Build metadata ("+abc") is ignored, as in semver.
 * World JSONs want only the first three parts: see registrationVersion.
 */
export function normalizeVersion(version: unknown): Version {
  // ["1", "0", "0"] is the same version as [1, 0, 0].
  if (Array.isArray(version)) {
    const parts = version.map(versionPart);
    while (parts.length < 3) parts.push(0);
    return parts;
  }
  if (typeof version === "string") {
    const text = version.trim().split("+")[0]!;
    const dash = text.indexOf("-");
    const core = (dash < 0 ? text : text.slice(0, dash)).split(".").map(versionPart);
    while (core.length < 3) core.push(0);
    if (dash < 0) return core;
    // The whole prerelease stays one text part: text sorts before numbers, so it comes before the release,
    // and compareVersions orders two prereleases by semver rules (1.0.0-2 before 1.0.0-10).
    const pre = text
      .slice(dash + 1)
      .split(".")
      .filter(Boolean)
      .join(".");
    return pre ? [...core, pre] : core;
  }
  if (typeof version === "number") return [version, 0, 0];
  return [0, 0, 0];
}

/** The version as world JSONs list it: the first three parts, without any prerelease. */
export const registrationVersion = (version: unknown): Version => normalizeVersion(version).slice(0, 3);

export const stripFormatting = (text: string): string => text.replace(/§./g, "");

export interface PackInfo {
  uuid: string;
  version: Version;
  name: string;
}

export function getPackInfo(manifest: Manifest): PackInfo {
  const header = asRecord(manifest.header);
  return {
    uuid: String(header.uuid ?? "").trim(),
    version: normalizeVersion(header.version ?? [0, 0, 0]),
    name: stripFormatting(String(header.name ?? "unknown")),
  };
}

/**
 * Script modules that older manifests (before `module_name`) depended on by UUID. They ship with the
 * game, so they are never "missing packs".
 */
export const LEGACY_SCRIPT_MODULE_UUIDS = new Set([
  "b26a4d4c-afdf-4690-88f8-931846312678", // mojang-minecraft
  "6f4b6893-1bb6-42fd-b458-7fa3d0c89616", // mojang-gametest
]);

/** Pack-to-pack dependencies (script modules such as @minecraft/server are not packs). */
export function getDependencies(manifest: Manifest): Dependency[] {
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return dependencies
    .map(asRecord)
    .filter(
      (dep) => typeof dep.uuid === "string" && !("module_name" in dep) && !LEGACY_SCRIPT_MODULE_UUIDS.has(uuidKey(dep.uuid)),
    ) as Dependency[];
}

/** Script modules (`module_name` dependencies such as @minecraft/server) a pack needs from the game. */
export function getModuleDependencies(manifest: Manifest): { moduleName: string; version: string }[] {
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return dependencies
    .map(asRecord)
    .filter((dep) => typeof dep.module_name === "string")
    .map((dep) => ({ moduleName: String(dep.module_name), version: formatAnyVersion(dep.version) }));
}

const formatAnyVersion = (version: unknown) => (Array.isArray(version) ? version.join(".") : String(version ?? "?"));

export interface PackDetails {
  description: string;
  authors: string[];
  minEngineVersion: string | null;
  subpacks: { folder: string; name: string }[];
}

/** What the UI shows about a pack beyond its name and version. */
export function getPackDetails(manifest: Manifest): PackDetails {
  const header = asRecord(manifest.header);
  const metadata = asRecord(manifest.metadata);
  const authors = Array.isArray(metadata.authors)
    ? metadata.authors.map(String)
    : typeof metadata.authors === "string"
      ? [metadata.authors]
      : [];
  const subpacks = (Array.isArray(manifest.subpacks) ? manifest.subpacks : [])
    .map(asRecord)
    .filter((subpack) => typeof subpack.folder_name === "string")
    .map((subpack) => ({ folder: String(subpack.folder_name), name: stripFormatting(String(subpack.name ?? subpack.folder_name)) }));
  return {
    description: stripFormatting(String(header.description ?? "")).trim(),
    authors: authors.map(stripFormatting),
    minEngineVersion: header.min_engine_version === undefined ? null : formatAnyVersion(header.min_engine_version),
    subpacks,
  };
}

export function usesBetaApis(manifest: Manifest): boolean {
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return dependencies.some((dep) => /beta/i.test(String(asRecord(dep).version ?? "")));
}

export const uuidKey = (uuid: unknown): string =>
  String(uuid ?? "")
    .trim()
    .toLowerCase();

/** Exact equality, prerelease included: 1.0.0-beta is not 1.0.0. */
export function versionsEqual(a: Version | unknown, b: Version | unknown): boolean {
  return JSON.stringify(normalizeVersion(a)) === JSON.stringify(normalizeVersion(b));
}

/** Whether a world entry at version `a` points at a pack of version `b` (world JSONs only hold three numbers). */
export function registrationMatches(a: Version | unknown, b: Version | unknown): boolean {
  return JSON.stringify(registrationVersion(a)) === JSON.stringify(registrationVersion(b));
}

/** Sort key where numbers compare numerically and text parts sort before them. */
export function compareVersions(a: Version, b: Version): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return 1;
    if (typeof y === "number") return -1;
    return comparePrerelease(String(x), String(y));
  }
  return 0;
}

/** Semver prerelease order: dot-separated identifiers, numbers numerically and before text, shorter first. */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return Number(x) - Number(y);
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
