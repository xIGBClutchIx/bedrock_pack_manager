import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import yauzl from "yauzl";

import { ROUTES, TOKEN_HEADER } from "../src/shared/api";
import type { JobEvent, JobInfo } from "../src/shared/events";
import type { ConnectResult, InstallResult, UninstallResult, WorldStatus } from "../src/shared/model";
import { buildPaths, ensureDirs } from "../src/server/app/paths";
import { createApp, safeRelative, type App } from "../src/server/http/app";
import { fingerprintOf } from "../src/server/storage/knownHosts";
import { FIXTURES, levelDatBytes, tempDir, writeFile, writeManifest } from "./helpers";
import { startSftpServer } from "./servers/sftpServer";

const HOST = "127.0.0.1:4321";

let dir: ReturnType<typeof tempDir>;
let app: App;
let server: string;

beforeEach(async () => {
  dir = tempDir();
  const paths = buildPaths(join(dir.path, "run"));
  ensureDirs(paths);
  writeFile(join(dir.path, "web", "index.html"), "<!doctype html><title>Bedrock Pack Manager</title>");
  writeFile(join(dir.path, "web", "assets", "app.js"), "console.log(1)");
  app = createApp({ paths, webDir: join(dir.path, "web") });
  app.setPort(4321);
  server = join(dir.path, "server");
  writeFile(join(server, "worlds", "W", "level.dat"), levelDatBytes({ GameType: { type: "int", value: 0 } }));
  writeFile(join(server, "server.properties"), "level-name=W\n");
  writeFile(join(server, "behavior_packs", ".keep"), "");
  writeFile(join(server, "resource_packs", ".keep"), "");
});
afterEach(async () => {
  await app.session.disconnect();
  await app.fastify.close();
  dir.cleanup();
});

async function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const isBuffer = Buffer.isBuffer(payload);
  return app.fastify.inject({
    method,
    url,
    headers: { host: HOST, [TOKEN_HEADER]: app.token, ...(isBuffer ? { "content-type": "application/octet-stream" } : {}), ...headers },
    ...(payload === undefined ? {} : isBuffer ? { payload } : { payload: payload as object }),
  });
}

async function job<T = unknown>(url: string, payload: unknown): Promise<JobInfo & { result: T }> {
  const response = await call("POST", url, payload);
  expect(response.statusCode, response.body).toBe(202);
  const id = response.json().job as string;
  await app.runner.get(id)!.promise;
  return (await call("GET", ROUTES.job(id))).json();
}

const connectLocal = () =>
  job<ConnectResult>(ROUTES.connect, {
    settings: { protocol: "local", host: "", port: null, username: "", root: server, tlsVerify: true, passive: true },
    layout: { packScope: "shared" },
  });

describe("security", () => {
  it("needs the token and a loopback Host", async () => {
    expect((await call("GET", ROUTES.state, undefined, { [TOKEN_HEADER]: "" })).statusCode).toBe(403);
    expect((await call("GET", ROUTES.state, undefined, { host: "evil.example" })).statusCode).toBe(403);
    expect((await app.fastify.inject({ method: "GET", url: `${ROUTES.state}?t=${app.token}`, headers: { host: HOST } })).statusCode).toBe(
      200,
    );
    const page = await app.fastify.inject({ method: "GET", url: "/", headers: { host: HOST } });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(
      (await app.fastify.inject({ method: "GET", url: "/assets/app.js", headers: { host: HOST } })).headers["cache-control"],
    ).toContain("immutable");
    expect((await app.fastify.inject({ method: "GET", url: "/some/route", headers: { host: HOST } })).body).toContain(
      "Bedrock Pack Manager",
    );
    writeFile(join(dir.path, "secret.txt"), "secret");
    const escape = await app.fastify.inject({ method: "GET", url: "/../secret.txt", headers: { host: HOST } });
    expect(escape.body).not.toContain("secret");
  });

  it("cleans upload paths", () => {
    expect(safeRelative("a/b.txt")).toBe("a/b.txt");
    expect(safeRelative("../x")).toBeNull();
    expect(safeRelative("C:/x")).toBeNull();
    expect(safeRelative("")).toBeNull();
  });
});

