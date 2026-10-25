/** Bedrock level.dat: an 8-byte header (version, length) then little-endian NBT. */
import nbt from "prismarine-nbt";

import { GAMEMODES, type Experiment, type Gamemode } from "../../shared/model";
import type { Storage } from "../storage/storage";

/** Experiments shown even when a level.dat does not mention them yet. Others appear when a world has them. */
export const KNOWN_EXPERIMENTS: { key: string; label: string; description: string }[] = [
  { key: "gametest", label: "Beta APIs", description: "Beta versions of the script APIs, which most script add-ons need" },
  { key: "upcoming_creator_features", label: "Upcoming Creator Features", description: "Add-on features that are not finished yet" },
  { key: "experimental_molang_features", label: "Experimental Molang Features", description: "Newer Molang queries some packs use" },
  { key: "data_driven_biomes", label: "Custom Biomes", description: "Lets behavior packs define their own biomes" },
];
const EXPERIMENT_LABELS: Record<string, string> = {
  data_driven_items: "Holiday Creator Features",
  villager_trades_rebalance: "Villager Trade Rebalancing",
};
/** Bookkeeping flags inside `experiments`, not experiments themselves. */
const EXPERIMENT_BOOKKEEPING = new Set(["experiments_ever_used", "saved_with_toggled_experiments"]);

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

export function experimentsOf(level: LevelDat): Experiment[] {
  const stored = (fields(level).experiments?.type === "compound" ? fields(level).experiments!.value : {}) as Compound;
  const on = (key: string) => Number(stored[key]?.value ?? 0) === 1;
  const known = KNOWN_EXPERIMENTS.map((experiment) => ({ ...experiment, enabled: on(experiment.key) }));
  const extra = Object.keys(stored)
    .filter((key) => !EXPERIMENT_BOOKKEEPING.has(key) && !KNOWN_EXPERIMENTS.some((experiment) => experiment.key === key))
    .sort()
    .map((key) => ({ key, label: EXPERIMENT_LABELS[key] ?? key, description: "Set in this world's level.dat", enabled: on(key) }));
  return [...known, ...extra];
}

export async function readLevelDat(storage: Storage, path: string): Promise<LevelDat> {
  return parseLevelDat(await storage.readFile(path));
}

export const backupPath = (path: string): string => `${path}.backup`;

export interface LevelChanges {
  /** Experiments to switch on or off, by key. */
  experiments?: Record<string, boolean>;
  gamemode?: Gamemode | null;
}

const EXPERIMENT_KEY = /^[a-z0-9_]+$/;

/**
 * Apply every change in one read and one write. The untouched file is kept as level.dat.backup, so the
 * backup is always the state before this edit. Returns what changed (nothing is written when that is empty).
 */
export async function editLevelDat(storage: Storage, path: string, changes: LevelChanges): Promise<string[]> {
  const original = await storage.readFile(path);
  const level = parseLevelDat(original);
  const root = fields(level);
  const changed: string[] = [];

  const wanted = Object.entries(changes.experiments ?? {}).filter(([key]) => EXPERIMENT_KEY.test(key) && !EXPERIMENT_BOOKKEEPING.has(key));
  if (wanted.length) {
    const experiments = (root.experiments?.type === "compound" ? root.experiments.value : {}) as Compound;
    const labels = new Map(experimentsOf(level).map((experiment) => [experiment.key, experiment.label]));
    for (const [key, enable] of wanted) {
      if ((Number(experiments[key]?.value ?? 0) === 1) === enable) continue;
      experiments[key] = { type: "byte", value: enable ? 1 : 0 };
      changed.push(`${labels.get(key) ?? key} ${enable ? "on" : "off"}`);
    }
    if (changed.length) {
      // The game marks worlds that have ever used experiments; it shows a warning for them.
      if (Object.entries(experiments).some(([key, value]) => !EXPERIMENT_BOOKKEEPING.has(key) && Number(value.value) === 1)) {
        experiments.experiments_ever_used = { type: "byte", value: 1 };
        experiments.saved_with_toggled_experiments = { type: "byte", value: 1 };
      }
      root.experiments = { type: "compound", value: experiments };
    }
  }

  if (changes.gamemode && gamemodeOf(level) !== changes.gamemode) {
    root.GameType = { type: "int", value: GAMEMODES.indexOf(changes.gamemode) };
    changed.push(`default gamemode ${changes.gamemode}`);
  }

  if (changed.length) {
    await storage.writeFile(backupPath(path), original);
    await storage.writeFile(path, serializeLevelDat(level));
  }
  return changed;
}

/** Turn Beta APIs on (kept for callers that only need that). */
export async function enableBetaApis(storage: Storage, path: string): Promise<boolean> {
  return (await editLevelDat(storage, path, { experiments: { gametest: true } })).length > 0;
}

export async function setGamemode(storage: Storage, path: string, gamemode: Gamemode): Promise<boolean> {
  return (await editLevelDat(storage, path, { gamemode })).length > 0;
}
