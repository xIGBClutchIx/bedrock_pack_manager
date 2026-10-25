/**
 * FTP, explicit FTPS and implicit FTPS over basic-ftp. One FTP connection does one transfer at a
 * time, so bulk work spreads over a small pool of logged-in clients.
 */
import { Readable, Writable } from "node:stream";

import { Client, FTPError, type FileInfo } from "basic-ftp";

import { NotFoundError, StorageError } from "./errors";
import { join } from "./path";
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

// Servers disagree on the reply for a missing file (550 is standard; some send 551/553/450), so also read the text.
const isMissingCode = (error: unknown) =>
  (error instanceof FTPError && [550, 551, 553, 450, 451].includes(error.code)) ||
  /^55[0-3]\b|ENOENT|no such file|not found|does not exist|cannot find/i.test((error as Error)?.message ?? "");
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

  /** Run one FTP command on a pooled client, reconnecting once if the server dropped it. */
  private async call<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    let client = await this.acquire();
    try {
      if (client.closed) client = await this.login();
      try {
        return await fn(client);
      } catch (error) {
        if (!isDropped(error)) throw error;
        client.close();
        client = await this.login();
        return await fn(client);
      }
    } finally {
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

  // ---- raw operations -----------------------------------------------------------------------------

  protected async rawList(path: string): Promise<Entry[]> {
    const target = this.abs(path);
    let list: FileInfo[];
    try {
      list = await this.call((client) => client.list(target));
    } catch (error) {
      if (isMissingCode(error)) throw new NotFoundError(target);
      throw new StorageError(`Listing ${target} failed: ${(error as Error).message}`);
    }
    // basic-ftp lists a file path as that one file; a folder never lists itself.
    return list
      .filter((info) => info.name && info.name !== "." && info.name !== "..")
      .map((info) => {
        const name = info.name.includes("/") ? info.name.slice(info.name.lastIndexOf("/") + 1) : info.name;
        // FTP cannot tell where a link points; treat it as a folder for listings, but never follow it.
        const isDir = info.isDirectory || info.isSymbolicLink;
        return { name, isDir, size: isDir ? null : info.size, ...(info.isSymbolicLink ? { link: true } : {}) };
      });
  }

  protected async rawRead(path: string): Promise<Buffer> {
    const target = this.abs(path);
    try {
      return await this.call(async (client) => {
        const sink = new Collector();
        await client.downloadTo(sink, target);
        return Buffer.concat(sink.chunks);
      });
    } catch (error) {
      if (isMissingCode(error)) throw new NotFoundError(target);
      throw new StorageError(`Reading ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawWrite(path: string, data: Buffer): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call((client) => client.uploadFrom(Readable.from([data]), target));
    } catch (error) {
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
      if (isMissingCode(error)) throw new NotFoundError(target);
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