describe("connect and world flow", () => {
  it("connects, installs, reads status, uninstalls and backs up", async () => {
    const connected = await connectLocal();
    expect(connected.status).toBe("done");
    expect(connected.result.defaultWorld).toBe("worlds/W");

    const state = (await call("GET", ROUTES.state)).json();
    expect(state).toMatchObject({ connected: true, defaultWorld: "worlds/W" });
    expect(state.settings.password).toBeUndefined();

    expect(
      (await call("PUT", `${ROUTES.uploads}?path=addon.mcaddon`, readFileSync(join(FIXTURES, "installed", "addon.mcaddon")))).statusCode,
    ).toBe(200);
    expect((await call("PUT", `${ROUTES.uploads}?path=Folder%20Pack/sub/manifest.json`, Buffer.from("{}"))).statusCode).toBe(200);
    expect((await call("PUT", `${ROUTES.uploads}?path=..%2Fescape.txt`, Buffer.from("x"))).statusCode).toBe(400);
    expect((await call("PUT", `${ROUTES.uploads}?path=Folder%20Pack/__MACOSX/x`, Buffer.from("x"))).json().skipped).toBe(true);
    expect((await call("GET", ROUTES.uploads)).json().uploads.map((u: { name: string; isDir: boolean }) => [u.name, u.isDir])).toEqual([
      ["addon.mcaddon", false],
      ["Folder Pack", true],
    ]);
    await call("DELETE", `${ROUTES.uploads}?name=Folder%20Pack`);

    const preview = await job<InstallResult>(ROUTES.install, {
      world: "worlds/W",
      duplicateMode: "replace",
      reupload: false,
      dryRun: true,
    });
    expect(preview.result.plan.map((item) => item.action)).toEqual(["upload", "upload"]);
    expect(existsSync(join(server, "behavior_packs", "Addon BP-BP"))).toBe(false);

    const installed = await job<InstallResult>(ROUTES.install, {
      world: "worlds/W",
      duplicateMode: "replace",
      reupload: false,
      dryRun: false,
    });
    expect(installed.result.stats.installed).toBe(2);
    expect(installed.result.status?.packs.every((row) => row.status === "ok")).toBe(true);
    expect((await call("GET", ROUTES.uploads)).json().uploads).toEqual([]);
    expect((await call("GET", ROUTES.state)).json().worlds[0]).toMatchObject({ bpCount: 1, rpCount: 1 });

    const status = await job<WorldStatus>(ROUTES.status, { world: "worlds/W", refreshWorlds: true });
    const bpKey = status.result.packs.find((row) => row.kind === "bp")!.key;
    const removed = await job<UninstallResult>(ROUTES.uninstall, { world: "worlds/W", keys: [bpKey], keepFiles: false });
    expect(removed.result.removed).toBe(1);
    expect(existsSync(join(server, "behavior_packs", "Addon BP-BP"))).toBe(false);

    const backup = await call("GET", `${ROUTES.backup}?world=worlds/W`);
    expect(backup.statusCode).toBe(200);
    expect(backup.headers["content-type"]).toBe("application/zip");
    const names = await new Promise<string[]>((resolve, reject) =>
      yauzl.fromBuffer(backup.rawPayload, {}, (error, file) => {
        if (error || !file) return reject(error);
        const out: string[] = [];
        file.on("entry", (entry: yauzl.Entry) => out.push(entry.fileName));
        file.on("end", () => resolve(out));
      }),
    );
    expect(names).toContain("worlds/W/level.dat");

    expect((await call("POST", ROUTES.disconnect, {})).json()).toEqual({ ok: true });
    expect((await call("GET", ROUTES.state)).json().connected).toBe(false);
  });

  it("streams job events over SSE, replaying from any point", async () => {
    const connected = await connectLocal();
    const events = (await call("GET", `${ROUTES.jobEvents(connected.id)}?since=1`)).body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")) as JobEvent);
    expect(events[0]?.seq).toBe(1);
    expect(events.at(-1)?.type).toBe("end");
    expect(events.some((event) => event.type === "log" && event.level === "ok")).toBe(true);
  });

  it("edits the world, previews cleanup, audits and rebuilds", async () => {
    await connectLocal();
    writeManifest(join(server, "behavior_packs", "Unused"), { uuid: "33333333-3333-3333-3333-333333333333" });
    expect((await job(ROUTES.worldEdit, { world: "worlds/W", beta: true, gamemode: "creative" })).status).toBe("done");
    const cleanup = await job<{ deleted: string[] }>(ROUTES.cleanup, { world: "worlds/W", dryRun: true });
    expect(cleanup.result.deleted).toHaveLength(1);
    const audit = await job<WorldStatus>(ROUTES.audit, { world: "worlds/W" });
    expect(audit.result.level).toMatchObject({ beta: true, gamemode: "creative" });
    expect(audit.warnings.join()).toContain("not registered");
    expect((await job(ROUTES.rebuild, { world: "worlds/W" })).status).toBe("done");
    expect(JSON.parse(readFileSync(join(server, "worlds", "W", "world_behavior_packs.json"), "utf8"))).toHaveLength(1);
  });

  it("explains errors with codes", async () => {
    expect((await call("POST", ROUTES.status, { world: "worlds/W" })).json().code).toBe("not_connected");
    const failed = await job(ROUTES.connect, {
      settings: { protocol: "local", host: "", port: null, username: "", root: join(dir.path, "nope"), tlsVerify: true, passive: true },
      layout: {},
    });
    expect(failed.errorCode).toBe("connect_failed");
    await connectLocal();
    expect((await call("POST", ROUTES.install, { world: "worlds/W", dryRun: true })).json().code).toBe("no_uploads");
    expect((await job(ROUTES.status, { world: "worlds/Nope" })).errorCode).toBe("world_missing");
    expect((await call("POST", ROUTES.uninstall, { world: "worlds/W", keys: [] })).json().code).toBe("nothing_selected");
    expect((await job(ROUTES.uninstall, { world: "worlds/W", keys: ["bp:x:1"], keepFiles: false })).errorCode).toBe("nothing_selected");
    expect((await call("POST", ROUTES.worldEdit, { world: "worlds/W", gamemode: "spectator" })).statusCode).toBe(400);
  });

  it("reports busy and supports cancelling", async () => {
    await connectLocal();
    let release!: () => void;
    const running = app.runner.start(
      "slow",
      "Slow",
      (j) =>
        new Promise((resolve) => {
          release = () => resolve(null);
          j.signal.addEventListener("abort", () => resolve(null));
        }),
    );
    const busy = await call("POST", ROUTES.status, { world: "worlds/W" });
    expect(busy.statusCode).toBe(409);
    expect((await call("POST", ROUTES.disconnect, {})).statusCode).toBe(409);
    expect((await call("POST", ROUTES.jobCancel(running.id), {})).json()).toEqual({ cancelled: true });
    await running.promise;
    expect(running.status).toBe("cancelled");
    release();
  });
});

