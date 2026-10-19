import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import yauzl from "yauzl";

import { runBackup } from "../src/server/core/commands/backup";
import { runAudit, runCleanup, runFixNesting, runRebuild } from "../src/server/core/commands/maintenance";
import { worldStatus, worldSummaries } from "../src/server/core/commands/status";
import { SelectionError, runUninstall } from "../src/server/core/commands/uninstall";
import { NothingToDoError, runWorldEdit } from "../src/server/core/commands/worldEdit";
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
    expect(status.level).toEqual({ exists: true, beta: false, gamemode: "creative", levelName: "Test", error: null });

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
    const result = await runWorldEdit(s.ctx, s.world, { beta: true, gamemode: "adventure" });
    expect([result.betaChanged, result.gamemodeChanged]).toEqual([true, true]);
    expect(result.status.level).toMatchObject({ beta: true, gamemode: "adventure" });
    expect(existsSync(join(s.worldDir, "level.dat.backup"))).toBe(true);
    const again = await runWorldEdit(s.newJob(), s.world, { beta: true, gamemode: "adventure" });
    expect([again.betaChanged, again.gamemodeChanged]).toEqual([false, false]);
  });

  it("refuses an empty change and copes with a missing level.dat", async () => {
    await expect(runWorldEdit(s.ctx, s.world, {})).rejects.toBeInstanceOf(NothingToDoError);
    const result = await runWorldEdit(s.newJob(), s.world, { beta: true });
    expect(result.betaChanged).toBe(false);
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
});
