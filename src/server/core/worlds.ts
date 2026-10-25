/** World pack registration files: world_behavior_packs.json and world_resource_packs.json. */
import type { Version } from "../../shared/model";
import { isNotFound } from "../storage/errors";
import type { Storage } from "../storage/storage";
import { ManifestError, normalizeVersion, parseJsonLenient, uuidKey, versionsEqual } from "./manifests";

export interface WorldEntry {
  pack_id: string;
  version: Version;
  [key: string]: unknown;
}

export class WorldJsonError extends Error {}

export async function loadWorldJson(storage: Storage, path: string): Promise<WorldEntry[]> {
  let raw: Buffer;
  try {
    raw = await storage.readFile(path);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  if (!raw.toString("utf8").trim()) return [];
  let data: unknown;
  try {
    data = parseJsonLenient(raw);
  } catch (error) {
    if (error instanceof ManifestError) throw new WorldJsonError(`Corrupt world pack JSON: ${storage.describe(path)} (${error.message})`);
    throw error;
  }
  if (!Array.isArray(data)) throw new WorldJsonError(`World pack JSON is not a list: ${storage.describe(path)}`);
  return data.filter((entry): entry is WorldEntry => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

export async function saveWorldJson(storage: Storage, path: string, entries: WorldEntry[]): Promise<void> {
  await storage.writeText(path, `${JSON.stringify(entries, null, 2)}\n`);
}

/** Add a pack or update its version. */
export function upsertEntry(entries: WorldEntry[], uuid: string, version: Version): "added" | "updated" | "unchanged" {
  const existing = entries.find((entry) => uuidKey(entry.pack_id) === uuidKey(uuid));
  if (existing) {
    if (versionsEqual(existing.version, version)) return "unchanged";
    existing.version = version;
    return "updated";
  }
  entries.push({ pack_id: uuid, version });
  return "added";
}

export function removeEntry(entries: WorldEntry[], uuid: string): boolean {
  const before = entries.length;
  const kept = entries.filter((entry) => uuidKey(entry.pack_id) !== uuidKey(uuid));
  entries.splice(0, entries.length, ...kept);
  return kept.length !== before;
}

/** An entry's version as a list, accepting the "1.0.0" strings some tools write; null when there is none. */
export function entryVersion(entry: WorldEntry): Version | null {
  const raw = entry.version as unknown;
  if (Array.isArray(raw) || typeof raw === "string") return normalizeVersion(raw);
  return null;
}

/** `uuid|version` keys of every valid entry. */
export function registeredKeys(entries: WorldEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    const version = entryVersion(entry);
    if (entry.pack_id && version) keys.add(packVersionKey(entry.pack_id, version));
  }
  return keys;
}

export const packVersionKey = (uuid: string, version: Version): string => `${uuidKey(uuid)}|${JSON.stringify(normalizeVersion(version))}`;
