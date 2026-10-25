import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import yauzl from "yauzl";

import { runBackup } from "../src/server/core/commands/backup";
import { runAudit, runCleanup, runFixNesting, runRebuild } from "../src/server/core/commands/maintenance";
import { worldStatus, worldSummaries } from "../src/server/core/commands/status";
import { SelectionError, runUninstall } from "../src/server/core/commands/uninstall";
import { NothingToDoError, runWorldEdit } from "../src/server/core/commands/worldEdit";
import { runWorldPacks } from "../src/server/core/commands/worldPacks";
import { NotFoundError } from "../src/server/storage/errors";
import { PACK_UUID, levelDatBytes, serverSetup, writeFile, writeManifest, writeWorldJson } from "./helpers";

const OTHER = "33333333-3333-3333-3333-333333333333";
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const key = (uuid = PACK_UUID, kind = "bp", version = "1.0.0") => `${kind}:${uuid}:${version}`;

let s: Awaited<ReturnType<typeof serverSetup>>;
beforeEach(async () => {
  s = await serverSetup("local");
});
afterEach(async () => {
  await s.close();
});
const bpJson = () => join(s.worldDir, "world_behavior_packs.json");

describe("world status", () => {
  it("classifies every pack and reads level.dat", async () => {
    writeManifest(join(s.root, "behavior_packs", "Ok"), {
      name: "Ok Pack",
      dependencies: [{ uuid: "deadbeef-0000-0000-0000-000000000000", version: [1, 0, 0] }],
    });
    writeManifest(join(s.root, "behavior_packs", "Old"), { uuid: OTHER, name: "Old" });
    writeManifest(join(s.root, "resource_packs", "Stray"), {
      uuid: "44444444-4444-4444-4444-444444444444",
      type: "resources",
      name: "Stray",
    });
    writeManifest(join(s.root, "behavior_packs", "vanilla_1.20"), { uuid: "fe9f8597-0000-0000-0000-000000000000" });
    writeWorldJson(bpJson(), [
      { pack_id: PACK_UUID, version: [1, 0, 0] },
      { pack_id: OTHER, version: [2, 0, 0] },
      { pack_id: "55555555-5555-5555-5555-555555555555", version: [1, 0, 0] },
      { version: [1, 0, 0] },
    ]);
    writeFile(
      join(s.worldDir, "level.dat"),
      levelDatBytes({ GameType: { type: "int", value: 1 }, LevelName: { type: "string", value: "Test" } }),
    );

    const status = await worldStatus(s.target, s.world);
    const byName = Object.fromEntries(status.packs.map((row) => [row.name, row]));
    expect(byName["Ok Pack"]?.status).toBe("ok");
    expect(byName["Old"]).toMatchObject({ status: "version-mismatch", onServerVersions: ["1.0.0"] });
    expect(byName["55555555-5555-5555-5555-555555555555"]?.status).toBe("missing");
    expect(byName["Stray"]).toMatchObject({ status: "unregistered", key: "" });
    expect(status.hiddenBuiltin).toBe(1);
    expect(status.problems.map((p) => p.kind).sort()).toEqual(["dependency", "registration"]);
    expect(status.level).toMatchObject({ exists: true, beta: false, gamemode: "creative", levelName: "Test", error: null });
    expect(status.level.experiments.find((experiment) => experiment.key === "gametest")).toMatchObject({ enabled: false });

    const summaries = await worldSummaries(s.target);
    expect(summaries).toEqual([{ path: "worlds/W", name: "W", hasLevelDat: true, bpCount: 4, rpCount: null, isLevelName: false }]);
  });

  it("reports an unreadable level.dat", async () => {
    writeFile(join(s.worldDir, "level.dat"), "x");
    const status = await worldStatus(s.target, s.world);
    expect(status.level.exists).toBe(true);
    expect(status.level.error).toBeTruthy();
  });

  it("audit warns about problems and is clean otherwise", async () => {
    writeManifest(join(s.root, "behavior_packs", "Ok"));
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    await runAudit(s.ctx, s.world);
    expect(s.log.text()).toContain("Audit clean.");

    writeWorldJson(bpJson(), [{ pack_id: OTHER, version: [1, 0, 0] }]);
    const job = s.newJob();
    await runAudit(job, s.world);
    expect(job.log.warnings.join("\n")).toMatch(/missing on the server[\s\S]*not registered/);
  });
});

