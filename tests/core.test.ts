import { existsSync } from "node:fs";
import { join as joinLocal } from "node:path";

import { Target, detectLayout, parseServerProperties } from "../src/server/core/layout";
import {
  ManifestError,
  classifyPack,
  compareVersions,
  getDependencies,
  getPackInfo,
  normalizeVersion,
  parseManifest,
  usesBetaApis,
} from "../src/server/core/manifests";
import {
  betaEnabled,
  enableBetaApis,
  gamemodeOf,
  levelNameOf,
  parseLevelDat,
  readLevelDat,
  serializeLevelDat,
  setGamemode,
} from "../src/server/core/nbt";
import { PackIndex } from "../src/server/core/packIndex";
import { WorldJsonError, loadWorldJson, registeredKeys, removeEntry, saveWorldJson, upsertEntry } from "../src/server/core/worlds";
import { LocalStorage } from "../src/server/storage/local";
import { PACK_UUID, levelDatBytes, makeStorage, tempDir, writeFile, writeManifest, writeWorldJson } from "./helpers";

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => dir.cleanup());

const local = (...parts: string[]) => joinLocal(dir.path, ...parts);

describe("manifests", () => {
  it("parses comments, trailing commas and BOMs", () => {
    const manifest = parseManifest(
      '﻿{ // comment\n "header": {"name": "§aCool", "uuid": " abc ", "version": "1.2.3-beta"}, /* x */ "modules": [{"type": "resources"},],}',
    );
    expect(getPackInfo(manifest)).toEqual({ uuid: "abc", version: [1, 2, 3], name: "Cool" });
    expect(classifyPack(manifest)).toBe("rp");
    expect(() => parseManifest("{")).toThrow(ManifestError);
    expect(() => parseManifest("[1]")).toThrow(ManifestError);
  });

  it("classifies, finds dependencies and beta usage", () => {
    const bp = parseManifest(
      JSON.stringify({
        modules: [{ type: "script" }],
        dependencies: [
          { uuid: "dep", version: [1, 0, 0] },
          { module_name: "@minecraft/server", version: "1.9.0-beta" },
        ],
      }),
    );
    expect(classifyPack(bp)).toBe("bp");
    expect(getDependencies(bp)).toEqual([{ uuid: "dep", version: [1, 0, 0] }]);
    expect(usesBetaApis(bp)).toBe(true);
    expect(classifyPack(parseManifest('{"modules": [{"type": "skin_pack"}]}'))).toBeNull();
    expect(classifyPack(parseManifest('{"modules": "nope"}'))).toBeNull();
  });

  it("normalises and compares versions", () => {
    expect(normalizeVersion("2.1")).toEqual([2, 1, 0]);
    expect(normalizeVersion(3)).toEqual([3, 0, 0]);
    expect(normalizeVersion(null)).toEqual([0, 0, 0]);
    expect(compareVersions([1, 2, 0], [1, 10, 0])).toBeLessThan(0);
    expect(compareVersions([1, "beta"], [1, 0])).toBeLessThan(0);
  });
});

describe("world JSON", () => {
  it("round-trips and tolerates missing, empty, BOM and junk entries", async () => {
    const storage = new LocalStorage(dir.path);
    await saveWorldJson(storage, "w/world_behavior_packs.json", [{ pack_id: "a", version: [1, 0, 0] }]);
    expect(await loadWorldJson(storage, "w/world_behavior_packs.json")).toEqual([{ pack_id: "a", version: [1, 0, 0] }]);
    expect(await loadWorldJson(storage, "missing.json")).toEqual([]);
    writeFile(local("empty.json"), "  ");
    expect(await loadWorldJson(storage, "empty.json")).toEqual([]);
    writeFile(local("bom.json"), '﻿// note\n[{"pack_id": "a", "version": [1,0,0]}, "junk"]');
    expect(await loadWorldJson(storage, "bom.json")).toEqual([{ pack_id: "a", version: [1, 0, 0] }]);
    writeFile(local("bad.json"), "[{");
    await expect(loadWorldJson(storage, "bad.json")).rejects.toBeInstanceOf(WorldJsonError);
    writeFile(local("obj.json"), "{}");
    await expect(loadWorldJson(storage, "obj.json")).rejects.toThrow(/not a list/);
  });

  it("edits entries case-insensitively", () => {
    const entries = [{ pack_id: "ABC", version: [1, 0, 0] }];
    expect(upsertEntry(entries, "abc", [1, 0, 0])).toBe("unchanged");
    expect(upsertEntry(entries, "abc", [2, 0, 0])).toBe("updated");
    expect(upsertEntry(entries, "def", [1, 0, 0])).toBe("added");
    expect(registeredKeys(entries)).toEqual(new Set(["abc|[2,0,0]", "def|[1,0,0]"]));
    expect(removeEntry(entries, "Abc")).toBe(true);
    expect(removeEntry(entries, "zzz")).toBe(false);
    expect(entries).toEqual([{ pack_id: "def", version: [1, 0, 0] }]);
  });
});

