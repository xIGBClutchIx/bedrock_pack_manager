import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join as joinLocal } from "node:path";

import { NotFoundError, StorageError } from "../src/server/storage/errors";
import { basename, join, parent, relative } from "../src/server/storage/path";
import { BACKENDS, makeStorage, tempDir, writeFile, type StorageHarness } from "./helpers";

describe("path helpers", () => {
  it("join normalises and handles absolute parts", () => {
    expect(join("worlds", "World")).toBe("worlds/World");
    expect(join("", "worlds")).toBe("worlds");
    expect(join()).toBe("");
    expect(join("a", "/abs/b")).toBe("/abs/b");
    expect(join("a/./b/../c")).toBe("a/c");
    expect(join("root", "C:\\Users\\me")).toBe("C:/Users/me");
    expect(join("C:")).toBe("C:/");
    expect(join("a/b/")).toBe("a/b");
    expect(join("/")).toBe("/");
  });

  it("parent, basename and relative", () => {
    expect(parent("worlds/World")).toBe("worlds");
    expect(parent("worlds")).toBe("");
    expect(parent("C:/x")).toBe("C:/");
    expect(basename("worlds/World/")).toBe("World");
    expect(relative("a/b", "a/b/c/d")).toBe("c/d");
    expect(relative("a/b", "a/bc")).toBeNull();
    expect(relative("", "x")).toBe("x");
  });
});

