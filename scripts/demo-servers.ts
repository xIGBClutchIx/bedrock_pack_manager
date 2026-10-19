/**
 * Local SFTP and FTP servers holding a deliberately messy Bedrock server, for trying the UI and for
 * end-to-end tests. Usage: `npx tsx scripts/demo-servers.ts [folder]` (user mc, password pw).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startFtpServer } from "../tests/servers/ftpServer";
import { startSftpServer } from "../tests/servers/sftpServer";
import { levelDatBytes } from "../tests/helpers";

const root = process.argv[2] ?? join(tmpdir(), "bpm-demo-server");
const server = join(root, "home", "container");

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function manifest(folder: string, uuid: string, name: string, type = "data", version = [1, 0, 0]): void {
  write(
    join(folder, "manifest.json"),
    JSON.stringify({ format_version: 2, header: { name, uuid, version }, modules: [{ type, uuid, version }] }),
  );
}

rmSync(root, { recursive: true, force: true });
write(join(server, "server.properties"), "level-name=Survival SMP\n");
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
const bp = join(server, "behavior_packs");
const rp = join(server, "resource_packs");
manifest(join(bp, "Good BP"), "11111111-0000-0000-0000-000000000001", "Good Pack");
manifest(join(bp, "Wrapper", "Inner BP"), "33333333-0000-0000-0000-000000000003", "Nested Pack");
mkdirSync(join(bp, "half-upload", "textures"), { recursive: true });
for (const folder of ["vanilla", "vanilla_1.20", "chemistry", "editor", "server_library"])
  manifest(join(bp, folder), `fe9f8597-0000-0000-0000-${folder.length.toString().padStart(12, "0")}`, "pack.name");
manifest(join(rp, "Unused RP"), "22222222-0000-0000-0000-000000000002", "Unused Textures", "resources");
for (let index = 0; index < 4; index++)
  manifest(join(rp, "old", `Origin ${index}`), `9999999${index}-0000-0000-0000-000000000000`, `Origin ${index}`, "resources");

const sftp = await startSftpServer(root, { latencyMs: Number(process.env.BPM_DEMO_LATENCY ?? 0) });
const ftp = await startFtpServer(root);
console.log(`Demo server files: ${root}`);
console.log(`SFTP: host 127.0.0.1 port ${sftp.port} user mc password pw`);
console.log(`FTP:  host 127.0.0.1 port ${ftp.port} user mc password pw`);
console.log("Press Ctrl+C to stop.");