describe("level.dat", () => {
  it("parses, edits with a backup, and round-trips", async () => {
    const original = levelDatBytes({ GameType: { type: "int", value: 0 }, LevelName: { type: "string", value: "Hi" } });
    writeFile(local("level.dat"), original);
    const storage = new LocalStorage(dir.path);
    const level = parseLevelDat(original);
    expect([gamemodeOf(level), levelNameOf(level), betaEnabled(level)]).toEqual(["survival", "Hi", false]);
    expect(gamemodeOf(parseLevelDat(serializeLevelDat(level)))).toBe("survival");

    expect(await enableBetaApis(storage, "level.dat")).toBe(true);
    expect(await enableBetaApis(storage, "level.dat")).toBe(false);
    expect(await setGamemode(storage, "level.dat", "creative")).toBe(true);
    expect(await setGamemode(storage, "level.dat", "creative")).toBe(false);
    const updated = await readLevelDat(storage, "level.dat");
    expect([betaEnabled(updated), gamemodeOf(updated)]).toEqual([true, "creative"]);
    expect(await storage.exists("level.dat.backup")).toBe(true);
    expect(() => parseLevelDat(Buffer.alloc(3))).toThrow(/too short/);
  });
});

describe("layout detection", () => {
  it("detects a Bedrock server root with level-name and dev folders", async () => {
    writeFile(local("srv", "worlds", "Bedrock level", "level.dat"), "x");
    writeFile(local("srv", "behavior_packs", ".keep"), "");
    writeFile(local("srv", "development_resource_packs", ".keep"), "");
    writeFile(local("srv", "server.properties"), "# c\nlevel-name=Bedrock level\n");
    const target = await Target.open(new LocalStorage(local("srv")));
    expect(target.layout).toMatchObject({
      serverRoot: "",
      worldsDir: "worlds",
      bpDir: "behavior_packs",
      rpDir: "resource_packs",
      devRpDir: "development_resource_packs",
      devBpDir: null,
      levelName: "Bedrock level",
    });
    expect(await target.defaultWorld()).toBe("worlds/Bedrock level");
  });

  it("finds a server nested two folders down", async () => {
    writeFile(local("ftp", "home", "container", "worlds", "W", ".keep"), "");
    writeFile(local("ftp", "home", "container", "server.properties"), "level-name=W\n");
    writeFile(local("ftp", "logs", ".keep"), "");
    const target = await Target.open(new LocalStorage(local("ftp")));
    expect(target.layout.serverRoot).toBe("home/container");
    expect(await target.listWorlds()).toEqual(["home/container/worlds/W"]);
    expect(target.layout.notes.join()).toContain("home/container");
  });

  it("matches folder names case-insensitively", async () => {
    writeFile(local("srv", "Worlds", "A", ".keep"), "");
    writeFile(local("srv", "Behavior_Packs", ".keep"), "");
    const layout = await detectLayout(new LocalStorage(local("srv")));
    expect([layout.worldsDir, layout.bpDir]).toEqual(["Worlds", "Behavior_Packs"]);
  });

  it("uses sibling pack folders when pointed at the worlds folder", async () => {
    writeFile(local("srv", "worlds", "A", "level.dat"), "x");
    writeFile(local("srv", "behavior_packs", ".keep"), "");
    const target = await Target.open(new LocalStorage(local("srv", "worlds")));
    expect([target.layout.worldsDir, target.layout.bpDir, target.layout.rpDir]).toEqual(["", "../behavior_packs", null]);
    expect(await target.listWorlds()).toEqual(["A"]);
    expect(await target.installDir("A", "rp")).toBe("A/resource_packs");
  });

  it("treats a single world folder as its own server", async () => {
    writeFile(local("World", "level.dat"), "x");
    writeFile(local("World", "behavior_packs", ".keep"), "");
    const target = await Target.open(new LocalStorage(local("World")));
    expect(target.layout.singleWorld).toBe("");
    expect(await target.listWorlds()).toEqual([""]);
    expect(await target.installDir("", "bp")).toBe("behavior_packs");
    expect((await target.packDirs("")).map((d) => [d.path, d.scope])).toEqual([["behavior_packs", "world"]]);
  });

  it("falls back to default names in an empty folder", async () => {
    writeFile(local("empty", ".keep"), "");
    const target = await Target.open(new LocalStorage(local("empty")));
    expect(target.layout.worldsDir).toBe("worlds");
    expect(await target.listWorlds()).toEqual([]);
    expect(target.layout.notes).toContain("No worlds folder found yet");
  });

  it("applies overrides and install scope", async () => {
    writeFile(local("srv", "custom", "maps", "A", ".keep"), "");
    writeFile(local("srv", "a", "worlds", "X", ".keep"), "");
    const target = await Target.open(new LocalStorage(local("srv")), { worldsDir: "custom/maps", bpDir: "custom/bp", packScope: "world" });
    expect(await target.listWorlds()).toEqual(["custom/maps/A"]);
    expect(target.layout.bpDir).toBe("custom/bp");
    expect(await target.installDir("custom/maps/A", "bp")).toBe("custom/maps/A/behavior_packs");
    const rooted = await Target.open(new LocalStorage(local("srv")), { serverRoot: "a", packScope: "shared" });
    expect(await rooted.listWorlds()).toEqual(["a/worlds/X"]);
    expect(rooted.layoutInfo().worldsDir).toContain("worlds");
  });

  it("finds worlds by name ignoring hidden folders", async () => {
    writeFile(local("srv", "worlds", "Alpha", ".keep"), "");
    writeFile(local("srv", "worlds", ".hidden", ".keep"), "");
    writeFile(local("srv", "worlds", "__MACOSX", ".keep"), "");
    const target = await Target.open(new LocalStorage(local("srv")));
    expect(await target.listWorlds()).toEqual(["worlds/Alpha"]);
    expect(await target.findWorld("alpha")).toBe("worlds/Alpha");
    expect(await target.findWorld("missing")).toBeNull();
  });

  it("parses server.properties", () => {
    expect(parseServerProperties("a=1\n# x=2\nbad\nlevel-name = My World \n")).toEqual({ a: "1", "level-name": "My World" });
  });

  it("works the same over SFTP", async () => {
    const h = await makeStorage("sftp");
    try {
      writeFile(joinLocal(h.root, "home", "container", "worlds", "W", "level.dat"), "x");
      writeFile(joinLocal(h.root, "home", "container", "server.properties"), "level-name=W\n");
      const target = await Target.open(h.storage);
      expect(target.layout.serverRoot).toBe("home/container");
      expect(target.layoutInfo().bpDir).toBe("/home/container/behavior_packs");
    } finally {
      await h.close();
    }
  });
});

