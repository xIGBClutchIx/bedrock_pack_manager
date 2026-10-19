/** Bedrock level.dat: an 8-byte header (version, length) then little-endian NBT. */
import nbt from "prismarine-nbt";

import { GAMEMODES, type Gamemode } from "../../shared/model";
import type { Storage } from "../storage/storage";

const BETA_EXPERIMENTS = ["data_driven_items", "gametest", "experiments_ever_used", "saved_with_toggled_experiments"];

type Compound = Record<string, { type: string; value: unknown }>;

export interface LevelDat {
  version: number;
  root: nbt.NBT;
}

export function parseLevelDat(data: Buffer): LevelDat {
  if (data.length < 8) throw new Error("level.dat is too short to be valid");
  const version = data.readUInt32LE(0);
  const root = nbt.parseUncompressed(data.subarray(8), "little");
  return { version, root };
}

export function serializeLevelDat(level: LevelDat): Buffer {
  const body = nbt.writeUncompressed(level.root, "little");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(level.version, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

const fields = (level: LevelDat): Compound => level.root.value as unknown as Compound;

export function betaEnabled(level: LevelDat): boolean {
  const experiments = fields(level).experiments?.value as Compound | undefined;
  return Number(experiments?.gametest?.value ?? 0) === 1;
}

export function gamemodeOf(level: LevelDat): Gamemode | null {
  const value = fields(level).GameType?.value;
  return typeof value === "number" ? (GAMEMODES[value] ?? null) : null;
}

export function levelNameOf(level: LevelDat): string | null {
  const value = fields(level).LevelName?.value;
  return typeof value === "string" ? value : null;
}

export async function readLevelDat(storage: Storage, path: string): Promise<LevelDat> {
  return parseLevelDat(await storage.readFile(path));
}

export const backupPath = (path: string): string => `${path}.backup`;

async function writeWithBackup(storage: Storage, path: string, original: Buffer, level: LevelDat): Promise<void> {
  // Keep the untouched bytes before replacing the world file.
  await storage.writeFile(backupPath(path), original);
  await storage.writeFile(path, serializeLevelDat(level));
}

export async function enableBetaApis(storage: Storage, path: string): Promise<boolean> {
  const original = await storage.readFile(path);
  const level = parseLevelDat(original);
  if (betaEnabled(level)) return false;
  const root = fields(level);
  const experiments = (root.experiments?.type === "compound" ? root.experiments.value : {}) as Compound;
  for (const key of BETA_EXPERIMENTS) experiments[key] = { type: "byte", value: 1 };
  root.experiments = { type: "compound", value: experiments };
  await writeWithBackup(storage, path, original, level);
  return true;
}

export async function setGamemode(storage: Storage, path: string, gamemode: Gamemode): Promise<boolean> {
  const original = await storage.readFile(path);
  const level = parseLevelDat(original);
  const target = GAMEMODES.indexOf(gamemode);
  if (gamemodeOf(level) === gamemode) return false;
  fields(level).GameType = { type: "int", value: target };
  await writeWithBackup(storage, path, original, level);
  return true;
}
