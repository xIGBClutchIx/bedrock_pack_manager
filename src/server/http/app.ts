/**
 * The HTTP API and static UI. Bound to 127.0.0.1; every /api call needs the per-launch token and
 * a loopback Host header, so other websites open in the browser cannot drive it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type {
  AppStateResponse,
  CleanupRequest,
  ConnectRequest,
  FixNestingRequest,
  InstallRequest,
  LayoutRequest,
  SaveProfileRequest,
  ServerPropertiesRequest,
  StatusRequest,
  UninstallRequest,
  WorldEditRequest,
  WorldPacksRequest,
} from "../../shared/api";
import { ROUTES, TOKEN_HEADER } from "../../shared/api";
import { ERROR_CODES, type LogLevel } from "../../shared/events";
import type {
  BrowseResult,
  ConnectResult,
  DuplicateMode,
  Gamemode,
  LayoutOverrides,
  PackKind,
  UploadEntry,
  Version,
  WorldPackChange,
} from "../../shared/model";
import { GAMEMODES, PROTOCOLS, publicSettings } from "../../shared/model";
import type { AppPaths } from "../app/paths";
import { ProfileStore, cleanProfileSettings } from "../app/profiles";
import { backupFileName, runBackup } from "../core/commands/backup";
import { runAudit, runCleanup, runFixNesting, runRebuild } from "../core/commands/maintenance";
import { worldStatus } from "../core/commands/status";
import { runUninstall } from "../core/commands/uninstall";
import { runWorldEdit } from "../core/commands/worldEdit";
import { runWorldPacks } from "../core/commands/worldPacks";
import { runInstall, type CommandContext } from "../core/install";
import { setServerProperty } from "../core/layout";
import { warn } from "../core/log";
import { BusyError, JobFailure, JobRunner, type Job } from "../jobs/runner";
import { isNotFound } from "../storage/errors";
import { KnownHosts } from "../storage/knownHosts";
import { JUNK_NAMES, join as joinStorage, parent as parentStorage } from "../storage/path";
import { Session, mapJobError } from "./session";

export interface AppOptions {
  paths: AppPaths;
  token?: string;
  /** Folder with the built UI (index.html + assets). Omit to serve none (dev: Vite serves it). */
  webDir?: string | null;
  /** Read an embedded asset (single-file exe). */
  readAsset?: (path: string) => Buffer | null;
  /** Extra Host values to accept, e.g. the Vite dev server. */
  extraHosts?: string[];
  /** Mirror of every job log line, for run/logs. */
  onLog?: (level: LogLevel, text: string) => void;
  /** Offer the local demo server (`npm run demo`) on the connect page. */
  testServer?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  token: string;
  session: Session;
  runner: JobRunner;
  setPort(port: number): void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

/** A browser-supplied relative path, made safe, or null. */
export function safeRelative(path: string): string | null {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.includes(":") || part.includes("\0") || !windowsSafe(part))) return null;
  return parts.join("/");
}

/** Windows treats device names (CON, NUL.txt, COM1...) specially and silently drops trailing dots and spaces. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
export const windowsSafe = (part: string, platform: string = process.platform) =>
  platform !== "win32" || (!WINDOWS_DEVICE.test(part) && !/[. ]$/.test(part));

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** decodeURIComponent that answers null instead of throwing on a bad `%`. */
export function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Whether a request reaches the API, however its path is spelled. */
function isApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url ?? "";
  if (route.startsWith("/api/")) return true;
  const path = request.url.split("?")[0]!;
  // An undecodable path never reaches a route; treat it as API so it needs the token too.
  const decoded = safeDecode(path);
  return decoded === null || decoded.toLowerCase().startsWith("/api/") || path.toLowerCase().startsWith("/api/");
}

function cleanOverrides(raw: unknown): LayoutOverrides {
  const data = (raw ?? {}) as Record<string, unknown>;
  const pick = (key: string) => str(data[key]).trim() || undefined;
  return {
    serverRoot: pick("serverRoot"),
    worldsDir: pick("worldsDir"),
    bpDir: pick("bpDir"),
    rpDir: pick("rpDir"),
    packScope: data.packScope === "world" ? "world" : "shared",
  };
}

