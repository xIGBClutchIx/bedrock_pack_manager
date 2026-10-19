// Build a single executable (Node SEA): the bundled server plus the built UI as embedded assets.
// Run `npm run build` first (or use `npm run build:sea`, which does both).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { inject } from "postject";

const dist = "dist";
const server = join(dist, "server.cjs");
const web = join(dist, "web");
if (!existsSync(server) || !existsSync(join(web, "index.html"))) {
  console.error("Missing dist/server.cjs or dist/web. Run `npm run build` first.");
  process.exit(1);
}

const files = (dir) =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
const assets = Object.fromEntries(files(web).map((file) => [`web/${relative(web, file).replaceAll("\\", "/")}`, file]));

const blob = join(dist, "sea-prep.blob");
const config = "sea-config.json";
writeFileSync(
  config,
  JSON.stringify(
    { main: server, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets },
    null,
    2,
  ),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

const exe = join(dist, process.platform === "win32" ? "bedrock-pack-manager.exe" : "bedrock-pack-manager");
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);

// The copied node binary is signed; injecting invalidates that, so drop the signature where tools exist.
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe]);
if (process.platform === "win32") {
  try {
    execFileSync("signtool", ["remove", "/s", exe], { stdio: "ignore" });
  } catch {
    // signtool is optional; the exe still runs unsigned.
  }
}

const { readFileSync } = await import("node:fs");
await inject(exe, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe]);

rmSync(config, { force: true });
rmSync(blob, { force: true });
console.log(`\nBuilt ${exe} (${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB) with ${Object.keys(assets).length} embedded UI files.`);
