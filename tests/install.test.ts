import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import yazl from "./yazl";
import { runInstall } from "../src/server/core/install";
import {
  cleanSourceName,
  effectivePackName,
  extractNestedArchives,
  extractZip,
  findAllPacks,
  packFolderName,
  prepareSource,
  readIncomingPack,
  UnsafeArchiveError,
} from "../src/server/core/install/unpack";
import { MemoryLog } from "../src/server/core/log";
import { BACKENDS, FIXTURES, PACK_UUID, serverSetup, tempDir, writeFile, writeManifest, writeWorldJson } from "./helpers";

const ADDON = join(FIXTURES, "installed", "addon.mcaddon");
const MCPACK = join(FIXTURES, "installed", "pack.mcpack");
const ADDON_BP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ADDON_RP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PACK_RP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const options = { duplicateMode: "replace" as const, reupload: false, dryRun: false };

describe.each(BACKENDS)("install over %s", (backend) => {
  it("installs an mcaddon and an mcpack, then skips them the second time", async () => {
    const s = await serverSetup(backend);
    try {
      const result = await runInstall(s.ctx, { ...options, world: s.world, sources: [ADDON, MCPACK] });
      expect(result.stats).toEqual({ installed: 3, skipped: 0, errors: 0 });
      expect(readdirSync(join(s.root, "behavior_packs"))).toEqual(["Addon BP-BP"]);
      // "Pack" is a generic manifest name, so the archive name is used instead.
      expect(readdirSync(join(s.root, "resource_packs")).sort()).toEqual(["Addon RP-RP", "pack-RP"]);
      expect(existsSync(join(s.root, "behavior_packs", "Addon BP-BP", "functions", ".keep"))).toBe(true);
      expect(readJson(join(s.worldDir, "world_behavior_packs.json"))).toEqual([{ pack_id: ADDON_BP, version: [1, 0, 0] }]);
      expect(
        readJson(join(s.worldDir, "world_resource_packs.json"))
          .map((e: { pack_id: string }) => e.pack_id)
          .sort(),
      ).toEqual([PACK_RP, ADDON_RP]);
      expect(result.status?.packs.every((row) => row.status === "ok")).toBe(true);
      expect(result.worlds?.[0]).toMatchObject({ bpCount: 1, rpCount: 2 });
      expect(readdirSync(s.ctx.scratchDir)).toEqual([]);

      const again = await runInstall(s.newJob(), { ...options, world: s.world, sources: [ADDON, MCPACK] });
      expect(again.stats).toEqual({ installed: 0, skipped: 3, errors: 0 });
    } finally {
      await s.close();
    }
  });
});

