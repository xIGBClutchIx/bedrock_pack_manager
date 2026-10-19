/** Install: unpack sources locally, plan against the server, then apply. */
import { mkdir, rm } from "node:fs/promises";

import type { DuplicateMode, InstallResult, InstallStats } from "../../../shared/model";
import { formatVersion } from "../../../shared/model";
import { CancelledError, StorageError, throwIfAborted } from "../../storage/errors";
import { basename, join } from "../../storage/path";
import { worldStatus, worldSummaries, loadWorldPacks, type WorldPacks } from "../commands/status";
import type { Target } from "../layout";
import { info, ok, plain, section, warn, type JobLog } from "../log";
import { uuidKey } from "../manifests";
import { betaEnabled, readLevelDat } from "../nbt";
import { PackIndex } from "../packIndex";
import { saveWorldJson, upsertEntry } from "../worlds";
import { planInstall, toPlanItem, type PlannedPack } from "./plan";
import { countUploadFiles, prepareSource, versionText, type PreparedSource } from "./unpack";

export interface CommandContext {
  target: Target;
  log: JobLog;
  signal?: AbortSignal;
  /** Local scratch folder for unpacking. */
  scratchDir: string;
}

export interface InstallOptions {
  world: string;
  sources: string[];
  duplicateMode: DuplicateMode;
  reupload: boolean;
  dryRun: boolean;
}

const KIND_LABEL = { bp: "Behavior Pack", rp: "Resource Pack" } as const;

async function worldBeta(target: Target, world: string): Promise<boolean | null> {
  try {
    return betaEnabled(await readLevelDat(target.storage, target.levelDat(world)));
  } catch {
    return null;
  }
}

/** Upload a pack. When replacing a same-named folder, upload beside it first so a failed transfer never leaves the server without the pack. */
async function uploadPack(ctx: CommandContext, plan: PlannedPack, onFile: () => void): Promise<string> {
  const { storage } = ctx.target;
  const finalPath = join(plan.targetDir, plan.targetFolder);
  const clashes = plan.replace.some((copy) => copy.path.toLowerCase() === finalPath.toLowerCase());
  let uploadPath = clashes ? `${finalPath}.bpm-upload` : finalPath;

  if (clashes) await storage.removeTree(uploadPath);
  const count = await storage.uploadTree(plan.pack.folder, uploadPath, {
    exclude: plan.pack.exclude,
    signal: ctx.signal,
    onProgress: onFile,
  });
  for (const copy of plan.replace) {
    await storage.removeTree(copy.path, { signal: ctx.signal });
    info(ctx.log, `Removed old copy ${ctx.target.describe(copy.path)}`);
  }
  if (uploadPath !== finalPath) {
    try {
      await storage.rename(uploadPath, finalPath);
      uploadPath = finalPath;
    } catch {
      info(ctx.log, `The server refused the rename; the pack stays as ${basename(uploadPath)} (Bedrock does not care about folder names)`);
    }
  }
  ok(ctx.log, `Uploaded ${count} file(s) to ${ctx.target.describe(uploadPath)}`);
  return uploadPath;
}

async function applyInstall(
  ctx: CommandContext,
  world: string,
  plans: PlannedPack[],
  index: PackIndex,
  worldPacks: WorldPacks,
  stats: InstallStats,
  installed: PlannedPack[],
): Promise<void> {
  const { target, log } = ctx;
  const changed = new Set<"bp" | "rp">();
  const uploads = plans.filter((plan) => plan.action === "upload");
  const totals = await Promise.all(uploads.map((plan) => countUploadFiles(plan.pack.folder, plan.pack.exclude)));
  const totalFiles = totals.reduce((sum, value) => sum + value, 0);
  let doneFiles = 0;
  const onFile = () => log.progress("Uploading", ++doneFiles, totalFiles, "files");

  for (const plan of plans) {
    throwIfAborted(ctx.signal);
    const { pack } = plan;
    section(log, `[${KIND_LABEL[pack.kind]}] ${pack.displayName} (v${versionText(pack)})`);
    if (plan.action === "skip") {
      info(log, plan.reason);
      stats.skipped++;
      continue;
    }
    if (plan.action === "upload") {
      let finalPath: string;
      try {
        finalPath = await uploadPack(ctx, plan, onFile);
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        warn(log, `Upload of '${pack.displayName}' failed: ${(error as Error).message}`);
        stats.errors++;
        continue;
      }
      for (const copy of plan.replace) index.remove(copy.path);
      index.add({
        uuid: pack.uuid,
        version: pack.version,
        name: pack.displayName,
        kind: pack.kind,
        dirKind: pack.kind,
        scope: plan.targetDir.startsWith(`${world}/`) ? "world" : "shared",
        path: finalPath,
        packDir: plan.targetDir,
        dependencies: pack.dependencies,
        nested: false,
        builtin: false,
      });
    } else {
      info(log, plan.reason);
    }

    const jsonName = basename(target.worldJson(world, pack.kind));
    const registration = upsertEntry(worldPacks[pack.kind], pack.uuid, pack.version);
    if (registration !== "unchanged") changed.add(pack.kind);
    if (registration === "added") ok(log, `Registered in ${jsonName}`);
    else if (registration === "updated") info(log, `Updated ${jsonName} to v${versionText(pack)}`);
    stats.installed++;
    installed.push(plan);
  }
  for (const kind of changed) await saveWorldJson(target.storage, target.worldJson(world, kind), worldPacks[kind]);
}

