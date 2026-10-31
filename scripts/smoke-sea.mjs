// Smoke-test a built single executable: start it, fetch the UI and one built asset, check the API
// still wants the token, then stop it. Usage: node scripts/smoke-sea.mjs [path-to-exe] [port]
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] ?? join("dist", process.platform === "win32" ? "bedrock-pack-manager.exe" : "bedrock-pack-manager"));
const port = Number(process.argv[3] ?? process.env.SMOKE_PORT ?? 39217);
const base = `http://127.0.0.1:${port}`;

const fail = (message) => {
  throw new Error(message);
};

console.log(execFileSync(exe, ["--help"], { encoding: "utf8" }).trim());

const dataDir = mkdtempSync(join(tmpdir(), "bpm-smoke-"));
const child = spawn(exe, ["--no-browser", "--port", String(port), "--data-dir", dataDir], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) fail(`exe exited early (${JSON.stringify(exited)})`);
    try {
      return await fetch(`${base}/`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  fail("exe did not start listening within 30s");
}

try {
  const index = await waitForServer();
  const html = await index.text();
  if (index.status !== 200) fail(`GET / returned ${index.status}`);
  if (!index.headers.get("content-type")?.startsWith("text/html")) fail(`GET / content-type ${index.headers.get("content-type")}`);
  if (!index.headers.get("content-security-policy")) fail("GET / has no Content-Security-Policy header");
  console.log(`GET / -> ${index.status} ${index.headers.get("content-type")} (${html.length} bytes)`);

  const asset = html.match(/(?:src|href)="\/?(assets\/[^"]+\.js)"/)?.[1] ?? fail("index.html references no assets/*.js file");
  const script = await fetch(`${base}/${asset}`);
  const body = await script.arrayBuffer();
  if (script.status !== 200 || body.byteLength === 0) fail(`GET /${asset} returned ${script.status} (${body.byteLength} bytes)`);
  if (!script.headers.get("content-type")?.includes("javascript")) fail(`GET /${asset} content-type ${script.headers.get("content-type")}`);
  console.log(`GET /${asset} -> ${script.status} ${script.headers.get("content-type")} (${body.byteLength} bytes)`);

  const api = await fetch(`${base}/api/state`);
  await api.arrayBuffer();
  if (api.status !== 403) fail(`GET /api/state without a token returned ${api.status}, expected 403`);
  console.log(`GET /api/state without token -> ${api.status}`);

  console.log("Smoke test passed.");
} catch (error) {
  console.error(`Smoke test failed: ${error.message}\n--- exe output ---\n${output}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => (exited ? r() : child.once("exit", r)));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
