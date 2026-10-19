/** Entry point: start the local web server and open the UI in the default browser. */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildPaths, ensureDirs, isSea } from "./app/paths";
import { RunLog } from "./app/logs";
import { createApp } from "./http/app";

const DEV_TOKEN = "dev-token";

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url.replaceAll("&", "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: process.platform === "win32" }).unref();
  } catch {
    // No browser available: the link is printed anyway.
  }
}

function readSeaAsset(path: string): Buffer | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require("node:sea") as { getAsset(key: string): ArrayBuffer };
    return Buffer.from(sea.getAsset(`web/${path}`));
  } catch {
    return null;
  }
}

/** The built UI next to the bundled server (dist/web), when not packaged. */
function webDirOnDisk(): string {
  const here = typeof __dirname === "string" ? __dirname : join(process.cwd(), "dist");
  return join(here, "web");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "0" },
      "no-browser": { type: "boolean", default: false },
      "data-dir": { type: "string" },
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Bedrock Pack Manager\n\nOptions:\n  --port <n>        Port to listen on (default: a free port)\n  --no-browser      Do not open the browser\n  --data-dir <dir>  Where to keep run data (default: run/ next to the app)",
    );
    return;
  }

  const paths = buildPaths(values["data-dir"]);
  ensureDirs(paths);
  rmSync(paths.unpackDir, { recursive: true, force: true });
  ensureDirs(paths);
  const runLog = new RunLog(paths.logsDir);

  const dev = values.dev;
  const app = createApp({
    paths,
    token: dev ? (process.env.BPM_DEV_TOKEN ?? DEV_TOKEN) : undefined,
    webDir: dev ? null : isSea() ? null : webDirOnDisk(),
    readAsset: isSea() ? readSeaAsset : undefined,
    extraHosts: dev ? ["localhost:5173", "127.0.0.1:5173"] : [],
    onLog: (level, text) => runLog.write(level, text),
  });

  await app.fastify.listen({ host: "127.0.0.1", port: Number(values.port) || 0 });
  const address = app.fastify.server.address();
  const port = typeof address === "object" && address ? address.port : Number(values.port);
  app.setPort(port);

  const url = dev ? `http://localhost:5173/?t=${app.token}` : `http://127.0.0.1:${port}/?t=${app.token}`;
  console.log(
    `\n  Bedrock Pack Manager is running at:\n\n    ${url}\n\n  Only this computer can reach it. Keep this window open; press Ctrl+C to stop.\n`,
  );
  runLog.write("plain", `Started on port ${port}`);
  if (!values["no-browser"]) openBrowser(url);

  const stop = async () => {
    await app.session.disconnect().catch(() => undefined);
    await app.fastify.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
