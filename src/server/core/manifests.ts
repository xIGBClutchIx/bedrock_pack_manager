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

/** Manifests use [1, 0, 0]; some newer ones use "1.0.0". World JSONs want the list. */
export function normalizeVersion(version: unknown): Version {
  if (Array.isArray(version)) return version.map((part) => (typeof part === "number" ? part : String(part)));
  if (typeof version === "string") {
    const parts = version
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    while (parts.length < 3) parts.push(0);
    return parts;
  }
  if (typeof version === "number") return [version, 0, 0];
  return [0, 0, 0];
}

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

/** Pack-to-pack dependencies (script modules such as @minecraft/server are not packs). */
export function getDependencies(manifest: Manifest): Dependency[] {
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return dependencies.map(asRecord).filter((dep) => typeof dep.uuid === "string" && !("module_name" in dep)) as Dependency[];
}

export function usesBetaApis(manifest: Manifest): boolean {
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return dependencies.some((dep) => /beta/i.test(String(asRecord(dep).version ?? "")));
}

export const uuidKey = (uuid: unknown): string =>
  String(uuid ?? "")
    .trim()
    .toLowerCase();

export function versionsEqual(a: Version | unknown, b: Version | unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    return String(x).localeCompare(String(y));
  }
  return 0;
}