describe("pack index", () => {
  async function runTarget() {
    writeFile(local("run", "worlds", "W", ".keep"), "");
    writeFile(local("run", "behavior_packs", ".keep"), "");
    writeFile(local("run", "resource_packs", ".keep"), "");
    return Target.open(new LocalStorage(local("run")));
  }

  it("reads shared and world-local packs", async () => {
    writeManifest(local("run", "behavior_packs", "Shared-BP"), { name: "Shared" });
    writeManifest(local("run", "worlds", "W", "resource_packs", "Local-RP"), {
      uuid: "33333333-3333-3333-3333-333333333333",
      type: "resources",
      name: "Local",
    });
    const index = await PackIndex.build(await runTarget(), "worlds/W");
    expect(index.packs.map((p) => [p.name, p.scope, p.dirKind]).sort()).toEqual([
      ["Local", "world", "rp"],
      ["Shared", "shared", "bp"],
    ]);
    expect(index.find(PACK_UUID.toUpperCase())[0]?.path).toBe("behavior_packs/Shared-BP");
    expect(index.findVersion(PACK_UUID, [1, 0, 0], "bp")).toHaveLength(1);
    expect(index.problems).toEqual([]);
  });

  it("reports broken, partial, nested, misplaced and oddly cased packs", async () => {
    const bp = local("run", "behavior_packs");
    writeFile(joinLocal(bp, "empty-leftover", ".keep"), "");
    writeFile(joinLocal(bp, "half-upload", "textures", "a.png"), "x");
    writeFile(joinLocal(bp, "broken", "manifest.json"), "{ not json");
    writeFile(joinLocal(bp, "no-uuid", "manifest.json"), '{"header": {"name": "x"}}');
    writeManifest(joinLocal(bp, "Wrapper", "Real Pack"), { uuid: "44444444-4444-4444-4444-444444444444", name: "Nested" });
    writeManifest(joinLocal(bp, "Texture Pack"), { uuid: "55555555-5555-5555-5555-555555555555", type: "resources" });
    writeManifest(joinLocal(bp, "Cased"), { uuid: "66666666-6666-6666-6666-666666666666", name: "Cased", filename: "Manifest.json" });
    writeFile(joinLocal(bp, "misc", "docs", "readme.md"), "x");

    const index = await PackIndex.build(await runTarget(), "worlds/W");
    const kinds = index.problems.map((p) => p.kind).sort();
    // A case-sensitive file system (Linux, as on most servers) also sees the "Manifest.json" casing problem.
    const caseSensitive = !existsSync(joinLocal(bp, "Cased", "manifest.json"));
    expect(kinds).toEqual(["broken", "broken", ...(caseSensitive ? ["casing"] : []), "misplaced", "nested", "partial", "partial"]);
    expect(index.problems.find((p) => p.kind === "nested")?.fixable).toBe(true);
    expect(index.find("44444444-4444-4444-4444-444444444444")[0]?.nested).toBe(true);
    expect(index.find("66666666-6666-6666-6666-666666666666")[0]?.name).toBe("Cased");
    expect(index.notes.join()).toContain("misc is not a pack");
  });

  it("hides built-in game packs, uses folder names for translation keys, and ignores storage folders", async () => {
    const bp = local("run", "behavior_packs");
    for (const folder of ["vanilla", "vanilla_1.14", "vanilla_1.15"])
      writeManifest(joinLocal(bp, folder), { uuid: "fe9f8597-5454-481a-8730-8d070a8e2e58", name: "resourcePack.vanilla_server.name" });
    for (const folder of ["chemistry_1.21.30", "editor", "experimental_creator_cameras", "server_ui_library"]) {
      writeManifest(joinLocal(bp, folder), { uuid: `${folder.length}0000000-0000-0000-0000-000000000000`, type: "resources" });
    }
    writeManifest(joinLocal(bp, "My Addon"), { name: "pack.name" });
    for (let n = 0; n < 3; n++)
      writeManifest(local("run", "resource_packs", "old", `Origin${n}`), {
        uuid: `9999999${n}-0000-0000-0000-000000000000`,
        type: "resources",
      });

    const index = await PackIndex.build(await runTarget(), "worlds/W");
    expect(
      index.packs
        .filter((p) => p.builtin)
        .map((p) => p.path.split("/").pop())
        .sort(),
    ).toEqual([
      "chemistry_1.21.30",
      "editor",
      "experimental_creator_cameras",
      "server_ui_library",
      "vanilla",
      "vanilla_1.14",
      "vanilla_1.15",
    ]);
    expect(index.problems).toEqual([]);
    expect(index.find(PACK_UUID)[0]?.name).toBe("My Addon");
    expect(index.notes.join()).toContain("old holds 3 packs");
  });

  it("flags duplicate copies and supports in-memory updates", async () => {
    writeManifest(local("run", "behavior_packs", "Copy One"), { name: "Dup" });
    writeManifest(local("run", "behavior_packs", "Copy Two"), { name: "Dup" });
    const index = await PackIndex.build(await runTarget(), "worlds/W");
    expect(index.problems.map((p) => p.message)).toEqual(["'Dup' v1.0.0 is installed 2 times (Copy One, Copy Two)"]);
    index.remove("behavior_packs/Copy One");
    expect(index.packs).toHaveLength(1);
    expect(index.uuids()).toEqual(new Set([PACK_UUID]));
  });

  it("skips pack folders that do not exist", async () => {
    writeWorldJson(local("run", "worlds", "W", "world_behavior_packs.json"), []);
    writeFile(local("run2", "worlds", "W", ".keep"), "");
    const index = await PackIndex.build(await Target.open(new LocalStorage(local("run2"))), "worlds/W");
    expect(index.scannedDirs).toEqual([]);
  });
});
