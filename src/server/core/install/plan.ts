/** Decide what each incoming pack needs, without touching the server. */
import type { DuplicateMode, PlanItem } from "../../../shared/model";
import { isNotFound } from "../../storage/errors";
import { join } from "../../storage/path";
import type { Target } from "../layout";
import { uuidKey } from "../manifests";
import { folderOf, versionLabel, type InstalledPack, type PackIndex } from "../packIndex";
import { upsertEntry, type WorldEntry } from "../worlds";
import type { WorldPacks } from "../commands/status";
import { packFolderName, versionText, type IncomingPack } from "./unpack";

export interface PlannedPack {
  pack: IncomingPack;
  action: "upload" | "register" | "skip";
  reason: string;
  targetDir: string;
  targetFolder: string;
  replace: InstalledPack[];
  keep: InstalledPack[];
  registration: "added" | "updated" | "unchanged";
}

export interface PlanOptions {
  duplicateMode: DuplicateMode;
  reupload: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function planInstall(
  target: Target,
  world: string,
  incoming: IncomingPack[],
  index: PackIndex,
  worldPacks: WorldPacks,
  options: PlanOptions,
): Promise<PlannedPack[]> {
  const plans: PlannedPack[] = [];
  const queued = new Map<string, PlannedPack>();
  const takenNames = new Map<string, Set<string>>();
  const pending: Record<"bp" | "rp", WorldEntry[]> = {
    bp: worldPacks.bp.map((entry) => ({ ...entry })),
    rp: worldPacks.rp.map((entry) => ({ ...entry })),
  };

  const taken = async (dir: string): Promise<Set<string>> => {
    if (!takenNames.has(dir)) {
      const names = await target.storage.listDir(dir).then(
        (entries) => entries.map((entry) => entry.name.toLowerCase()),
        (error) => {
          if (isNotFound(error)) return [];
          throw error;
        },
      );
      takenNames.set(dir, new Set(names));
    }
    return takenNames.get(dir)!;
  };
  const base = (pack: IncomingPack): PlannedPack => ({
    pack,
    action: "skip",
    reason: "",
    targetDir: "",
    targetFolder: "",
    replace: [],
    keep: [],
    registration: "unchanged",
  });

  for (const pack of incoming) {
    const key = `${uuidKey(pack.uuid)}|${JSON.stringify(pack.version)}|${pack.kind}`;
    const earlier = queued.get(key);
    if (earlier) {
      plans.push({ ...base(pack), reason: `Same pack already queued from ${earlier.pack.sourceName}` });
      continue;
    }
    const existing = index.find(pack.uuid, pack.kind);
    const sameVersion = existing.filter((copy) => same(copy.version, pack.version));

    if (sameVersion.length && !options.reupload) {
      const registration = upsertEntry(pending[pack.kind], pack.uuid, pack.version);
      const plan: PlannedPack =
        registration === "unchanged"
          ? { ...base(pack), reason: "Same UUID and version already installed and registered", keep: sameVersion }
          : {
              ...base(pack),
              action: "register",
              reason: "Same version already on the server - registering without uploading",
              keep: sameVersion,
              registration,
            };
      plans.push(plan);
      queued.set(key, plan);
      continue;
    }

    if (existing.length && options.duplicateMode === "skip") {
      plans.push({
        ...base(pack),
        reason: `UUID already on the server (installed: ${existing.map(versionLabel).join(", ")}) and duplicate mode is 'skip'`,
        keep: existing,
      });
      continue;
    }

    const targetDir = await target.installDir(world, pack.kind);
    const plan: PlannedPack = { ...base(pack), action: "upload", targetDir };
    if (existing.length && options.duplicateMode === "replace") {
      // Never delete development copies or the game's own packs.
      plan.replace = existing.filter((copy) => copy.scope !== "dev" && !copy.builtin);
      plan.keep = existing.filter((copy) => copy.scope === "dev" || copy.builtin);
      plan.reason = plan.replace.length
        ? `Replacing v${plan.replace.map(versionLabel).join(", ")}`
        : "Upload (development copy left alone)";
    } else if (existing.length) {
      plan.keep = existing;
      plan.reason = "Uploading alongside existing copies (keep-both)";
    } else {
      plan.reason = "New pack";
    }
    if (sameVersion.length && options.reupload) plan.reason = "Re-uploading the same version";

    const names = await taken(targetDir);
    const freed = new Set(plan.replace.filter((copy) => copy.packDir === targetDir).map((copy) => folderOf(copy).toLowerCase()));
    plan.targetFolder = packFolderName(pack.displayName, pack.folder, pack.kind, new Set([...names].filter((name) => !freed.has(name))));
    names.add(plan.targetFolder.toLowerCase());
    plan.registration = upsertEntry(pending[pack.kind], pack.uuid, pack.version);
    plans.push(plan);
    queued.set(key, plan);
  }
  return plans;
}

export function toPlanItem(plan: PlannedPack, target: Target): PlanItem {
  return {
    name: plan.pack.displayName,
    uuid: plan.pack.uuid,
    version: plan.pack.version,
    versionLabel: versionText(plan.pack),
    kind: plan.pack.kind,
    source: plan.pack.sourceName,
    action: plan.action === "upload" && plan.replace.length ? "replace" : plan.action,
    reason: plan.reason,
    target: plan.targetFolder ? target.describe(join(plan.targetDir, plan.targetFolder)) : "",
    replaces: plan.replace.map((copy) => target.describe(copy.path)),
    keeps: plan.keep.map((copy) => target.describe(copy.path)),
  };
}