describe("uninstall", () => {
  it("unregisters and deletes the folder", async () => {
    writeManifest(join(s.root, "behavior_packs", "Pack-BP"));
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    const result = await runUninstall(s.ctx, s.world, [key()], false);
    expect(result.removed).toBe(1);
    expect(readJson(bpJson())).toEqual([]);
    expect(existsSync(join(s.root, "behavior_packs", "Pack-BP"))).toBe(false);
    expect(result.status.packs).toEqual([]);
  });

  it("keeps shared folders other worlds use, and deletes world-local copies", async () => {
    writeManifest(join(s.root, "behavior_packs", "Pack-BP"));
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    writeWorldJson(join(s.root, "worlds", "Other", "world_behavior_packs.json"), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    await runUninstall(s.ctx, s.world, [key()], false);
    expect(existsSync(join(s.root, "behavior_packs", "Pack-BP"))).toBe(true);

    writeManifest(join(s.worldDir, "behavior_packs", "Local"));
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    await runUninstall(s.newJob(), s.world, [key()], false);
    expect(existsSync(join(s.worldDir, "behavior_packs", "Local"))).toBe(false);
  });

  it("keeps a shared folder when another world's pack list cannot be read", async () => {
    writeManifest(join(s.root, "behavior_packs", "Pack-BP"));
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    writeFile(join(s.root, "worlds", "Other", "world_behavior_packs.json"), "[ not json");
    await runUninstall(s.ctx, s.world, [key()], false);
    expect(existsSync(join(s.root, "behavior_packs", "Pack-BP"))).toBe(true);
    expect(s.log.text()).toContain("could not be read");
  });

  it("understands world entries with string versions", async () => {
    writeManifest(join(s.root, "behavior_packs", "Pack-BP"));
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: "1.0.0" }]);
    const status = await worldStatus(s.target, s.world);
    expect(status.packs[0]).toMatchObject({ status: "ok", key: key() });
    await runUninstall(s.newJob(), s.world, [key()], false);
    expect(readJson(bpJson())).toEqual([]);
  });

  it("keeps files on request, handles stale entries, and rejects unknown keys", async () => {
    writeManifest(join(s.root, "behavior_packs", "Pack-BP"));
    writeWorldJson(bpJson(), [
      { pack_id: PACK_UUID, version: [1, 0, 0] },
      { pack_id: OTHER, version: [1, 0, 0] },
    ]);
    await runUninstall(s.ctx, s.world, [key(), key(OTHER)], true);
    expect(existsSync(join(s.root, "behavior_packs", "Pack-BP"))).toBe(true);
    expect(readJson(bpJson())).toEqual([]);
    await expect(runUninstall(s.newJob(), s.world, ["bp:nope:1"], false)).rejects.toBeInstanceOf(SelectionError);
  });
});

