/**
 * FTP, explicit FTPS and implicit FTPS over basic-ftp. One FTP connection does one transfer at a
 * time, so bulk work spreads over a small pool of logged-in clients.
 */
import { Readable, Writable } from "node:stream";

import { Client, FTPError, type FileInfo } from "basic-ftp";

import { CancelledError, NotFoundError, StorageError, throwIfAborted } from "./errors";
import { basename, join, parent } from "./path";
import { Storage, type Entry } from "./storage";

export interface FtpOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  root?: string;
  /** "explicit" = FTPS via AUTH TLS, "implicit" = TLS from the first byte (usually port 990). */
  tls?: false | "explicit" | "implicit";
  tlsVerify?: boolean;
  timeoutMs?: number;
  /** Logged-in connections used at once. Many hosts allow only a handful per user. */
  poolSize?: number;
}

const NOT_FOUND_TEXT = /no such file|not found|does not exist|cannot find|ENOENT/i;

/**
 * Whether an FTP error means "that file or folder does not exist". 550 also covers "permission denied"
 * and 45x is "busy" or a local error, so only a 550-553 reply whose text says not-found (or a bare 550)
 * counts. Treating a failed read as missing could make an unreadable world look empty.
 */
export function isMissingFtpError(error: unknown): boolean {
  if (error instanceof FTPError) {
    if (error.code < 550 || error.code > 553) return false;
    const text = (error.message ?? "").replace(/^\d{3}[\s-]*/, "").trim();
    return (error.code === 550 && !text) || NOT_FOUND_TEXT.test(text);
  }
  return (error as { code?: unknown })?.code === "ENOENT";
}

/**
 * Replies that may or may not mean "missing": vsftpd answers "550 Failed to open file" for a missing and an
 * unreadable file alike, and some servers (ftp-srv) send "451 ENOENT". These are settled by listing the parent.
 */
const AMBIGUOUS_CODES = new Set([450, 451, 550, 551, 553]);

/** Some servers answer LIST of an empty folder with an error instead of an empty listing. */
const EMPTY_LISTING = /no files found|directory is empty/i;
const isDropped = (error: unknown) =>
  !(error instanceof FTPError) && /closed|ECONNRESET|EPIPE|timeout|Client is closed|socket/i.test((error as Error)?.message ?? "");

/** Replies hosts give when a user already has as many sessions as allowed. */
const TOO_MANY_CONNECTIONS = /\b421\b|too many|connection limit|max(?:imum)? (?:number of )?(?:connections|clients|sessions)/i;

class Collector extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(chunk);
    callback();
  }
}

export class FtpStorage extends Storage {
  label = "";
  root = "/";
  private readonly idle: Client[] = [];
  private readonly waiters: { resolve: (client: Client) => void; reject: (error: Error) => void }[] = [];
  private size = 0;
  private maxSize: number;
  private closed = false;

  private constructor(private readonly options: FtpOptions) {
    const pool = Math.max(1, options.poolSize ?? 4);
    super(pool);
    this.maxSize = pool;
  }

  static async connect(options: FtpOptions): Promise<FtpStorage> {
    const storage = new FtpStorage(options);
    const client = await storage.login();
    storage.size = 1;
    let root = options.root ?? "";
    if (!root.startsWith("/")) {
      const home = await client.pwd().catch(() => "/");
      root = join(home, root) || "/";
    }
    storage.root = root;
    const scheme = options.tls ? "ftps" : "ftp";
    storage.label = `${scheme}://${options.username || "anonymous"}@${options.host}:${options.port ?? (options.tls === "implicit" ? 990 : 21)}${root}`;
    storage.release(client);
    return storage;
  }

  // ---- pool ---------------------------------------------------------------------------------------

  private async login(): Promise<Client> {
    const { host, username, password, tls, tlsVerify = true, timeoutMs = 30_000 } = this.options;
    const port = this.options.port ?? (tls === "implicit" ? 990 : 21);
    const client = new Client(timeoutMs);
    client.ftp.verbose = false;
    try {
      await client.access({
        host,
        port,
        user: username || "anonymous",
        password,
        secure: tls === "implicit" ? "implicit" : !!tls,
        secureOptions: { rejectUnauthorized: tlsVerify, servername: host },
      });
      await client.send("TYPE I").catch(() => undefined);
    } catch (error) {
      client.close();
      if (error instanceof FTPError && error.code === 530)
        throw new StorageError(`FTP login failed for ${username}@${host}: ${error.message}`);
      const message = (error as Error).message ?? String(error);
      if (/certificate|self.signed|unable to verify/i.test(message)) {
        throw new StorageError(
          `FTPS certificate check failed for ${host}: ${message}. Allow self-signed certificates if you trust this server.`,
        );
      }
      throw new StorageError(`Could not connect to ${host}:${port} over FTP: ${message}`, { cause: error });
    }
    return client;
  }

