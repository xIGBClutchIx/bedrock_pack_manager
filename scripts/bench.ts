/**
 * Speed check over SFTP with artificial latency on every request (open, read, close... each pays it).
 * Usage: `npm run bench [-- <latencyMs>]` (default 40 ms, matching the Python benchmark).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runUninstall } from "../src/server/core/commands/uninstall";
import { worldStatus, worldSummaries } from "../src/server/core/commands/status";
import { runInstall } from "../src/server/core/install";
import { Target } from "../src/server/core/layout";
import { MemoryLog } from "../src/server/core/log";
import { fingerprintOf } from "../src/server/storage/knownHosts";
import { SftpStorage } from "../src/server/storage/sftp";
import { tempDir, writeManifest } from "../tests/helpers";
import { startSftpServer } from "../tests/servers/sftpServer";

const latency = Number(process.argv[2] ?? 40);
const dir = tempDir("bpm-bench-");
const srv = join(dir.path, "srv");

for (const world of ["Bedrock level", "Creative", "Test"]) {
  mkdirSync(join(srv, "worlds", world, "db"), { recursive: true });
  writeFileSync(join(srv, "worlds", world, "level.dat"), Buffer.alloc(100));
  writeFileSync(
    join(srv, "worlds", world, "world_behavior_packs.json"),
    JSON.stringify(
      Array.from({ length: 8 }, (_v, j) => ({
        pack_id: `0000${String(j).padStart(4, "0")}-0000-0000-0000-000000000000`,
        version: [1, 0, 0],
      })),
    ),
  );
}
writeFileSync(join(srv, "server.properties"), "level-name=Bedrock level\n");
for (let j = 0; j < 30; j++)
  writeManifest(join(srv, "behavior_packs", `vanilla_1.${j}`), { uuid: `fe9f8597-5454-481a-8730-8d070a8e${String(j).padStart(4, "0")}` });
for (let j = 0; j < 15; j++) {
  writeManifest(join(srv, "behavior_packs", `Addon ${j}`), {
    uuid: `0000${String(j).padStart(4, "0")}-0000-0000-0000-000000000000`,
    name: `Addon ${j}`,
  });
  writeManifest(join(srv, "resource_packs", `Addon ${j} RP`), {
    uuid: `1111${String(j).padStart(4, "0")}-0000-0000-0000-000000000000`,
    name: `Addon ${j} RP`,
    type: "resources",
  });
}
const big = join(dir.path, "upload", "Big Pack");
writeManifest(big, { uuid: "22220000-0000-0000-0000-000000000000", name: "Big Pack", type: "resources" });
for (let k = 0; k < 200; k++) {
  mkdirSync(join(big, "textures", `dir${k % 10}`), { recursive: true });
  writeFileSync(join(big, "textures", `dir${k % 10}`, `t${k}.png`), Buffer.alloc(2000, k));
}

const server = await startSftpServer(srv, { latencyMs: latency });
const storage = await SftpStorage.connect({
  host: server.host,
  port: server.port,
  username: "mc",
  password: "pw",
  root: "/",
  trustedFingerprint: fingerprintOf(server.hostKey),
});

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  server.requests.clear();
  storage.clearCache();
  const start = performance.now();
  const result = await fn();
  const seconds = (performance.now() - start) / 1000;
  const requests = [...server.requests.values()].reduce((sum, n) => sum + n, 0);
  console.log(
    `${label.padEnd(28)} ${seconds.toFixed(2).padStart(6)}s  ${String(requests).padStart(5)} SFTP requests  ${JSON.stringify(Object.fromEntries(server.requests))}`,
  );
  return result;
}

console.log(`SFTP with ${latency} ms added to every request\n`);
const target = await timed("connect (detect layout)", () => Target.open(storage));
await timed("world list + details", () => worldSummaries(target));
await timed("world status", () => worldStatus(target, "worlds/Bedrock level"));
const ctx = { target, log: new MemoryLog(), scratchDir: join(dir.path, "scratch") };
await timed("install 200-file pack", () =>
  runInstall(ctx, { world: "worlds/Bedrock level", sources: [big], duplicateMode: "replace", reupload: false, dryRun: false }),
);
const key = (await worldStatus(target, "worlds/Bedrock level")).packs.find((row) => row.name === "Big Pack")!.key;
await timed("uninstall 200-file pack", () => runUninstall({ ...ctx, log: new MemoryLog() }, "worlds/Bedrock level", [key], false));

await storage.close();
await server.close();
dir.cleanup();