describe("maintenance", () => {
  it("rebuild registers the newest version of each pack and skips game and nested packs", async () => {
    writeManifest(join(s.root, "behavior_packs", "A v1"), { version: [1, 0, 0] });
    writeManifest(join(s.root, "behavior_packs", "A v2"), { version: [2, 0, 0] });
    writeManifest(join(s.root, "resource_packs", "R"), { uuid: OTHER, type: "resources" });
    writeManifest(join(s.root, "behavior_packs", "Wrap", "Nested"), { uuid: "77777777-7777-7777-7777-777777777777" });
    writeManifest(join(s.root, "behavior_packs", "vanilla"), { uuid: "fe9f8597-0000-0000-0000-000000000000" });
    const result = await runRebuild(s.ctx, s.world);
    expect([result.behaviorPacks, result.resourcePacks]).toEqual([1, 1]);
    expect(readJson(bpJson())).toEqual([{ pack_id: PACK_UUID, version: [2, 0, 0] }]);
    expect(s.log.warnings.join()).toContain("several versions installed");
  });

  it("cleanup previews, then deletes only unused folders", async () => {
    writeManifest(join(s.root, "behavior_packs", "Used"));
    writeManifest(join(s.root, "behavior_packs", "Unused"), { uuid: OTHER });
    writeManifest(join(s.root, "behavior_packs", "Shared"), { uuid: "88888888-8888-8888-8888-888888888888" });
    writeManifest(join(s.root, "behavior_packs", "editor"), { uuid: "99999999-0000-0000-0000-000000000000" });
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    writeWorldJson(join(s.root, "worlds", "Other", "world_behavior_packs.json"), [
      { pack_id: "88888888-8888-8888-8888-888888888888", version: [1, 0, 0] },
    ]);

    const preview = await runCleanup(s.ctx, s.world, true);
    expect(preview.deleted.map((path) => path.split(/[\\/]/).pop())).toEqual(["Unused"]);
    expect(existsSync(join(s.root, "behavior_packs", "Unused"))).toBe(true);

    const result = await runCleanup(s.newJob(), s.world, false);
    expect(readdirSync(join(s.root, "behavior_packs")).sort()).toEqual(["Shared", "Used", "editor"]);
    expect(result.kept).toHaveLength(1);
  });

  it("rebuild keeps existing order and subpacks, and leaves out non-packs", async () => {
    const rpA = "aaaaaaaa-0000-0000-0000-00000000000a";
    const rpB = "bbbbbbbb-0000-0000-0000-00000000000b";
    writeManifest(join(s.root, "resource_packs", "A"), { uuid: rpA, type: "resources" });
    writeManifest(join(s.root, "resource_packs", "B"), { uuid: rpB, type: "resources", version: [2, 0, 0] });
    writeManifest(join(s.root, "resource_packs", "Skins"), { uuid: OTHER, type: "skin_pack" });
    writeManifest(join(s.root, "resource_packs", "C"), { uuid: "cccccccc-0000-0000-0000-00000000000c", type: "resources" });
    const rpJson = join(s.worldDir, "world_resource_packs.json");
    writeWorldJson(rpJson, [
      { pack_id: rpB, version: [1, 0, 0], subpack: "high" },
      { pack_id: "dddddddd-0000-0000-0000-00000000000d", version: [1, 0, 0] },
      { pack_id: rpA, version: [1, 0, 0] },
    ]);
    await runRebuild(s.ctx, s.world);
    expect(readJson(rpJson)).toEqual([
      { pack_id: rpB, version: [2, 0, 0], subpack: "high" },
      { pack_id: rpA, version: [1, 0, 0] },
      { pack_id: "cccccccc-0000-0000-0000-00000000000c", version: [1, 0, 0] },
    ]);
    expect(s.log.warnings.join()).toContain("not a behavior or resource pack");
  });

  it("rebuild starts over from a corrupt world JSON", async () => {
    writeManifest(join(s.root, "behavior_packs", "A"));
    writeFile(bpJson(), "{ corrupt");
    await runRebuild(s.ctx, s.world);
    expect(readJson(bpJson())).toEqual([{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
  });

  it("cleanup keeps the closest copy of a pack registered at a version the server lacks", async () => {
    writeManifest(join(s.root, "behavior_packs", "Mine"), { version: [1, 0, 1] });
    writeManifest(join(s.root, "behavior_packs", "Theirs"), { uuid: OTHER, version: [3, 0, 0] });
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    writeWorldJson(join(s.root, "worlds", "Other", "world_behavior_packs.json"), [{ pack_id: OTHER, version: [2, 0, 0] }]);
    const result = await runCleanup(s.ctx, s.world, false);
    expect(result.deleted).toEqual([]);
    expect(readdirSync(join(s.root, "behavior_packs")).sort()).toEqual(["Mine", "Theirs"]);
  });

  it("cleanup can target chosen folders and says why it keeps the rest", async () => {
    writeManifest(join(s.root, "behavior_packs", "A"));
    writeManifest(join(s.root, "behavior_packs", "B"), { uuid: OTHER });
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    const result = await runCleanup(s.ctx, s.world, false, ["behavior_packs/A", "behavior_packs/B"]);
    expect(result.deleted.map((path) => path.split(/[\\/]/).pop())).toEqual(["B"]);
    expect(s.log.text()).toContain("this world uses it");
    expect(existsSync(join(s.root, "behavior_packs", "A"))).toBe(true);
  });

  it("fix nesting keeps a wrapper that holds other files, and picks a free name", async () => {
    writeManifest(join(s.root, "behavior_packs", "Cool Pack", "Cool Pack"), { name: "Cool" });
    writeFile(join(s.root, "behavior_packs", "Cool Pack", "readme.txt"), "hi");
    const preview = await runFixNesting(s.ctx, s.world, [], true);
    expect(preview.moves[0]?.to).toMatch(/Cool Pack_2$/);
    await runFixNesting(s.newJob(), s.world, [], false);
    expect(readdirSync(join(s.root, "behavior_packs")).sort()).toEqual(["Cool Pack", "Cool Pack_2"]);
    expect(readdirSync(join(s.root, "behavior_packs", "Cool Pack"))).toEqual(["readme.txt"]);
    expect(existsSync(join(s.root, "behavior_packs", "Cool Pack_2", "manifest.json"))).toBe(true);
  });

  it("fix nesting moves a wrapped pack up, even when the names match", async () => {
    writeManifest(join(s.root, "behavior_packs", "Cool Pack", "Cool Pack"), { name: "Cool" });
    writeManifest(join(s.root, "behavior_packs", "Wrapper", "Inner BP"), { uuid: OTHER, name: "Inner" });
    const preview = await runFixNesting(s.ctx, s.world, [], true);
    expect(preview.moves).toHaveLength(2);
    expect(existsSync(join(s.root, "behavior_packs", "Wrapper", "Inner BP"))).toBe(true);

    const result = await runFixNesting(s.newJob(), s.world, [], false);
    expect(readdirSync(join(s.root, "behavior_packs")).sort()).toEqual(["Cool Pack", "Inner BP"]);
    expect(existsSync(join(s.root, "behavior_packs", "Cool Pack", "manifest.json"))).toBe(true);
    expect(result.status?.problems).toEqual([]);
  });
});

describe("world edits", () => {
  it("enables beta and sets gamemode with a backup", async () => {
    writeFile(join(s.worldDir, "level.dat"), levelDatBytes({ GameType: { type: "int", value: 0 } }));
    const result = await runWorldEdit(s.ctx, s.world, { experiments: { gametest: true }, gamemode: "adventure" });
    expect(result.changed).toEqual(["Beta APIs on", "default gamemode adventure"]);
    expect(result.status.level).toMatchObject({ beta: true, gamemode: "adventure" });
    expect(existsSync(join(s.worldDir, "level.dat.backup"))).toBe(true);
    const again = await runWorldEdit(s.newJob(), s.world, { experiments: { gametest: true }, gamemode: "adventure" });
    expect(again.changed).toEqual([]);
  });

  it("keeps the untouched level.dat as the backup when several things change at once", async () => {
    const original = levelDatBytes({ GameType: { type: "int", value: 0 } });
    writeFile(join(s.worldDir, "level.dat"), original);
    await runWorldEdit(s.ctx, s.world, { experiments: { gametest: true, upcoming_creator_features: true }, gamemode: "creative" });
    expect(readFileSync(join(s.worldDir, "level.dat.backup")).equals(original)).toBe(true);
  });

  it("turns experiments off again and lists the ones a world has", async () => {
    writeFile(
      join(s.worldDir, "level.dat"),
      levelDatBytes({
        experiments: {
          type: "compound",
          value: {
            gametest: { type: "byte", value: 1 },
            some_new_toggle: { type: "byte", value: 1 },
            experiments_ever_used: { type: "byte", value: 1 },
          },
        },
      }),
    );
    const result = await runWorldEdit(s.ctx, s.world, { experiments: { gametest: false } });
    expect(result.changed).toEqual(["Beta APIs off"]);
    const experiments = Object.fromEntries(result.status.level.experiments.map((e) => [e.key, e.enabled]));
    expect(experiments).toMatchObject({ gametest: false, some_new_toggle: true, upcoming_creator_features: false });
    expect(experiments).not.toHaveProperty("experiments_ever_used");
  });

  it("refuses an empty change and copes with a missing level.dat", async () => {
    await expect(runWorldEdit(s.ctx, s.world, {})).rejects.toBeInstanceOf(NothingToDoError);
    const result = await runWorldEdit(s.newJob(), s.world, { experiments: { gametest: true } });
    expect(result.changed).toEqual([]);
  });
});

describe("backup", () => {
  it("streams a zip of the world and pack folders", async () => {
    writeFile(join(s.worldDir, "level.dat"), "L");
    writeFile(join(s.root, "worlds", "Other", "level.dat"), "O");
    writeManifest(join(s.root, "behavior_packs", "B"));
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    const summary = await runBackup(s.ctx, s.world, sink);
    expect(summary.files).toBe(2);
    const zip = Buffer.concat(chunks);
    const names = await new Promise<string[]>((resolve, reject) =>
      yauzl.fromBuffer(zip, { lazyEntries: false }, (error, file) => {
        if (error || !file) return reject(error);
        const out: string[] = [];
        file.on("entry", (entry: yauzl.Entry) => out.push(entry.fileName));
        file.on("end", () => resolve(out.sort()));
      }),
    );
    expect(names).toEqual(["behavior_packs/B/manifest.json", "worlds/W/level.dat"]);
  });

  it("skips a file that disappears mid-backup and keeps going", async () => {
    writeFile(join(s.worldDir, "a.txt"), "a");
    writeFile(join(s.worldDir, "db", "gone.ldb"), "g");
    writeFile(join(s.worldDir, "z.txt"), "z");
    const storage = s.target.storage as unknown as { rawRead(path: string): Promise<Buffer> };
    const read = storage.rawRead.bind(storage);
    storage.rawRead = async (path: string) => {
      if (path.endsWith("gone.ldb")) throw new NotFoundError(path);
      return read(path);
    };
    const sink = new PassThrough();
    sink.resume();
    const summary = await runBackup(s.ctx, s.world, sink);
    expect(summary.files).toBe(2);
    expect(s.log.warnings.join()).toContain("db/gone.ldb");
  });
});

describe("world pack edits", () => {
  it("registers a pack in other worlds and flags inactive dependencies", async () => {
    const lib = "77777777-7777-7777-7777-777777777777";
    writeManifest(join(s.root, "behavior_packs", "Lib"), { uuid: lib, name: "Lib" });
    writeManifest(join(s.root, "behavior_packs", "Uses Lib"), {
      name: "Uses Lib",
      dependencies: [
        { uuid: lib, version: [1, 0, 0] },
        { module_name: "@minecraft/server", version: "1.12.0" },
      ],
    });
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    mkdirSync(join(s.root, "worlds", "Other"), { recursive: true });

    const before = await worldStatus(s.target, s.world);
    const row = before.packs.find((candidate) => candidate.name === "Uses Lib")!;
    expect(row.dependencies.map((dep) => [dep.name, dep.state])).toEqual([
      ["@minecraft/server", "module"],
      ["Lib", "inactive"],
    ]);
    expect(before.problems.some((problem) => problem.message.includes("not active in this world"))).toBe(true);

    const result = await runWorldPacks(s.newJob(), s.world, [
      { type: "register", kind: "bp", uuid: lib, version: [1, 0, 0] },
      { type: "register", kind: "bp", uuid: PACK_UUID, version: [1, 0, 0], worlds: ["worlds/Other"] },
    ]);
    expect(result.applied).toHaveLength(2);
    expect(result.status.problems.some((problem) => problem.kind === "dependency")).toBe(false);
    expect(readJson(join(s.root, "worlds", "Other", "world_behavior_packs.json"))).toEqual([{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    expect(result.status.packs.find((candidate) => candidate.uuid === PACK_UUID)?.usedBy).toEqual([
      { world: "Other", versionLabel: "1.0.0" },
    ]);
  });

  it("offers a newer version on the server and flags a lowercase-sensitive manifest name", async () => {
    writeManifest(join(s.root, "behavior_packs", "V1"), { version: [1, 0, 0] });
    writeManifest(join(s.root, "behavior_packs", "V2"), { version: [2, 0, 0], filename: "Manifest.json" });
    writeWorldJson(bpJson(), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    const status = await worldStatus(s.target, s.world);
    expect(status.packs[0]?.newerOnServer).toEqual([2, 0, 0]);
    // Only a case-sensitive file system (a Linux server) cares, and only there can it be seen.
    const caseSensitive = !existsSync(join(s.root, "behavior_packs", "V2", "manifest.json"));
    if (caseSensitive) expect(status.problems.map((problem) => problem.kind)).toContain("casing");
  });
});