const isVersion = (value: unknown): value is Version =>
  Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "number" || typeof part === "string");
const isKind = (value: unknown): value is PackKind => value === "bp" || value === "rp";

/** Keep only well-formed world pack changes. */
export function cleanWorldPackChanges(raw: unknown): WorldPackChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: Record<string, unknown>): WorldPackChange[] => {
    const uuid = str(item?.uuid).trim();
    if (item?.type === "register" && isKind(item.kind) && uuid && isVersion(item.version)) {
      const worlds = Array.isArray(item.worlds) ? item.worlds.filter((world): world is string => typeof world === "string") : undefined;
      return [{ type: "register", kind: item.kind, uuid, version: item.version, ...(worlds?.length ? { worlds } : {}) }];
    }
    if (item?.type === "order" && isKind(item.kind) && Array.isArray(item.uuids))
      return [{ type: "order", kind: item.kind, uuids: item.uuids.filter((id): id is string => typeof id === "string") }];
    if (item?.type === "subpack" && uuid && (item.subpack === null || typeof item.subpack === "string"))
      return [{ type: "subpack", uuid, subpack: item.subpack ? String(item.subpack) : null }];
    return [];
  });
}

export function createApp(options: AppOptions): App {
  const { paths } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const session = new Session(paths);
  const runner = new JobRunner(options.onLog);
  const profiles = new ProfileStore(paths.profilesFile);
  const knownHosts = new KnownHosts(paths.knownHostsFile);
  const allowedHosts = new Set<string>(options.extraHosts ?? []);
  const fastify = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  const context = (job: Job): CommandContext => ({
    target: session.requireTarget(),
    log: job,
    signal: job.signal,
    scratchDir: paths.unpackDir,
  });

  // ---- guards -------------------------------------------------------------------------------------

  const tokenOk = (request: FastifyRequest) => {
    const supplied = Buffer.from(str(request.headers[TOKEN_HEADER]) || str((request.query as Record<string, unknown>)?.t));
    return supplied.length === tokenBytes.length && timingSafeEqual(supplied, tokenBytes);
  };

  fastify.addHook("onRequest", async (request, reply) => {
    const host = str(request.headers.host).toLowerCase();
    if (!allowedHosts.has(host)) return reply.code(403).send({ error: "Bad Host header", code: "bad_host" });
    // Browsers send Origin on cross-site requests; only our own pages may call in.
    const origin = str(request.headers.origin).toLowerCase();
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
      return reply.code(403).send({ error: "Cross-site request refused", code: "bad_origin" });
    }
    // Check the matched route as well as the decoded path: Fastify decodes "/%61pi/..." before routing.
    if (isApiRequest(request) && !tokenOk(request)) {
      return reply.code(403).send({ error: "Missing or wrong token. Open the link printed when the app started.", code: "bad_token" });
    }
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
  });

  // Uploads arrive as raw bodies; leave the stream for the handler.
  fastify.addContentTypeParser("application/octet-stream", (_request, _payload, done) => done(null));

  fastify.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof BusyError) return reply.code(409).send({ error: error.message, code: ERROR_CODES.busy });
    if (error instanceof JobFailure) return reply.code(400).send({ error: error.message, code: error.code });
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send({ error: error.message, code: status === 400 ? ERROR_CODES.badRequest : "error" });
  });

  /** Start a job and answer with its id; the UI follows it over SSE. */
  const startJob = (reply: FastifyReply, kind: string, title: string, run: (job: Job) => Promise<unknown>) => {
    const job = runner.start(kind, title, run, mapJobError);
    return reply.code(202).send({ job: job.id });
  };
  const body = <T>(request: FastifyRequest) => (request.body ?? {}) as T;

  // ---- state & connection -------------------------------------------------------------------------

  fastify.get(ROUTES.state, async (): Promise<AppStateResponse> => {
    const target = session.target;
    return {
      connected: !!target,
      label: target?.label ?? null,
      settings: session.settings ? publicSettings(session.settings) : null,
      layout: target?.layoutInfo() ?? null,
      overrides: session.overrides,
      worlds: session.worlds,
      defaultWorld: session.defaultWorld,
      activeJob: runner.busy ? runner.active!.info() : null,
      uploads: await listUploads(),
      profiles: profiles.list(),
      testServer: !!options.testServer,
    };
  });

  fastify.post(ROUTES.connect, async (request, reply) => {
    const { settings, layout } = body<ConnectRequest>(request);
    if (!settings || !PROTOCOLS.includes(settings.protocol)) throw new JobFailure("Unknown protocol", ERROR_CODES.badRequest);
    const clean = {
      protocol: settings.protocol,
      host: str(settings.host).trim(),
      port: Number.isFinite(Number(settings.port)) && settings.port ? Number(settings.port) : null,
      username: str(settings.username).trim(),
      root: str(settings.root).trim(),
      password: str(settings.password) || undefined,
      keyFile: str(settings.keyFile).trim() || undefined,
      keyPassphrase: str(settings.keyPassphrase) || undefined,
      tlsVerify: settings.tlsVerify !== false,
      trustedFingerprint: str(settings.trustedFingerprint).trim() || undefined,
    };
    const where = clean.protocol === "local" ? clean.root || "run/" : clean.host;
    // A new connect replaces one that is still trying, so a stuck server never locks the app.
    const stuck = runner.busy && runner.active!.kind === "connect" ? runner.active! : null;
    if (stuck) {
      runner.cancel(stuck.id);
      await stuck.promise;
    }
    return startJob(reply, "connect", `Connecting to ${where}`, async (job): Promise<ConnectResult> => {
      job.log("plain", `Connecting to ${where} over ${clean.protocol.toUpperCase()} ...`);
      const target = await session.connect(clean, cleanOverrides(layout), job.signal);
      job.log("ok", `Connected: ${target.label}`);
      job.log("plain", `Server folder: ${target.describe(target.layout.serverRoot)}`);
      for (const note of target.layout.notes) job.log("info", note);
      job.log("plain", `Found ${session.worlds.length} world(s)`);
      return { label: target.label, layout: target.layoutInfo(), worlds: session.worlds, defaultWorld: session.defaultWorld };
    });
  });

  fastify.post(ROUTES.disconnect, async (_request, reply) => {
    if (runner.busy) return reply.code(409).send({ error: "A task is still running", code: ERROR_CODES.busy });
    await session.disconnect();
    return { ok: true };
  });

  fastify.post(ROUTES.layout, async (request, reply) => {
    session.requireTarget();
    const overrides = cleanOverrides(body<LayoutRequest>(request).layout);
    return startJob(reply, "layout", "Updating layout", async (job): Promise<ConnectResult> => {
      const target = await session.relayout(overrides);
      job.log("ok", `Layout updated. Found ${session.worlds.length} world(s)`);
      return { label: target.label, layout: target.layoutInfo(), worlds: session.worlds, defaultWorld: session.defaultWorld };
    });
  });

  // ---- world commands -----------------------------------------------------------------------------

  fastify.post(ROUTES.status, async (request, reply) => {
    const { world, refreshWorlds } = body<StatusRequest>(request);
    session.requireTarget();
    return startJob(reply, "status", "Reading world", async (job) => {
      const target = session.requireTarget();
      target.storage.clearCache();
      if (refreshWorlds) await session.refreshWorlds();
      const path = await session.requireWorld(world);
      const status = await worldStatus(target, path);
      job.log("plain", `${status.packs.length} pack(s), ${status.problems.length} problem(s)`);
      return status;
    });
  });

  fastify.post(ROUTES.install, async (request, reply) => {
    const input = body<InstallRequest>(request);
    const mode: DuplicateMode = input.duplicateMode === "skip" || input.duplicateMode === "keep-both" ? input.duplicateMode : "replace";
    session.requireTarget();
    if (uploadsInFlight > 0) throw new JobFailure("Files are still uploading - wait for them to finish", ERROR_CODES.busy);
    const sources = (await readdir(paths.uploadsDir))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((name) => join(paths.uploadsDir, name));
    if (!sources.length) throw new JobFailure("Add some packs first", ERROR_CODES.noUploads);
    return startJob(reply, "install", input.dryRun ? "Planning install" : `Installing ${sources.length} item(s)`, async (job) => {
      const ctx = context(job);
      ctx.target.storage.clearCache();
      const world = await session.requireWorld(input.world);
      const result = await runInstall(ctx, { world, sources, duplicateMode: mode, reupload: !!input.reupload, dryRun: !!input.dryRun });
      if (result.applied) {
        await session.refreshWorlds(result.worlds);
        if (result.stats.errors === 0) await clearUploads();
      }
      return result;
    });
  });

  fastify.post(ROUTES.uninstall, async (request, reply) => {
    const input = body<UninstallRequest>(request);
    const keys = Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === "string") : [];
    if (!keys.length) throw new JobFailure("Select at least one pack", ERROR_CODES.nothingSelected);
    session.requireTarget();
    return startJob(reply, "uninstall", input.keepFiles ? "Removing from world" : "Uninstalling", async (job) => {
      const ctx = context(job);
      ctx.target.storage.clearCache();
      const result = await runUninstall(ctx, await session.requireWorld(input.world), keys, !!input.keepFiles);
      await session.refreshWorlds(result.worlds);
      return result;
    });
  });

  fastify.post(ROUTES.rebuild, async (request, reply) => {
    const { world } = body<StatusRequest>(request);
    session.requireTarget();
    return startJob(reply, "rebuild", "Rebuilding world JSONs", async (job) => {
      const ctx = context(job);
      ctx.target.storage.clearCache();
      const result = await runRebuild(ctx, await session.requireWorld(world));
      await session.refreshWorlds(result.worlds);
      return result;
    });
  });

  fastify.post(ROUTES.cleanup, async (request, reply) => {
    const { world, dryRun, paths: picked } = body<CleanupRequest>(request);
    session.requireTarget();
    const only = Array.isArray(picked) ? picked.filter((path): path is string => typeof path === "string") : undefined;
    return startJob(
      reply,
      "cleanup",
      dryRun ? "Previewing cleanup" : only?.length ? "Deleting pack folders" : "Cleaning up",
      async (job) => {
        const ctx = context(job);
        ctx.target.storage.clearCache();
        return runCleanup(ctx, await session.requireWorld(world), !!dryRun, only);
      },
    );
  });

  fastify.post(ROUTES.worldPacks, async (request, reply) => {
    const { world, changes } = body<WorldPacksRequest>(request);
    session.requireTarget();
    const clean = cleanWorldPackChanges(changes);
    if (!clean.length) throw new JobFailure("Nothing to change", ERROR_CODES.nothingSelected);
    return startJob(reply, "world-packs", "Updating world packs", async (job) => {
      const ctx = context(job);
      ctx.target.storage.clearCache();
      const path = await session.requireWorld(world);
      for (const change of clean) {
        if (change.type === "register" && change.worlds)
          change.worlds = await Promise.all(change.worlds.map((other) => session.requireWorld(other)));
      }
      const result = await runWorldPacks(ctx, path, clean);
      await session.refreshWorlds(result.worlds);
      return result;
    });
  });

  fastify.post(ROUTES.serverProperties, async (request, reply) => {
    const { texturepackRequired } = body<ServerPropertiesRequest>(request);
    if (typeof texturepackRequired !== "boolean") throw new JobFailure("texturepackRequired must be true or false", ERROR_CODES.badRequest);
    const target = session.requireTarget();
    if (!target.layout.serverProperties) throw new JobFailure("This server has no server.properties", ERROR_CODES.badRequest);
    return startJob(reply, "server-properties", "Saving server.properties", async (job): Promise<ConnectResult> => {
      const path = target.layout.serverProperties!;
      target.storage.clearCache();
      const before = await target.storage.readText(path);
      await target.storage.writeText(path, setServerProperty(before, "texturepack-required", String(texturepackRequired)));
      job.log("ok", `texturepack-required=${texturepackRequired} in ${target.describe(path)}`);
      warn(job, "Restart the server for this to take effect");
      const next = await session.relayout(session.overrides);
      return { label: next.label, layout: next.layoutInfo(), worlds: session.worlds, defaultWorld: session.defaultWorld };
    });
  });

  fastify.post(ROUTES.audit, async (request, reply) => {
    const { world } = body<StatusRequest>(request);
    session.requireTarget();
    return startJob(reply, "audit", "Auditing", async (job) => {
      const ctx = context(job);
      ctx.target.storage.clearCache();
      return runAudit(ctx, await session.requireWorld(world));
    });
  });

  fastify.post(ROUTES.fixNesting, async (request, reply) => {
    const { world, paths: picked, dryRun } = body<FixNestingRequest>(request);
    session.requireTarget();
    const wanted = Array.isArray(picked) ? picked.filter((path): path is string => typeof path === "string") : [];
    return startJob(reply, "fix-nesting", dryRun ? "Previewing nesting fix" : "Fixing nested packs", async (job) => {
      const ctx = context(job);
      ctx.target.storage.clearCache();
      return runFixNesting(ctx, await session.requireWorld(world), wanted, !!dryRun);
    });
  });

  fastify.post(ROUTES.worldEdit, async (request, reply) => {
    const { world, experiments, gamemode } = body<WorldEditRequest>(request);
    if (gamemode && !GAMEMODES.includes(gamemode)) throw new JobFailure(`Unknown gamemode ${gamemode}`, ERROR_CODES.badRequest);
    const toggles = Object.fromEntries(
      Object.entries(experiments && typeof experiments === "object" ? experiments : {}).filter(
        (pair): pair is [string, boolean] => /^[a-z0-9_]+$/.test(pair[0]) && typeof pair[1] === "boolean",
      ),
    );
    session.requireTarget();
    return startJob(reply, "world-edit", "Saving world settings", async (job) =>
      runWorldEdit(context(job), await session.requireWorld(world), { experiments: toggles, gamemode: (gamemode as Gamemode) || null }),
    );
  });

  /** The zip is generated straight from the server into the download: no temp file. */
  fastify.get(ROUTES.backup, async (request, reply) => {
    const worldParam = str((request.query as Record<string, unknown>).world);
    session.requireTarget();
    const world = worldParam ? await session.requireWorld(worldParam) : null;
    const name = backupFileName(world);
    const job = runner.start(
      "backup",
      world ? "Backing up world" : "Backing up the server",
      async (j) => {
        reply.raw.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return runBackup(context(j), world, reply.raw);
      },
      mapJobError,
    );
    reply.hijack();
    // The browser stopping the download (or the tab closing) cancels the backup instead of reading on.
    const onClose = () => {
      if (!reply.raw.writableFinished) runner.cancel(job.id);
    };
    reply.raw.on("close", onClose);
    await job.promise;
    reply.raw.off("close", onClose);
    if (job.status === "done") {
      if (!reply.raw.writableEnded) reply.raw.end();
    } else if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "Content-Type": "application/json" });
      reply.raw.end(JSON.stringify({ error: job.error, code: job.errorCode }));
    } else {
      // Part of the zip is already sent: break the connection so the browser marks the download failed
      // instead of saving a truncated archive that looks complete.
      reply.raw.destroy(new Error(job.error ?? "Backup failed"));
    }
  });

  // ---- jobs ---------------------------------------------------------------------------------------

  fastify.get(ROUTES.jobs, async () => ({ jobs: runner.list() }));

  fastify.get("/api/jobs/:id/log", async (request, reply) => {
    const job = runner.get((request.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: "Unknown job", code: "not_found" });
    return reply.header("Content-Type", "text/plain; charset=utf-8").send(job.logText());
  });

  fastify.get("/api/jobs/:id", async (request, reply) => {
    const job = runner.get((request.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: "Unknown job", code: "not_found" });
    return job.info();
  });

  fastify.post("/api/jobs/:id/cancel", async (request) => ({ cancelled: runner.cancel((request.params as { id: string }).id) }));

  fastify.get("/api/jobs/:id/events", async (request, reply) => {
    const job = runner.get((request.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: "Unknown job", code: "not_found" });
    const since = Math.max(0, Number((request.query as Record<string, unknown>).since) || 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = job.subscribe(since, (event) => {
      send(event);
      if (event.type === "end") reply.raw.end();
    });
    if (job.status !== "running") reply.raw.end();
    request.raw.on("close", unsubscribe);
  });

  // ---- uploads ------------------------------------------------------------------------------------

  /** Files and bytes under a staged folder, read without blocking the server. */
  async function folderSize(folder: string): Promise<{ files: number; size: number }> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const sizes = await Promise.all(
      files.map((file) =>
        stat(join(file.parentPath, file.name)).then(
          (info) => info.size,
          () => 0,
        ),
      ),
    );
    return { files: files.length, size: sizes.reduce((sum, size) => sum + size, 0) };
  }

  async function listUploads(): Promise<UploadEntry[]> {
    const names = (await readdir(paths.uploadsDir).catch(() => [] as string[])).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    const entries = await Promise.all(
      names.map(async (name): Promise<UploadEntry | null> => {
        const full = join(paths.uploadsDir, name);
        const info = await stat(full).catch(() => null);
        if (!info) return null;
        if (!info.isDirectory()) return { name, isDir: false, files: 1, size: info.size };
        return { name, isDir: true, ...(await folderSize(full)) };
      }),
    );
    return entries.filter((entry): entry is UploadEntry => entry !== null);
  }

  async function clearUploads(name?: string): Promise<void> {
    if (name) {
      const relative = safeRelative(name);
      if (!relative || relative.includes("/")) throw new JobFailure("Bad upload name", ERROR_CODES.badRequest);
      await rm(join(paths.uploadsDir, relative), { recursive: true, force: true });
      return;
    }
    await rm(paths.uploadsDir, { recursive: true, force: true });
    await mkdir(paths.uploadsDir, { recursive: true });
  }

  /** Uploads still being written; an install waits for them, since it reads (and then clears) the same folder. */
  let uploadsInFlight = 0;
  const installRunning = () => runner.busy && runner.active?.kind === "install";

  fastify.get(ROUTES.uploads, async () => ({ uploads: await listUploads() }));

  fastify.put(ROUTES.uploads, async (request, reply) => {
    if (installRunning()) return reply.code(409).send({ error: "An install is running", code: ERROR_CODES.busy });
    const relative = safeRelative(str((request.query as Record<string, unknown>).path));
    if (!relative || relative.split("/").some((part) => JUNK_NAMES.has(part))) {
      if (relative) {
        request.raw.resume();
        return { ok: true, skipped: true };
      }
      return reply.code(400).send({ error: "Bad upload path", code: ERROR_CODES.badRequest });
    }
    const destination = resolve(paths.uploadsDir, relative);
    if (!destination.startsWith(resolve(paths.uploadsDir) + sep))
      return reply.code(400).send({ error: "Bad upload path", code: ERROR_CODES.badRequest });
    uploadsInFlight++;
    try {
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(request.raw, createWriteStream(destination));
    } catch (error) {
      // An aborted upload must not leave half a file for the next install to pick up.
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      uploadsInFlight--;
    }
    return { ok: true };
  });

  fastify.delete(ROUTES.uploads, async (request, reply) => {
    if (installRunning()) return reply.code(409).send({ error: "An install is running", code: ERROR_CODES.busy });
    await clearUploads(str((request.query as Record<string, unknown>).name) || undefined);
    return { uploads: await listUploads() };
  });

  // ---- server files, host keys and logs -----------------------------------------------------------

  /** Folders under a path on the connected server, for picking layout folders. */
  fastify.get(ROUTES.browse, async (request, reply): Promise<BrowseResult | undefined> => {
    const target = session.requireTarget();
    const path = joinStorage(str((request.query as Record<string, unknown>).path));
    try {
      const entries = await target.storage.listDir(path);
      return {
        path,
        display: target.describe(path),
        parent: path && path !== "/" ? parentStorage(path) : null,
        dirs: entries.filter((entry) => entry.isDir && !JUNK_NAMES.has(entry.name)).map((entry) => entry.name),
      };
    } catch (error) {
      if (isNotFound(error)) return reply.code(404).send({ error: `${target.describe(path)} does not exist`, code: "not_found" });
      throw error;
    }
  });

  /** A pack's pack_icon.png. Only pack folders are readable this way, and only that one file. */
  fastify.get(ROUTES.packIcon, async (request, reply) => {
    const target = session.requireTarget();
    const path = str((request.query as Record<string, unknown>).path);
    if (!path || !target.isInPackFolder(path)) return reply.code(400).send({ error: "Not a pack folder", code: ERROR_CODES.badRequest });
    // For a pack without a usable icon, answer "no content" (not an error the browser logs); the UI draws a tile.
    reply.header("Cache-Control", "private, max-age=600");
    const file = await target.storage.findChild(path, "pack_icon.png", "file");
    const data = file ? await target.storage.readFile(file).catch(() => null) : null;
    const png =
      data && data.length <= 2 * 1024 * 1024 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!png) return reply.code(204).send();
    return reply.header("Content-Type", "image/png").send(data);
  });

  fastify.get(ROUTES.knownHosts, async () => ({ hosts: knownHosts.list() }));
  fastify.delete(ROUTES.knownHosts, async (request) => {
    const query = request.query as Record<string, unknown>;
    const removed = knownHosts.forget(str(query.host).trim(), Number(query.port) || 22);
    return { removed, hosts: knownHosts.list() };
  });

  fastify.get(ROUTES.appLog, async (_request, reply) => {
    const text = await readFile(join(paths.logsDir, "latest.txt"), "utf8").catch(() => "");
    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="bedrock-pack-manager-log.txt"')
      .send(text);
  });

  // ---- profiles -----------------------------------------------------------------------------------

  fastify.get(ROUTES.profiles, async () => ({ profiles: profiles.list() }));
  fastify.post(ROUTES.profiles, async (request, reply) => {
    const input = body<SaveProfileRequest>(request);
    const name = str(input.name).trim();
    const settings = cleanProfileSettings(input.settings);
    if (!name || !settings) return reply.code(400).send({ error: "A profile needs a name and settings", code: ERROR_CODES.badRequest });
    return { profiles: profiles.save(name, settings, cleanOverrides(input.layout)) };
  });
  fastify.delete(ROUTES.profiles, async (request) => ({ profiles: profiles.delete(str((request.query as Record<string, unknown>).name)) }));

  // ---- static UI ----------------------------------------------------------------------------------

  const readStatic = (relative: string): Buffer | null => {
    if (options.readAsset) return options.readAsset(relative);
    if (!options.webDir) return null;
    const full = normalize(join(options.webDir, relative));
    if (!full.startsWith(normalize(options.webDir)) || !existsSync(full) || !statSync(full).isFile()) return null;
    return readFileSync(full);
  };

  fastify.get("/*", async (request, reply) => {
    const path = safeDecode(request.url.split("?")[0]!);
    if (path === null) return reply.code(400).send({ error: "Bad URL", code: ERROR_CODES.badRequest });
    if (path.startsWith("/api/")) return reply.code(404).send({ error: "Not found", code: "not_found" });
    const relative = safeRelative(path) ?? "index.html";
    let file = readStatic(relative);
    let served = relative;
    if (!file && !extname(relative)) {
      file = readStatic("index.html"); // client-side routes
      served = "index.html";
    }
    if (!file) return reply.code(404).send("Not found");
    return reply
      .header("Content-Type", MIME[extname(served)] ?? "application/octet-stream")
      .header("Content-Security-Policy", CSP)
      .header("Cache-Control", served.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store")
      .send(file);
  });

  return {
    fastify,
    token,
    session,
    runner,
    setPort(port: number) {
      allowedHosts.add(`127.0.0.1:${port}`);
      allowedHosts.add(`localhost:${port}`);
    },
  };
}
