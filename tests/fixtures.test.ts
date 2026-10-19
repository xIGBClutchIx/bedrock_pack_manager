import { readFileSync } from "node:fs";
import { join } from "node:path";

import yauzl from "yauzl";

const FIXTURES = join(import.meta.dirname, "fixtures");

function zipEntries(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const entries = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

describe("fixtures", () => {
  it("pack.mcpack holds one resource pack", async () => {
    const entries = await zipEntries(join(FIXTURES, "installed", "pack.mcpack"));
    expect([...entries.keys()].sort()).toEqual(["manifest.json", "pack.txt", "textures/ui/.keep"]);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest.header.name).toBe("Pack");
    expect(manifest.modules[0].type).toBe("resources");
  });

  it("addon.mcaddon holds a behavior pack and a resource pack", async () => {
    const entries = await zipEntries(join(FIXTURES, "installed", "addon.mcaddon"));
    expect([...entries.keys()].sort()).toEqual([
      "bp/functions/.keep",
      "bp/manifest.json",
      "bp/notes.txt",
      "rp/manifest.json",
      "rp/notes.txt",
      "rp/textures/items/.keep",
    ]);
    expect(JSON.parse(entries.get("bp/manifest.json")!.toString()).header.uuid).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(JSON.parse(entries.get("rp/manifest.json")!.toString()).header.uuid).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
  });

  it("world JSONs reference the fixture packs", () => {
    const bp = JSON.parse(readFileSync(join(FIXTURES, "worlds", "World", "world_behavior_packs.json"), "utf8"));
    expect(bp).toEqual([{ pack_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", version: [1, 0, 0] }]);
  });
});