describe.each(BACKENDS)("%s storage", (backend) => {
  let h: StorageHarness;
  beforeEach(async () => {
    h = await makeStorage(backend);
  });
  afterEach(async () => {
    await h.close();
  });

  it("writes and reads files, creating folders and leaving no temp files", async () => {
    await h.storage.writeText("deep/nested/file.json", '{"a": 1}');
    expect(await h.storage.readText("deep/nested/file.json")).toBe('{"a": 1}');
    expect(readFileSync(joinLocal(h.root, "deep", "nested", "file.json"), "utf8")).toBe('{"a": 1}');
    expect(readdirSync(joinLocal(h.root, "deep", "nested"))).toEqual(["file.json"]);
  });

  it("atomic writes replace an existing file", async () => {
    await h.storage.writeText("file.txt", "old");
    await h.storage.writeText("file.txt", "new");
    expect(readFileSync(joinLocal(h.root, "file.txt"), "utf8")).toBe("new");
    expect(readdirSync(h.root)).toEqual(["file.txt"]);
  });

  it("reports missing files as NotFoundError", async () => {
    await expect(h.storage.readFile("nope.txt")).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.storage.listDir("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists, stats and finds children case-insensitively", async () => {
    mkdirSync(joinLocal(h.root, "Worlds", "A"), { recursive: true });
    writeFile(joinLocal(h.root, "file.txt"), "x");
    const entries = await h.storage.listDir("");
    expect(entries.map((e) => [e.name, e.isDir])).toEqual([
      ["file.txt", false],
      ["Worlds", true],
    ]);
    expect(await h.storage.isDir("Worlds")).toBe(true);
    expect(await h.storage.isFile("file.txt")).toBe(true);
    expect(await h.storage.exists("missing")).toBe(false);
    expect(await h.storage.stat("missing/deeper")).toBeNull();
    expect(await h.storage.findChild("", "worlds", "dir")).toBe("Worlds");
    expect(await h.storage.findChild("", "worlds", "file")).toBeNull();
    expect(await h.storage.findChild("missing", "x")).toBeNull();
  });

  it("mkdirs is idempotent", async () => {
    await h.storage.mkdirs("a/b/c");
    await h.storage.mkdirs("a/b/c");
    expect(existsSync(joinLocal(h.root, "a", "b", "c"))).toBe(true);
  });

  it("removes trees and refuses the root", async () => {
    writeFile(joinLocal(h.root, "pack", "sub", "f.txt"), "x");
    writeFile(joinLocal(h.root, "pack", "manifest.json"), "{}");
    await h.storage.removeTree("pack");
    await h.storage.removeTree("pack");
    expect(existsSync(joinLocal(h.root, "pack"))).toBe(false);
    await expect(h.storage.removeTree("")).rejects.toBeInstanceOf(StorageError);
  });

  it("renames and copies", async () => {
    await h.storage.writeText("a/one.txt", "1");
    await h.storage.rename("a", "b");
    await h.storage.copyFile("b/one.txt", "c/two.txt");
    expect(readFileSync(joinLocal(h.root, "b", "one.txt"), "utf8")).toBe("1");
    expect(readFileSync(joinLocal(h.root, "c", "two.txt"), "utf8")).toBe("1");
    expect(existsSync(joinLocal(h.root, "a"))).toBe(false);
  });

  it("uploads trees without junk or excluded folders, manifest last", async () => {
    const source = tempDir();
    try {
      const src = source.path;
      writeFile(joinLocal(src, "textures", "a.png"), "png");
      writeFile(joinLocal(src, "manifest.json"), "{}");
      writeFile(joinLocal(src, "__MACOSX", "junk"), "x");
      writeFile(joinLocal(src, ".DS_Store"), "x");
      writeFile(joinLocal(src, "inner_pack", "manifest.json"), "{}");
      const order: string[] = [];
      const count = await h.storage.uploadTree(src, "packs/Uploaded", {
        exclude: new Set([joinLocal(src, "inner_pack")]),
        onProgress: (_done, _total, path) => order.push(path),
      });
      expect(count).toBe(2);
      expect(order.at(-1)).toMatch(/manifest\.json$/);
      expect(readdirSync(joinLocal(h.root, "packs", "Uploaded")).sort()).toEqual(["manifest.json", "textures"]);
    } finally {
      source.cleanup();
    }
  });

  it("downloads files with relative paths and scans trees", async () => {
    writeFile(joinLocal(h.root, "w", "level.dat"), "L");
    writeFile(joinLocal(h.root, "w", "db", "CURRENT"), "C");
    const files: Record<string, string> = {};
    for await (const [path, data] of h.storage.downloadFiles("w")) files[path] = data.toString();
    expect(files).toEqual({ "level.dat": "L", "db/CURRENT": "C" });
    const tree = await h.storage.scanTree("w");
    expect(tree.dirs).toEqual(["w", "w/db"]);
    expect(tree.files.sort()).toEqual(["w/db/CURRENT", "w/level.dat"]);
  });

  it("reads many files at once, in order, with errors as values", async () => {
    for (let index = 0; index < 20; index++) writeFile(joinLocal(h.root, `f${index}.txt`), String(index));
    const paths = [...Array.from({ length: 20 }, (_v, index) => `f${index}.txt`), "missing.txt"];
    const results = await h.storage.readMany(paths);
    expect(paths.slice(0, 20).map((path) => (results.get(path) as Buffer).toString())).toEqual(
      Array.from({ length: 20 }, (_v, index) => String(index)),
    );
    expect(results.get("missing.txt")).toBeInstanceOf(NotFoundError);
  });

  it("keeps the listing cache fresh after writes", async () => {
    await h.storage.mkdirs("dir");
    expect(await h.storage.listDir("dir")).toEqual([]);
    await h.storage.writeText("dir/new.txt", "x");
    expect((await h.storage.listDir("dir")).map((e) => e.name)).toEqual(["new.txt"]);
  });

  it("stops bulk work when cancelled", async () => {
    for (let index = 0; index < 30; index++) writeFile(joinLocal(h.root, "many", `f${index}.txt`), "x");
    const controller = new AbortController();
    controller.abort();
    await expect(h.storage.scanTree("many", controller.signal)).rejects.toThrow("Cancelled");
  });

  it("describes paths as full server paths", () => {
    expect(h.storage.describe("worlds")).toContain("worlds");
    expect(basename(h.storage.describe("worlds"))).toBe("worlds");
  });
});