  private async acquire(): Promise<Client> {
    if (this.closed) throw new StorageError("The connection was closed");
    const idle = this.idle.pop();
    if (idle) return idle;
    if (this.size < this.maxSize) {
      this.size++;
      try {
        return await this.login();
      } catch (error) {
        this.size--;
        // The host refuses more connections: shrink the pool for good and wait for a free client.
        // Any other failure (a network blip) is just an error; the pool keeps its size.
        if (this.size > 0 && TOO_MANY_CONNECTIONS.test((error as Error).message ?? "")) {
          this.maxSize = this.size;
          this.setConcurrency(this.size);
          return this.waitForClient();
        }
        throw error;
      }
    }
    return this.waitForClient();
  }

  private waitForClient(): Promise<Client> {
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(client: Client): void {
    // After close(), clients that were busy are closed as they come back instead of being pooled.
    if (this.closed) return void client.close();
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(client);
    else this.idle.push(client);
  }

  /**
   * Run one FTP command on a pooled client, reconnecting once if the server dropped it. When `signal`
   * aborts mid-transfer the client is closed (FTP has no other way to stop a transfer) and the pool
   * logs in again the next time it hands that client out.
   */
  private async call<T>(fn: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    let client = await this.acquire();
    const onAbort = () => client.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (client.closed) client = await this.login();
      try {
        return await fn(client);
      } catch (error) {
        throwIfAborted(signal);
        if (!isDropped(error)) throw error;
        client.close();
        client = await this.login();
        return await fn(client);
      }
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.release(client);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const client of this.idle.splice(0)) client.close();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new StorageError("The connection was closed"));
    this.size = 0;
  }

  private abs(path: string): string {
    const key = join(path);
    if (key.startsWith("/")) return key;
    return join(this.root, key) || "/";
  }

  override describe(path: string): string {
    return this.abs(path);
  }

  /**
   * Whether `error` (from an operation on the absolute path `target`) means the path does not exist. A clear
   * not-found reply decides it; an ambiguous one is checked against the parent listing, so a file that is
   * there but unreadable is reported as an error, never as missing.
   */
  private async isMissing(error: unknown, target: string): Promise<boolean> {
    if (isMissingFtpError(error)) return true;
    if (!(error instanceof FTPError) || !AMBIGUOUS_CODES.has(error.code)) return false;
    const folder = parent(target);
    if (!folder || folder === target) return false;
    let list: FileInfo[];
    try {
      list = await this.call((client) => client.list(folder));
    } catch (inner) {
      return this.isMissing(inner, folder);
    }
    const name = basename(target);
    return !list.some((info) => basename(info.name) === name);
  }

  // ---- raw operations -----------------------------------------------------------------------------

  protected async rawList(path: string): Promise<Entry[]> {
    const target = this.abs(path);
    let list: FileInfo[];
    try {
      list = await this.call((client) => client.list(target));
    } catch (error) {
      if (await this.isMissing(error, target)) throw new NotFoundError(target);
      if (error instanceof FTPError && EMPTY_LISTING.test(error.message ?? "")) return [];
      throw new StorageError(`Listing ${target} failed: ${(error as Error).message}`);
    }
    // basic-ftp lists a file path as that one file; a folder never lists itself.
    return Promise.all(
      list
        .filter((info) => info.name && info.name !== "." && info.name !== "..")
        .map(async (info) => {
          const name = info.name.includes("/") ? info.name.slice(info.name.lastIndexOf("/") + 1) : info.name;
          // A listing cannot say where a link points, so ask the server whether it can change into it (like
          // the SFTP backend's stat). This only answers the question; tree operations still never follow links.
          const isDir = info.isSymbolicLink ? await this.linkIsDir(join(target, name)) : info.isDirectory;
          return { name, isDir, size: isDir ? null : info.size, ...(info.isSymbolicLink ? { link: true } : {}) };
        }),
    );
  }

  /** Whether a symlink points at a folder. A broken or unreadable link counts as a file. Paths are absolute, so the CWD is harmless. */
  private linkIsDir(target: string): Promise<boolean> {
    return this.call((client) => client.cd(target)).then(
      () => true,
      () => false,
    );
  }

  protected async rawRead(path: string, signal?: AbortSignal): Promise<Buffer> {
    const target = this.abs(path);
    try {
      return await this.call(async (client) => {
        const sink = new Collector();
        await client.downloadTo(sink, target);
        return Buffer.concat(sink.chunks);
      }, signal);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      if (await this.isMissing(error, target)) throw new NotFoundError(target);
      throw new StorageError(`Reading ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawWrite(path: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call((client) => client.uploadFrom(Readable.from([data]), target), signal);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      throw new StorageError(`Writing ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawMkdir(path: string): Promise<void> {
    await this.call((client) => client.send(`MKD ${this.abs(path)}`));
  }

  protected async rawRemoveFile(path: string): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call((client) => client.remove(target));
    } catch (error) {
      if (await this.isMissing(error, target)) throw new NotFoundError(target);
      throw new StorageError(`Deleting ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawRemoveDir(path: string): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call((client) => client.send(`RMD ${target}`));
    } catch (error) {
      throw new StorageError(`Removing folder ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawRename(from: string, to: string): Promise<void> {
    await this.call((client) => client.rename(this.abs(from), this.abs(to)));
  }
}