describe("sftp through the API", () => {
  it("asks the UI to confirm an unknown host key, then connects once trusted", async () => {
    const sftp = await startSftpServer(server);
    try {
      const settings = {
        protocol: "sftp",
        host: sftp.host,
        port: sftp.port,
        username: sftp.username,
        password: sftp.password,
        root: "/",
        tlsVerify: true,
        passive: true,
      };
      const first = await job(ROUTES.connect, { settings, layout: {} });
      expect(first.errorCode).toBe("unknown_host_key");
      expect(first.errorData?.fingerprint).toBe(fingerprintOf(sftp.hostKey));
      const second = await job<ConnectResult>(ROUTES.connect, {
        settings: { ...settings, trustedFingerprint: first.errorData?.fingerprint },
        layout: {},
      });
      expect(second.status).toBe("done");
      expect(second.result.worlds.map((w) => w.name)).toEqual(["W"]);
      expect(readFileSync(join(dir.path, "run", "known_hosts"), "utf8")).toContain(sftp.hostKey.toString("base64"));
    } finally {
      await app.session.disconnect();
      await sftp.close();
    }
  });

  it("lets a new connect replace one stuck on an unresponsive server", async () => {
    const sftp = await startSftpServer(server, { ignoreSessions: true });
    try {
      const settings = {
        protocol: "sftp",
        host: sftp.host,
        port: sftp.port,
        username: sftp.username,
        password: sftp.password,
        trustedFingerprint: fingerprintOf(sftp.hostKey),
        root: "/",
        tlsVerify: true,
        passive: true,
      };
      const response = await call("POST", ROUTES.connect, { settings, layout: {} });
      const stuck = app.runner.get(response.json().job as string)!;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stuck.status).toBe("running");

      const replaced = await connectLocal();
      expect(replaced.status).toBe("done");
      expect(stuck.status).toBe("cancelled");
      expect((await call("GET", ROUTES.state)).json().connected).toBe(true);
    } finally {
      await app.session.disconnect();
      await sftp.close();
    }
  });
});

describe("profiles", () => {
  it("saves without secrets and deletes", async () => {
    const saved = await call("POST", ROUTES.profiles, {
      name: "Main",
      settings: { protocol: "sftp", host: "h", port: 22, username: "u", root: "", password: "secret", tlsVerify: true, passive: true },
      layout: { worldsDir: "w" },
    });
    expect(saved.json().profiles[0]).toMatchObject({
      name: "Main",
      settings: { host: "h" },
      layout: { worldsDir: "w", packScope: "shared" },
    });
    expect(readFileSync(join(dir.path, "run", "profiles.json"), "utf8")).not.toContain("secret");
    expect((await call("POST", ROUTES.profiles, { name: "" })).statusCode).toBe(400);
    expect((await call("DELETE", `${ROUTES.profiles}?name=Main`)).json().profiles).toEqual([]);
  });
});
