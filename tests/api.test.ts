import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import yauzl from "yauzl";

import { ROUTES, TOKEN_HEADER } from "../src/shared/api";
import type { JobEvent, JobInfo } from "../src/shared/events";
import type { ConnectResult, InstallResult, UninstallResult, WorldPacksResult, WorldStatus } from "../src/shared/model";
import { buildPaths, ensureDirs } from "../src/server/app/paths";
import { createApp, safeRelative, windowsSafe, type App } from "../src/server/http/app";
import { CancelledError } from "../src/server/storage/errors";
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
    settings: { protocol: "local", host: "", port: null, username: "", root: server, tlsVerify: true },
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

  it("needs the token however the API path is spelled", async () => {
    const bare = (url: string, method: "GET" | "POST" = "GET") =>
      app.fastify.inject({ method, url, headers: { host: HOST }, ...(method === "POST" ? { payload: {} } : {}) });
    for (const url of ["/%61pi/state", "/a%70i/state", "/api%2Fstate"]) {
      const response = await bare(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.body, url).not.toContain('"connected"');
    }
    // Double-encoded: decodes once to "/%61pi/state", which is not an API path; it gets the UI page, not data.
    expect((await bare("/%2561pi/state")).body).not.toContain('"connected"');
    expect((await bare("/%61pi/disconnect", "POST")).statusCode).toBe(403);
    // A malformed escape is a client error, never a crash.
    expect((await bare("/%E0%A4%A")).statusCode).toBe(400);
    expect((await call("GET", "/x/%E0%A4%A")).statusCode).toBe(400);
  });

  it("refuses requests from other sites", async () => {
    expect((await call("GET", ROUTES.state, undefined, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await call("GET", ROUTES.state, undefined, { origin: "null" })).statusCode).toBe(403);
    expect((await call("GET", ROUTES.state, undefined, { origin: `http://${HOST}` })).statusCode).toBe(200);
  });

  it("cleans upload paths", () => {
    expect(safeRelative("a/b.txt")).toBe("a/b.txt");
    expect(safeRelative("../x")).toBeNull();
    expect(safeRelative("C:/x")).toBeNull();
    expect(safeRelative("")).toBeNull();
    expect(windowsSafe("CON", "win32")).toBe(false);
    expect(windowsSafe("nul.txt", "win32")).toBe(false);
    expect(windowsSafe("pack.", "win32")).toBe(false);
    expect(windowsSafe("console.json", "win32")).toBe(true);
    expect(windowsSafe("CON", "linux")).toBe(true);
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
    expect((await job(ROUTES.worldEdit, { world: "worlds/W", experiments: { gametest: true }, gamemode: "creative" })).status).toBe("done");
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
      settings: { protocol: "local", host: "", port: null, username: "", root: join(dir.path, "nope"), tlsVerify: true },
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
        new Promise((resolve, reject) => {
          release = () => resolve(null);
          j.signal.addEventListener("abort", () => reject(new CancelledError()));
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

  it("keeps a job that finished its work as done when the cancel comes too late", async () => {
    let finish!: () => void;
    const running = app.runner.start("late", "Late", (j) => new Promise((resolve) => (finish = () => resolve(j.signal.aborted))));
    app.runner.cancel(running.id);
    finish();
    await running.promise;
    expect(running.status).toBe("done");
    expect(running.result).toBe(true);
  });

  it("lists recent jobs and serves a job's log as text", async () => {
    const connected = await connectLocal();
    const list = (await call("GET", ROUTES.jobs)).json().jobs as JobInfo[];
    expect(list[0]).toMatchObject({ id: connected.id, kind: "connect", status: "done" });
    expect(list[0]).not.toHaveProperty("result");
    const log = await call("GET", ROUTES.jobLog(connected.id));
    expect(log.headers["content-type"]).toContain("text/plain");
    expect(log.body).toContain("[OK] Connected");
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
      settings: { protocol: "sftp", host: "h", port: 22, username: "u", root: "", password: "secret", tlsVerify: true },
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

  it("stores only known settings and keeps a damaged profiles file aside", async () => {
    await call("POST", ROUTES.profiles, {
      name: "Odd",
      settings: { protocol: "ftp", host: "h", port: "21", username: "u", root: "", tlsVerify: true, keyPassphrase: "pp", extra: "x" },
      layout: {},
    });
    const stored = readFileSync(join(dir.path, "run", "profiles.json"), "utf8");
    expect(stored).not.toContain("extra");
    expect(stored).not.toContain("pp");
    writeFile(join(dir.path, "run", "profiles.json"), "{ not json");
    expect((await call("GET", ROUTES.profiles)).json().profiles).toEqual([]);
    expect(readdirSync(join(dir.path, "run")).some((name) => name.startsWith("profiles.json.corrupt-"))).toBe(true);
  });
});

describe("worlds, packs and server settings", () => {
  it("only accepts worlds the layout knows", async () => {
    await connectLocal();
    for (const world of ["", "/", "../..", "worlds", server]) {
      expect((await job(ROUTES.status, { world })).errorCode, world).toBe("world_missing");
    }
    // A world created after connecting is found by a fresh scan.
    writeFile(join(server, "worlds", "New", "level.dat"), levelDatBytes({ GameType: { type: "int", value: 0 } }));
    expect((await job(ROUTES.status, { world: "worlds/New" })).status).toBe("done");
  });

  it("registers, reorders and picks subpacks through world-packs", async () => {
    await connectLocal();
    const rpA = "aaaaaaaa-0000-0000-0000-00000000000a";
    const rpB = "bbbbbbbb-0000-0000-0000-00000000000b";
    writeManifest(join(server, "resource_packs", "A"), { uuid: rpA, type: "resources", name: "Pack A" });
    writeFile(
      join(server, "resource_packs", "B", "manifest.json"),
      JSON.stringify({
        format_version: 2,
        header: { name: "Pack B", uuid: rpB, version: [1, 0, 0] },
        modules: [{ type: "resources", uuid: "cccccccc-0000-0000-0000-00000000000c", version: [1, 0, 0] }],
        subpacks: [{ folder_name: "high", name: "High" }],
      }),
    );
    const registered = await job<WorldPacksResult>(ROUTES.worldPacks, {
      world: "worlds/W",
      changes: [
        { type: "register", kind: "rp", uuid: rpA, version: [1, 0, 0] },
        { type: "register", kind: "rp", uuid: rpB, version: [1, 0, 0] },
        { type: "order", kind: "rp", uuids: [rpB] },
        { type: "subpack", uuid: rpB, subpack: "high" },
      ],
    });
    expect(registered.status, registered.error).toBe("done");
    const json = JSON.parse(readFileSync(join(server, "worlds", "W", "world_resource_packs.json"), "utf8"));
    expect(json).toEqual([
      { pack_id: rpB, version: [1, 0, 0], subpack: "high" },
      { pack_id: rpA, version: [1, 0, 0] },
    ]);
    const rows = registered.result.status.packs.filter((row) => row.kind === "rp");
    expect(rows.map((row) => [row.name, row.order, row.subpack])).toEqual([
      ["Pack B", 0, "high"],
      ["Pack A", 1, null],
    ]);
    expect(rows[0]?.subpacks).toEqual([{ folder: "high", name: "High" }]);
    expect((await call("POST", ROUTES.worldPacks, { world: "worlds/W", changes: [{ type: "bogus" }] })).statusCode).toBe(400);
  });

  it("sets texturepack-required in server.properties and keeps the rest", async () => {
    writeFile(join(server, "server.properties"), "# comment\nlevel-name=W\ntexturepack-required=false\n");
    const connected = await connectLocal();
    expect(connected.result.layout.texturepackRequired).toBe(false);
    const saved = await job<ConnectResult>(ROUTES.serverProperties, { texturepackRequired: true });
    expect(saved.status).toBe("done");
    expect(saved.result.layout.texturepackRequired).toBe(true);
    expect(readFileSync(join(server, "server.properties"), "utf8")).toBe("# comment\nlevel-name=W\ntexturepack-required=true\n");
    expect((await call("POST", ROUTES.serverProperties, { texturepackRequired: "yes" })).statusCode).toBe(400);
  });

  it("browses folders and serves pack icons only from pack folders", async () => {
    await connectLocal();
    const browse = (await call("GET", `${ROUTES.browse}?path=${encodeURIComponent(server)}`)).json();
    expect(browse.dirs).toEqual(expect.arrayContaining(["behavior_packs", "resource_packs", "worlds"]));
    expect((await call("GET", `${ROUTES.browse}?path=${encodeURIComponent(join(server, "nope"))}`)).statusCode).toBe(404);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
    writeManifest(join(server, "behavior_packs", "Icon"));
    writeFile(join(server, "behavior_packs", "Icon", "pack_icon.png"), png);
    writeFile(join(server, "pack_icon.png"), png);
    // Pack paths are storage paths, as the status rows report them.
    const icon = await call("GET", `${ROUTES.packIcon}?path=${encodeURIComponent("behavior_packs/Icon")}`);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    writeManifest(join(server, "behavior_packs", "NoIcon"));
    expect((await call("GET", `${ROUTES.packIcon}?path=${encodeURIComponent("behavior_packs/NoIcon")}`)).statusCode).toBe(204);
    for (const path of ["", ".", "behavior_packs", "behavior_packs/../..", "/etc"])
      expect((await call("GET", `${ROUTES.packIcon}?path=${encodeURIComponent(path)}`)).statusCode, path).toBe(400);
  });

  it("lists and forgets trusted host keys", async () => {
    writeFile(
      join(dir.path, "run", "known_hosts"),
      `[h.example]:2022 ssh-ed25519 ${Buffer.from("key").toString("base64")}\nother ssh-rsa AAAA\n`,
    );
    const hosts = (await call("GET", ROUTES.knownHosts)).json().hosts;
    expect(hosts).toEqual([
      { host: "h.example", port: 2022, keyType: "ssh-ed25519", fingerprint: fingerprintOf(Buffer.from("key")) },
      expect.objectContaining({ host: "other", port: 22 }),
    ]);
    const forgot = (await call("DELETE", `${ROUTES.knownHosts}?host=h.example&port=2022`)).json();
    expect(forgot.removed).toBe(1);
    expect(forgot.hosts.map((host: { host: string }) => host.host)).toEqual(["other"]);
  });
});