function dependencyWarnings(index: PackIndex, worldPacks: WorldPacks, installed: PlannedPack[]): string[] {
  const known = new Set([...index.uuids(), ...[...worldPacks.bp, ...worldPacks.rp].map((entry) => uuidKey(entry.pack_id))]);
  const warnings: string[] = [];
  for (const { pack } of installed) {
    for (const dep of pack.dependencies) {
      const depUuid = uuidKey(dep.uuid);
      if (depUuid && depUuid !== uuidKey(pack.uuid) && !known.has(depUuid)) {
        warnings.push(
          `'${pack.displayName}' depends on UUID ${dep.uuid} (v${formatVersion(dep.version as never)}) which is not installed - it may not work. Install the matching pack too.`,
        );
      }
    }
  }
  return warnings;
}

export async function runInstall(ctx: CommandContext, options: InstallOptions): Promise<InstallResult> {
  const { target, log } = ctx;
  const { world } = options;
  section(log, options.dryRun ? "Install packs (preview)" : "Install packs");
  plain(log, `Server: ${target.label}   World: ${basename(world) || target.label}`);
  const result: InstallResult = { plan: [], stats: { installed: 0, skipped: 0, errors: 0 }, applied: false, dryRun: options.dryRun };
  if (!options.sources.length) {
    plain(log, "Nothing to install.");
    return result;
  }

  await mkdir(ctx.scratchDir, { recursive: true });
  const [worldPacks, beta] = await Promise.all([loadWorldPacks(target, world), worldBeta(target, world)]);
  const prepared: PreparedSource[] = [];
  try {
    // Unpacking is local and independent per source; reading the server can start at the same time.
    const indexPromise = PackIndex.build(target, world);
    indexPromise.catch(() => undefined); // awaited below; avoid an unhandled rejection if unpacking throws first
    for (const source of options.sources) {
      throwIfAborted(ctx.signal);
      const ready = await prepareSource(source, ctx.scratchDir, log, beta);
      if (!ready.packs.length) result.stats.errors++;
      prepared.push(ready);
    }
    const index = await indexPromise;
    const incoming = prepared.flatMap((source) => source.packs);
    const plans = await planInstall(target, world, incoming, index, worldPacks, options);
    result.plan = plans.map((plan) => toPlanItem(plan, target));

    if (options.dryRun) {
      const counts = { upload: 0, register: 0, skip: 0 };
      for (const plan of plans) counts[plan.action]++;
      section(log, "Planned changes");
      for (const item of result.plan)
        plain(
          log,
          `${item.action.toUpperCase().padEnd(8)} ${item.name} v${item.versionLabel} - ${item.reason}${item.target ? ` -> ${item.target}` : ""}`,
        );
      ok(log, `Would upload ${counts.upload}, register ${counts.register}, skip ${counts.skip}. Nothing was changed.`);
      return result;
    }

    const installed: PlannedPack[] = [];
    if (plans.length) section(log, "Applying");
    await applyInstall(ctx, world, plans, index, worldPacks, result.stats, installed);
    result.applied = true;
    for (const message of dependencyWarnings(index, worldPacks, installed)) warn(log, message);

    const { installed: count, skipped, errors } = result.stats;
    ok(
      log,
      `Done. Installed ${count}, skipped ${skipped}, errors ${errors}. The world now has ${worldPacks.bp.length} behavior and ${worldPacks.rp.length} resource pack(s).`,
    );
    [result.status, result.worlds] = await Promise.all([worldStatus(target, world, index), worldSummaries(target)]);
    return result;
  } catch (error) {
    if (error instanceof StorageError) warn(log, error.message);
    throw error;
  } finally {
    await Promise.all(
      prepared.filter((source) => source.extracted).map((source) => rm(source.extracted!, { recursive: true, force: true })),
    );
  }
}
