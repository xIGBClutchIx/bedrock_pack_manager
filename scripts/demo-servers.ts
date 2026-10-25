/**
 * Local SFTP and FTP servers holding a deliberately messy Bedrock server, for trying the UI and for
 * end-to-end tests. Usage: `npx tsx scripts/demo-servers.ts [folder]` (user mc, password pw).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TEST_SERVER } from "../src/shared/model";
import { startFtpServer } from "../tests/servers/ftpServer";
import { startSftpServer } from "../tests/servers/sftpServer";
import { levelDatBytes } from "../tests/helpers";

const root = process.argv[2] ?? join(tmpdir(), "bpm-demo-server");
const server = join(root, "home", "container");

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function manifest(
  folder: string,
  uuid: string,
  name: string,
  type = "data",
  version = [1, 0, 0],
  extra: Record<string, unknown> = {},
): void {
  const { description, ...rest } = extra;
  write(
    join(folder, "manifest.json"),
    JSON.stringify({ format_version: 2, header: { name, uuid, version, description }, modules: [{ type, uuid, version }], ...rest }),
  );
}

rmSync(root, { recursive: true, force: true });
write(join(server, "server.properties"), "level-name=Survival SMP\ntexturepack-required=false\n");
write(
  join(server, "worlds", "Survival SMP", "level.dat"),
  levelDatBytes({ GameType: { type: "int", value: 0 }, LevelName: { type: "string", value: "Survival SMP" } }),
);
write(join(server, "worlds", "Creative", "level.dat"), levelDatBytes({ GameType: { type: "int", value: 1 } }));
write(
  join(server, "worlds", "Survival SMP", "world_behavior_packs.json"),
  JSON.stringify([
    { pack_id: "11111111-0000-0000-0000-000000000001", version: [1, 0, 0] },
    { pack_id: "44444444-0000-0000-0000-000000000004", version: [2, 0, 0] },
  ]),
);
write(
  join(server, "worlds", "Survival SMP", "world_resource_packs.json"),
  JSON.stringify([{ pack_id: "55555555-0000-0000-0000-000000000005", version: [1, 0, 0], subpack: "x32" }]),
);
write(
  join(server, "worlds", "Creative", "world_behavior_packs.json"),
  JSON.stringify([{ pack_id: "11111111-0000-0000-0000-000000000001", version: [1, 0, 0] }]),
);
const bp = join(server, "behavior_packs");
const rp = join(server, "resource_packs");
const goodPack = {
  description: "Friendlier mobs and a few new items",
  metadata: { authors: ["Demo Studio"] },
  dependencies: [
    { uuid: "22222222-0000-0000-0000-000000000002", version: [1, 0, 0] },
    { module_name: "@minecraft/server", version: "1.12.0" },
  ],
};
manifest(join(bp, "Good BP"), "11111111-0000-0000-0000-000000000001", "Good Pack", "data", [1, 0, 0], goodPack);
manifest(join(bp, "Good BP v1.1"), "11111111-0000-0000-0000-000000000001", "Good Pack", "data", [1, 1, 0], goodPack);
manifest(join(rp, "Faithful"), "55555555-0000-0000-0000-000000000005", "Faithful Textures", "resources", [1, 0, 0], {
  description: "Sharper textures in three sizes",
  subpacks: [
    { folder_name: "x16", name: "16x (light)" },
    { folder_name: "x32", name: "32x" },
    { folder_name: "x64", name: "64x (heavy)" },
  ],
});
manifest(join(bp, "Wrapper", "Inner BP"), "33333333-0000-0000-0000-000000000003", "Nested Pack");
mkdirSync(join(bp, "half-upload", "textures"), { recursive: true });
for (const folder of ["vanilla", "vanilla_1.20", "chemistry", "editor", "server_library"])
  manifest(join(bp, folder), `fe9f8597-0000-0000-0000-${folder.length.toString().padStart(12, "0")}`, "pack.name");
manifest(join(rp, "Unused RP"), "22222222-0000-0000-0000-000000000002", "Unused Textures", "resources");
for (let index = 0; index < 4; index++)
  manifest(join(rp, "old", `Origin ${index}`), `9999999${index}-0000-0000-0000-000000000000`, `Origin ${index}`, "resources");

// Fixed ports and host key, so the app's Test server tab (--test-server) can connect in one click.
const sftp = await startSftpServer(root, {
  latencyMs: Number(process.env.BPM_DEMO_LATENCY ?? 0),
  port: Number(process.env.BPM_DEMO_SFTP_PORT ?? TEST_SERVER.sftpPort),
  hostKey: readFileSync(join(import.meta.dirname, "..", "tests", "servers", "demo-host-key")),
});
const ftp = await startFtpServer(root, { port: Number(process.env.BPM_DEMO_FTP_PORT ?? TEST_SERVER.ftpPort) });
console.log(`Demo server files: ${root}`);
console.log(`SFTP: host 127.0.0.1 port ${sftp.port} user mc password pw`);
console.log(`FTP:  host 127.0.0.1 port ${ftp.port} user mc password pw`);
console.log("In the app (npm run dev, or --test-server), pick Test server on the connect page.");
console.log("Press Ctrl+C to stop.");
