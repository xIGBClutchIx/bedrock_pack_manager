/**
 * Transport-neutral file access used by every command.
 *
 * Backends implement a handful of raw operations; this class adds the listing cache,
 * a concurrency limit for bulk work, and the tree operations built on top.
 */
import { readdir, readFile } from "node:fs/promises";
import { join as joinLocal } from "node:path";

import pLimit, { type LimitFunction } from "p-limit";

import { CancelledError, NotFoundError, StorageError, isNotFound, throwIfAborted } from "./errors";
import { JUNK_NAMES, basename, join, parent } from "./path";

export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export interface Entry {
  name: string;
  isDir: boolean;
  size: number | null;
}

export interface BulkOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, path: string) => void;
}

export interface UploadOptions extends BulkOptions {
  /** Absolute local folders to leave out (packs nested inside another pack). */
  exclude?: Set<string>;
}

export abstract class Storage {
  /** Short human label such as `sftp://user@host:22/srv/bedrock`. */
  abstract readonly label: string;
  /** Whether directory listings may be cached for the lifetime of a job. */
  protected readonly cacheListings: boolean = true;
  private readonly listingCache = new Map<string, Entry[]>();
  /** Shared limit for single operations made through the public API. */
  private limiter: LimitFunction;
  private concurrency: number;

