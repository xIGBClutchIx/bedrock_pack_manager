/** Beta APIs and default gamemode in level.dat (a level.dat.backup is written first). */
import type { Gamemode, WorldEditResult } from "../../../shared/model";
import { isNotFound } from "../../storage/errors";
import { basename } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, section, warn } from "../log";
import { enableBetaApis, setGamemode } from "../nbt";
import { worldStatus } from "./status";

export class NothingToDoError extends Error {}

export async function runWorldEdit(
  ctx: CommandContext,
  world: string,
  changes: { beta?: boolean; gamemode?: Gamemode | null },
): Promise<WorldEditResult> {
  const { target, log } = ctx;
  if (!changes.beta && !changes.gamemode) throw new NothingToDoError("Choose at least one change");
  const datPath = target.levelDat(world);
  const name = basename(world) || target.label;
  section(log, "Edit world settings");
  const result = { betaChanged: false, gamemodeChanged: false };
  try {
    if (changes.beta) {
      result.betaChanged = await enableBetaApis(target.storage, datPath);
      if (result.betaChanged) ok(log, `Beta APIs enabled for '${name}'`);
      else info(log, `Beta APIs were already enabled for '${name}'`);
    }
    if (changes.gamemode) {
      result.gamemodeChanged = await setGamemode(target.storage, datPath, changes.gamemode);
      if (result.gamemodeChanged) ok(log, `Default gamemode set to ${changes.gamemode} for '${name}'`);
      else info(log, `Default gamemode was already ${changes.gamemode}`);
    }
  } catch (error) {
    if (isNotFound(error)) {
      warn(log, `No level.dat found in '${name}' - nothing changed`);
      return { ...result, status: await worldStatus(target, world) };
    }
    throw error;
  }
  if (result.betaChanged || result.gamemodeChanged) {
    info(log, "The previous file was kept as level.dat.backup");
    warn(log, "Restart the server for this to take effect - a running server may overwrite level.dat when it stops");
  }
  return { ...result, status: await worldStatus(target, world) };
}
