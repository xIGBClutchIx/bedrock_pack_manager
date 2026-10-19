import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import nbt from "prismarine-nbt";

import { FtpStorage } from "../src/server/storage/ftp";
import { LocalStorage } from "../src/server/storage/local";
import { SftpStorage } from "../src/server/storage/sftp";
import type { Storage } from "../src/server/storage/storage";
import { startFtpServer } from "./servers/ftpServer";
import { startSftpServer } from "./servers/sftpServer";
import { fingerprintOf } from "../src/server/storage/knownHosts";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const PACK_UUID = "11111111-1111-1111-1111-111111111111";

export function tempDir(prefix = "bpm-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export interface ManifestOptions {
  uuid?: string;
  version?: (number | string)[] | string;
  name?: string;
  type?: string;
  dependencies?: unknown[];
  filename?: string;
}

export function writeManifest(folder: string, options: ManifestOptions = {}): void {
  const version = options.version ?? [1, 0, 0];
  const manifest: Record<string, unknown> = {
    format_version: 2,
    header: { name: options.name ?? "Test Pack", uuid: options.uuid ?? PACK_UUID, version },
    modules: [{ type: options.type ?? "data", uuid: "22222222-2222-2222-2222-222222222222", version }],
  };
  if (options.dependencies) manifest.dependencies = options.dependencies;
  writeFile(join(folder, options.filename ?? "manifest.json"), JSON.stringify(manifest));
}

/** A minimal Bedrock level.dat: 8-byte header plus little-endian NBT. */
export function levelDatBytes(values: Record<string, { type: string; value: unknown }>): Buffer {
  const body = nbt.writeUncompressed({ type: "compound", name: "", value: values } as never, "little");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(10, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function writeWorldJson(path: string, entries: unknown[]): void {
  writeFile(path, `${JSON.stringify(entries, null, 2)}\n`);
}

/** A Bedrock-server-shaped tree on a storage, plus a command context. */
export async function serverSetup(backend: Backend = "local", world = "W") {
  const harness = await makeStorage(backend);
  mkdirSync(join(harness.root, "worlds", world), { recursive: true });
  mkdirSync(join(harness.root, "behavior_packs"), { recursive: true });
  mkdirSync(join(harness.root, "resource_packs"), { recursive: true });
  const { Target } = await import("../src/server/core/layout");
  const { MemoryLog } = await import("../src/server/core/log");
  const target = await Target.open(harness.storage);
  const scratch = tempDir("bpm-scratch-");
  const log = new MemoryLog();
  return {
    ...harness,
    target,
    world: `worlds/${world}`,
    worldDir: join(harness.root, "worlds", world),
    log,
    ctx: { target, log, scratchDir: scratch.path },
    /** Fresh log and cleared caches, as a new job would get. */
    newJob() {
      harness.storage.clearCache();
      const fresh = new MemoryLog();
      return { target, log: fresh, scratchDir: scratch.path };
    },
    close: async () => {
      await harness.close();
      scratch.cleanup();
    },
  };
}

export type Backend = "local" | "sftp" | "ftp";
export const BACKENDS: Backend[] = ["local", "sftp", "ftp"];

export interface StorageHarness {
  storage: Storage;
  /** The local folder that backs the storage. */
  root: string;
  close(): Promise<void>;
}

/** A storage of the given kind over a fresh temp folder, with its server when remote. */
export async function makeStorage(backend: Backend, options: { latencyMs?: number } = {}): Promise<StorageHarness> {
  const dir = tempDir();
  if (backend === "local") {
    return { storage: new LocalStorage(dir.path), root: dir.path, close: async () => dir.cleanup() };
  }
  if (backend === "sftp") {
    const server = await startSftpServer(dir.path, options);
    const storage = await SftpStorage.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      root: "/",
      trustedFingerprint: fingerprintOf(server.hostKey),
    });
    return {
      storage,
      root: dir.path,
      close: async () => {
        await storage.close();
        await server.close();
        dir.cleanup();
      },
    };
  }
  const server = await startFtpServer(dir.path);
  const storage = await FtpStorage.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password,
    root: "/",
  });
  return {
    storage,
    root: dir.path,
    close: async () => {
      await storage.close();
      await server.close();
      dir.cleanup();
    },
  };
}