  protected constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
    this.limiter = pLimit(this.concurrency);
  }

  // ---- raw operations each backend implements --------------------------------------------------

  /** List a folder or throw NotFoundError. */
  protected abstract rawList(path: string): Promise<Entry[]>;
  /** Read a whole file or throw NotFoundError. */
  protected abstract rawRead(path: string): Promise<Buffer>;
  /** Write a whole file, replacing it. The parent folder exists. */
  protected abstract rawWrite(path: string, data: Buffer): Promise<void>;
  /** Create one folder level. May throw when it already exists. */
  protected abstract rawMkdir(path: string): Promise<void>;
  protected abstract rawRemoveFile(path: string): Promise<void>;
  /** Remove an empty folder. */
  protected abstract rawRemoveDir(path: string): Promise<void>;
  /** Rename a file or folder. May throw when the target exists. */
  protected abstract rawRename(from: string, to: string): Promise<void>;

  abstract close(): Promise<void>;

  /** Full path for people to read. */
  describe(path: string): string {
    return path || ".";
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.limiter = pLimit(this.concurrency);
  }

  // ---- cache ------------------------------------------------------------------------------------

  clearCache(): void {
    this.listingCache.clear();
  }

  protected invalidate(path: string): void {
    const key = join(path);
    this.listingCache.delete(key);
    this.listingCache.delete(parent(key));
    const prefix = `${key}/`;
    for (const cached of this.listingCache.keys()) if (cached.startsWith(prefix)) this.listingCache.delete(cached);
  }

  // ---- concurrency ------------------------------------------------------------------------------

  /**
   * Run `fn` for every item with the backend's concurrency, keeping order. Errors become values.
   * Each call gets its own limit (not the shared one), so `fn` may call public methods without deadlocking.
   */
  async map<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<(R | Error)[]> {
    const limit = pLimit(this.concurrency);
    return Promise.all(
      items.map((item) =>
        limit(async () => {
          if (signal?.aborted) return new CancelledError();
          try {
            return await fn(item);
          } catch (error) {
            return error instanceof Error ? error : new Error(String(error));
          }
        }),
      ),
    );
  }

  private static raiseFirst(results: unknown[], ignore?: (error: Error) => boolean): void {
    for (const result of results) {
      if (result instanceof CancelledError) throw result;
    }
    for (const result of results) {
      if (result instanceof Error && !(ignore && ignore(result))) throw result;
    }
  }

  // ---- queries ----------------------------------------------------------------------------------

  async listDir(path = ""): Promise<Entry[]> {
    const key = join(path);
    const cached = this.cacheListings ? this.listingCache.get(key) : undefined;
    if (cached) return [...cached];
    const entries = (await this.rawList(key)).filter((entry) => entry.name !== "." && entry.name !== "..");
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    if (this.cacheListings) this.listingCache.set(key, entries);
    return [...entries];
  }

  /** Find an entry by listing its parent, which every server supports. */
  async stat(path: string): Promise<Entry | null> {
    const key = join(path);
    if (key === "" || key === "/") return { name: key, isDir: true, size: null };
    try {
      const entries = await this.listDir(parent(key));
      return entries.find((entry) => entry.name === basename(key)) ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** `path/<name>` matched case-insensitively, for servers with odd casing. */
  async findChild(path: string, name: string, want?: "dir" | "file"): Promise<string | null> {
    let entries: Entry[];
    try {
      entries = await this.listDir(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const lower = name.toLowerCase();
    const candidates = [
      ...entries.filter((entry) => entry.name === name),
      ...entries.filter((entry) => entry.name.toLowerCase() === lower),
    ];
    const match = candidates.find((entry) => !want || entry.isDir === (want === "dir"));
    return match ? join(path, match.name) : null;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async isDir(path: string): Promise<boolean> {
    return (await this.stat(path))?.isDir === true;
  }

  async isFile(path: string): Promise<boolean> {
    const entry = await this.stat(path);
    return entry !== null && !entry.isDir;
  }

  readFile(path: string): Promise<Buffer> {
    return this.limiter(() => this.rawRead(join(path)));
  }

  async readText(path: string): Promise<string> {
    return stripBom((await this.readFile(path)).toString("utf8"));
  }

  /** Read several files at once. Missing files map to NotFoundError. */
  async readMany(paths: readonly string[], signal?: AbortSignal): Promise<Map<string, Buffer | Error>> {
    const keys = paths.map((path) => join(path));
    const results = await this.map(keys, (key) => this.rawRead(key), signal);
    return new Map(keys.map((key, index) => [key, results[index]!]));
  }

  // ---- writes -----------------------------------------------------------------------------------

  /** Write a file, through a temp name and a rename when the server allows it. */
  async writeFile(path: string, data: Buffer | string, options: { atomic?: boolean } = {}): Promise<void> {
    const key = join(path);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await this.mkdirs(parent(key));
    await this.limiter(async () => {
      if (options.atomic === false) {
        await this.rawWrite(key, bytes);
        return;
      }
      const temp = `${key}.bpm-tmp`;
      try {
        await this.rawWrite(temp, bytes);
      } catch {
        await this.rawWrite(key, bytes);
        return;
      }
      try {
        await this.rawRename(temp, key);
      } catch {
        // Many FTP servers refuse to rename over an existing file.
        try {
          await this.rawRemoveFile(key).catch((error) => {
            if (!isNotFound(error)) throw error;
          });
          await this.rawRename(temp, key);
        } catch {
          await this.rawWrite(key, bytes);
          await this.rawRemoveFile(temp).catch(() => undefined);
        }
      }
    });
    this.invalidate(key);
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeFile(path, text);
  }

  async mkdirs(path: string): Promise<void> {
    const key = join(path);
    if (key === "" || key === "/" || key.endsWith(":/")) return;
    if (await this.isDir(key)) return;
    const up = parent(key);
    if (up && up !== key) await this.mkdirs(up);
    try {
      await this.limiter(() => this.rawMkdir(key));
    } catch (error) {
      this.invalidate(key);
      if (!(await this.isDir(key))) throw error;
    }
    this.invalidate(key);
  }

  async removeFile(path: string): Promise<void> {
    const key = join(path);
    await this.limiter(() => this.rawRemoveFile(key));
    this.invalidate(key);
  }

  async rename(from: string, to: string): Promise<void> {
    const [a, b] = [join(from), join(to)];
    await this.limiter(() => this.rawRename(a, b));
    this.invalidate(a);
    this.invalidate(b);
  }

  async copyFile(from: string, to: string): Promise<void> {
    await this.writeFile(to, await this.readFile(from));
  }

  // ---- trees ------------------------------------------------------------------------------------

  /** Every folder (top-down) and file under `path`, listing a whole level at a time. */
  async scanTree(path: string, signal?: AbortSignal): Promise<{ dirs: string[]; files: string[] }> {
    const dirs: string[] = [];
    const files: string[] = [];
    let frontier = [join(path)];
    while (frontier.length) {
      throwIfAborted(signal);
      dirs.push(...frontier);
      const listings = await this.map(frontier, (folder) => this.rawList(folder), signal);
      const next: string[] = [];
      frontier.forEach((folder, index) => {
        const listing = listings[index]!;
        if (listing instanceof Error) {
          if (isNotFound(listing)) return;
          throw listing;
        }
        for (const entry of listing) {
          if (entry.name === "." || entry.name === "..") continue;
          (entry.isDir ? next : files).push(join(folder, entry.name));
        }
      });
      frontier = next;
    }
    return { dirs, files };
  }

  async removeTree(path: string, options: BulkOptions = {}): Promise<void> {
    const key = join(path);
    if (key === "" || key === "/" || key === ".") throw new StorageError("Refusing to delete the storage root");
    const entry = await this.stat(key);
    if (!entry) return;
    if (!entry.isDir) return this.removeFile(key);
    try {
      const { dirs, files } = await this.scanTree(key, options.signal);
      let done = 0;
      const results = await this.map(
        files,
        async (file) => {
          await this.rawRemoveFile(file);
          options.onProgress?.(++done, files.length, file);
        },
        options.signal,
      );
      Storage.raiseFirst(results, isNotFound);
      for (const folder of dirs.reverse()) {
        throwIfAborted(options.signal);
        await this.limiter(() => this.rawRemoveDir(folder));
      }
    } finally {
      this.invalidate(key);
    }
  }

  /**
   * Upload a local folder, many files at once. `manifest.json` files are written last so an
   * interrupted transfer never leaves a folder that looks like a complete pack.
   */
  async uploadTree(localDir: string, remoteDir: string, options: UploadOptions = {}): Promise<number> {
    const target = join(remoteDir);
    const fresh = !(await this.exists(target));
    await this.mkdirs(target);

    const folders: string[] = [];
    const uploads: [string, string][] = [];
    const manifests: [string, string][] = [];
    const collect = async (local: string, remote: string): Promise<void> => {
      const children = await readdir(local, { withFileTypes: true });
      children.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      for (const child of children) {
        const localPath = joinLocal(local, child.name);
        if (JUNK_NAMES.has(child.name) || options.exclude?.has(localPath)) continue;
        const remotePath = join(remote, child.name);
        if (child.isDirectory()) {
          folders.push(remotePath);
          await collect(localPath, remotePath);
        } else if (child.name.toLowerCase() === "manifest.json") {
          manifests.push([localPath, remotePath]);
        } else {
          uploads.push([localPath, remotePath]);
        }
      }
    };
    await collect(localDir, target);

    const total = uploads.length + manifests.length;
    let done = 0;
    const put = async ([local, remote]: [string, string]) => {
      await this.rawWrite(remote, await readFile(local));
      options.onProgress?.(++done, total, remote);
    };

    try {
      for (const folder of folders) {
        throwIfAborted(options.signal);
        if (fresh) {
          // Brand-new tree: nothing can exist yet, so skip the existence checks.
          try {
            await this.limiter(() => this.rawMkdir(folder));
            continue;
          } catch {
            this.invalidate(folder);
          }
        }
        await this.mkdirs(folder);
      }
      Storage.raiseFirst(await this.map(uploads, put, options.signal));
      manifests.sort((a, b) => b[1].length - a[1].length);
      for (const pair of manifests) {
        throwIfAborted(options.signal);
        await this.limiter(() => put(pair));
      }
    } finally {
      this.invalidate(target);
    }
    return total;
  }

  /** Yield `[relativePath, data]` for every file under `path`, fetched in parallel batches. */
  async *downloadFiles(path: string, signal?: AbortSignal): AsyncGenerator<[string, Buffer]> {
    const root = join(path);
    const { files } = await this.scanTree(root, signal);
    const batchSize = 32;
    for (let start = 0; start < files.length; start += batchSize) {
      const chunk = files.slice(start, start + batchSize);
      const results = await this.map(chunk, (file) => this.rawRead(file), signal);
      for (let index = 0; index < chunk.length; index++) {
        const data = results[index]!;
        if (data instanceof Error) throw data;
        const file = chunk[index]!;
        yield [root ? file.slice(root.length + 1) : file, data];
      }
    }
  }
}

export { NotFoundError };
