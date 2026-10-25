/** Experiments (Beta APIs and others) and the default gamemode in level.dat (a level.dat.backup is written first). */
import type { WorldEditResult } from "../../../shared/model";
import { isNotFound } from "../../storage/errors";
import { basename } from "../../storage/path";
import type { CommandContext } from "../install";
import { info, ok, section, warn } from "../log";
import { editLevelDat, type LevelChanges } from "../nbt";
import { worldStatus } from "./status";

export class NothingToDoError extends Error {}

export async function runWorldEdit(ctx: CommandContext, world: string, changes: LevelChanges): Promise<WorldEditResult> {
  const { target, log } = ctx;
  if (!Object.keys(changes.experiments ?? {}).length && !changes.gamemode) throw new NothingToDoError("Choose at least one change");
  const datPath = target.levelDat(world);
  const name = basename(world) || target.label;
  section(log, "Edit world settings");
  let changed: string[] = [];
  try {
    changed = await editLevelDat(target.storage, datPath, changes);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    warn(log, `No level.dat found in '${name}' - nothing changed`);
    return { changed, status: await worldStatus(target, world) };
  }
  if (changed.length) {
    for (const change of changed) ok(log, `${change[0]!.toUpperCase()}${change.slice(1)} for '${name}'`);
    info(log, "The previous file was kept as level.dat.backup");
    warn(log, "Restart the server for this to take effect - a running server may overwrite level.dat when it stops");
  } else {
    info(log, `level.dat for '${name}' already had these settings`);
  }
  return { changed, status: await worldStatus(target, world) };
}