describe("install behaviour", () => {
  let s: Awaited<ReturnType<typeof serverSetup>>;
  let src: ReturnType<typeof tempDir>;
  beforeEach(async () => {
    s = await serverSetup("local");
    src = tempDir("bpm-src-");
  });
  afterEach(async () => {
    await s.close();
    src.cleanup();
  });

  it("previews without changing anything", async () => {
    const log = new MemoryLog();
    const result = await runInstall({ ...s.ctx, log }, { ...options, dryRun: true, world: s.world, sources: [ADDON] });
    expect(result.plan.map((item) => item.action)).toEqual(["upload", "upload"]);
    expect(result.applied).toBe(false);
    expect(readdirSync(join(s.root, "behavior_packs"))).toEqual([]);
    expect(existsSync(join(s.worldDir, "world_behavior_packs.json"))).toBe(false);
    expect(log.text()).toContain("Nothing was changed");
  });

  it("registers a same-version pack that is already on the server without uploading", async () => {
    writeManifest(join(s.root, "behavior_packs", "Already There"));
    writeManifest(join(src.path, "pack"));
    const result = await runInstall(s.ctx, { ...options, world: s.world, sources: [join(src.path, "pack")] });
    expect(result.plan[0]?.action).toBe("register");
    expect(readdirSync(join(s.root, "behavior_packs"))).toEqual(["Already There"]);
    expect(readJson(join(s.worldDir, "world_behavior_packs.json"))).toEqual([{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
  });

  it("re-uploads the same version in place when asked", async () => {
    writeManifest(join(s.root, "behavior_packs", "Test Pack-BP"));
    writeWorldJson(join(s.worldDir, "world_behavior_packs.json"), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    writeManifest(join(src.path, "pack"));
    writeFile(join(src.path, "pack", "new.txt"), "fresh");
    const result = await runInstall(s.ctx, { ...options, reupload: true, world: s.world, sources: [join(src.path, "pack")] });
    expect(result.plan[0]?.reason).toBe("Re-uploading the same version");
    expect(readdirSync(join(s.root, "behavior_packs"))).toEqual(["Test Pack-BP"]);
    expect(readFileSync(join(s.root, "behavior_packs", "Test Pack-BP", "new.txt"), "utf8")).toBe("fresh");
  });

  it.each([
    ["replace", ["Test Pack-BP"], [2, 0, 0]],
    ["skip", ["Test Pack-BP"], [1, 0, 0]],
    ["keep-both", ["Test Pack-BP", "Test Pack-BP_2"], [2, 0, 0]],
  ] as const)("duplicate mode %s", async (mode, folders, version) => {
    writeManifest(join(s.root, "behavior_packs", "Test Pack-BP"), { version: [1, 0, 0] });
    writeWorldJson(join(s.worldDir, "world_behavior_packs.json"), [{ pack_id: PACK_UUID, version: [1, 0, 0] }]);
    writeManifest(join(src.path, "new"), { version: [2, 0, 0] });
    await runInstall(s.ctx, { ...options, duplicateMode: mode, world: s.world, sources: [join(src.path, "new")] });
    expect(readdirSync(join(s.root, "behavior_packs")).sort()).toEqual([...folders]);
    expect(readJson(join(s.worldDir, "world_behavior_packs.json"))).toEqual([{ pack_id: PACK_UUID, version: [...version] }]);
  });

  it("never replaces built-in game packs", async () => {
    writeManifest(join(s.root, "behavior_packs", "vanilla_1.21"), { version: [1, 0, 0] });
    writeManifest(join(src.path, "new"), { version: [2, 0, 0] });
    const result = await runInstall(s.ctx, { ...options, world: s.world, sources: [join(src.path, "new")] });
    expect(result.plan[0]?.replaces).toEqual([]);
    expect(existsSync(join(s.root, "behavior_packs", "vanilla_1.21"))).toBe(true);
  });

  it("installs into the world's own folders when scoped to the world", async () => {
    const { Target } = await import("../src/server/core/layout");
    const target = await Target.open(s.storage, { packScope: "world" });
    await runInstall({ ...s.ctx, target }, { ...options, world: s.world, sources: [MCPACK] });
    expect(existsSync(join(s.worldDir, "resource_packs", "pack-RP", "manifest.json"))).toBe(true);
  });

  it("reports bad sources and missing dependencies", async () => {
    writeFile(join(src.path, "notes.txt"), "hi");
    writeFile(join(src.path, "broken.mcpack"), "not a zip");
    mkdirSync(join(src.path, "empty folder"));
    writeManifest(join(src.path, "needs-dep"), {
      dependencies: [{ uuid: "99999999-9999-9999-9999-999999999999", version: [1, 0, 0] }, { module_name: "@minecraft/server" }],
    });
    const result = await runInstall(s.ctx, {
      ...options,
      world: s.world,
      sources: ["notes.txt", "broken.mcpack", "empty folder", "needs-dep"].map((name) => join(src.path, name)),
    });
    expect(result.stats.errors).toBe(3);
    const warnings = s.log.warnings.join("\n");
    expect(warnings).toContain("Unknown file type");
    expect(warnings).toContain("not a valid zip archive");
    expect(warnings).toContain("No manifest.json found anywhere inside 'empty folder'");
    expect(warnings).toMatch(/99999999.*not installed/);
  });

  it("dedupes the same pack queued twice and avoids folder name clashes", async () => {
    mkdirSync(join(s.root, "behavior_packs", "Test Pack-BP"));
    writeManifest(join(src.path, "a", "pack"));
    writeManifest(join(src.path, "b", "pack"));
    const result = await runInstall(s.ctx, {
      ...options,
      dryRun: true,
      world: s.world,
      sources: [join(src.path, "a"), join(src.path, "b")],
    });
    expect(result.plan.map((item) => item.action)).toEqual(["upload", "skip"]);
    expect(result.plan[0]?.target).toMatch(/Test Pack-BP_2$/);
    expect(result.plan[1]?.reason).toContain("already queued");
  });
});

describe("unpacking", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("handles nested archives, junk folders and disguised zips", async () => {
    const bundle = join(dir.path, "bundle");
    mkdirSync(bundle);
    copyFileSync(ADDON, join(bundle, "inner.mcaddon"));
    writeManifest(join(bundle, "loose", "Loose BP"), { uuid: "77777777-7777-7777-7777-777777777777", name: "Loose" });
    writeManifest(join(bundle, "__MACOSX", "ghost"), { uuid: "88888888-8888-8888-8888-888888888888" });
    const outer = join(dir.path, "outer.zip");
    await yazl.zipFolder(bundle, outer);
    const log = new MemoryLog();
    const source = await prepareSource(outer, join(dir.path, "scratch"), log);
    expect(source.packs.map((pack) => pack.displayName).sort()).toEqual(["Addon BP", "Addon RP", "Loose"]);

    copyFileSync(MCPACK, join(dir.path, "download.mcpack (1)"));
    const disguised = await prepareSource(join(dir.path, "download.mcpack (1)"), join(dir.path, "scratch"), log);
    expect(disguised.packs.map((pack) => pack.uuid)).toEqual([PACK_RP]);
  });

  it("warns about odd mcaddon and mcpack contents", async () => {
    copyFileSync(MCPACK, join(dir.path, "single.mcaddon"));
    copyFileSync(ADDON, join(dir.path, "multi.mcpack"));
    const log = new MemoryLog();
    await prepareSource(join(dir.path, "single.mcaddon"), join(dir.path, "scratch"), log);
    await prepareSource(join(dir.path, "multi.mcpack"), join(dir.path, "scratch"), log);
    expect(log.warnings.join("\n")).toMatch(/only contains 1 pack.*Behavior Pack/);
    expect(log.warnings.join("\n")).toContain("is a .mcpack but contains 2 packs");
  });

  it("refuses archives that escape the target folder", async () => {
    const evil = join(dir.path, "evil.zip");
    await yazl.zipEntries(evil, [["../escape.txt", "x"]]);
    await expect(extractZip(evil, join(dir.path, "out"))).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(join(dir.path, "escape.txt"))).toBe(false);
  });

  it("drops broken nested archives with a warning", async () => {
    writeFile(join(dir.path, "f", "bad.mcpack"), "nope");
    const log = new MemoryLog();
    expect(await extractNestedArchives(join(dir.path, "f"), log)).toBe(true);
    expect(log.warnings.join()).toContain("not a valid archive");
    expect(existsSync(join(dir.path, "f", "bad.mcpack"))).toBe(false);
  });

  it("validates incoming manifests", async () => {
    const log = new MemoryLog();
    writeManifest(join(dir.path, "skin"), { type: "skin_pack" });
    writeManifest(join(dir.path, "weird"), { type: "mystery" });
    writeManifest(join(dir.path, "nouuid"), { uuid: "" });
    writeFile(join(dir.path, "corrupt", "manifest.json"), "{");
    writeManifest(join(dir.path, "beta"), { dependencies: [{ module_name: "@minecraft/server", version: "1.9.0-beta" }] });
    expect(await readIncomingPack(join(dir.path, "skin"), "s", log)).toBeNull();
    expect(await readIncomingPack(join(dir.path, "weird"), "s", log)).toBeNull();
    expect(await readIncomingPack(join(dir.path, "nouuid"), "s", log)).toBeNull();
    expect(await readIncomingPack(join(dir.path, "corrupt"), "s", log)).toBeNull();
    expect((await readIncomingPack(join(dir.path, "beta"), "s", log, false))?.usesBeta).toBe(true);
    const text = log.warnings.join("\n");
    for (const expected of [
      "not a behavior or resource pack",
      "Cannot determine type",
      "has no UUID",
      "Corrupt manifest.json",
      "beta API versions",
    ])
      expect(text).toContain(expected);
  });

  it("names folders sensibly", async () => {
    expect(cleanSourceName("Cool Addon [BP] v1.2.3.mcpack")).toBe("Cool Addon");
    expect(effectivePackName("pack.name", "folder", "Nice Thing.mcaddon")).toBe("Nice Thing");
    expect(effectivePackName("Real Name", "folder")).toBe("Real Name");
    expect(effectivePackName("pack", "/x/folder")).toBe("folder");
    expect(packFolderName("Cool: Pack!", "f", "rp", new Set())).toBe("Cool Pack-RP");
    expect(packFolderName("Already-BP", "f", "bp", new Set(["already-bp"]))).toBe("Already-BP_2");
    expect(packFolderName("???", "folder", "bp", new Set())).toBe("folder-BP");
  });

  it("finds packs and skips junk", async () => {
    writeManifest(join(dir.path, "a"));
    writeManifest(join(dir.path, "__MACOSX", "a"));
    expect(await findAllPacks(dir.path)).toEqual([join(dir.path, "a")]);
  });
});
