/**
 * SFTP over ssh2. Requests are pipelined: each channel carries many operations at once, and a
 * few channels share one SSH connection, so bulk work is bandwidth-bound, not latency-bound.
 */
import { readFileSync } from "node:fs";

// ssh2 is CommonJS without detectable named exports, so Node's ESM loader needs the default import.
import ssh2, { type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from "ssh2";

import { CancelledError, HostKeyMismatchError, NotFoundError, StorageError, UnknownHostKeyError, throwIfAborted } from "./errors";
import { KnownHosts, fingerprintOf, keyTypeOf } from "./knownHosts";
import { join } from "./path";
import { Storage, type Entry } from "./storage";

const NO_SUCH_FILE = 2;
/** SFTP servers commonly cap a single read at 32-64 KB. */
const READ_CHUNK = 32 * 1024;
/** Reads of one file in flight at once. */
const READ_WINDOW = 64;
/** Fits the smallest write ssh2 sends without splitting (34000 bytes minus packet overhead). */
const WRITE_CHUNK = 31 * 1024;
/** Writes of one file in flight at once. */
const WRITE_WINDOW = 32;

export interface SftpOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyFile?: string;
  keyPassphrase?: string;
  root?: string;
  knownHostsFile?: string | null;
  trustedFingerprint?: string;
  timeoutMs?: number;
  /** Separate SFTP channels over the one connection. */
  channels?: number;
  /** Operations in flight across all channels. */
  concurrency?: number;
  /** Drop the connection when requests are waiting and nothing has arrived for this long. */
  stallTimeoutMs?: number;
}

/** How long to wait for an extra SFTP channel before using fewer. */
const EXTRA_CHANNEL_TIMEOUT_MS = 10_000;

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === NO_SUCH_FILE || code === "ENOENT";
}

/** Turn one callback-style SFTP request into a promise. */
const ask = <T>(fn: (done: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value as T))));

/**
 * Run `fn` for every item with at most `window` calls in flight. Stops starting new ones after the first
 * failure or an abort, waits for the ones already running, then rejects with the first error.
 */
async function windowed<T>(items: readonly T[], window: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const state: { failure: Error | null } = { failure: null };
  const worker = async () => {
    while (!state.failure && next < items.length) {
      if (signal?.aborted) {
        state.failure = new CancelledError();
        break;
      }
      try {
        await fn(items[next++]!);
      } catch (error) {
        state.failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(window, items.length) }, worker));
  if (state.failure) throw state.failure;
}

/** Open an SFTP channel, giving up after `timeoutMs`; a channel that opens later is closed again. */
function openChannel(client: ssh2.Client, timeoutMs: number): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`no answer after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs).unref();
    client.sftp((error, sftp) => {
      if (settled) return void (error ? undefined : sftp.end());
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

export class SftpStorage extends Storage {
  label = "";
  root = "/";
  private client: ssh2.Client | null = null;
  private channels: SFTPWrapper[] = [];
  private next = 0;
  private connecting: Promise<void> | null = null;
  private readonly knownHosts: KnownHosts;
  private readonly port: number;
  /** Stall detection: requests waiting, and when the server last sent anything. */
  private inFlight = 0;
  private lastHeard = Date.now();
  private stalled = false;
  private closed = false;

  private constructor(private readonly options: SftpOptions) {
    // Requests are pipelined, so many can be in flight cheaply; spread over a few channels so one
    // slow server-side request does not hold up the rest.
    super(options.concurrency ?? 48);
    this.port = options.port ?? 22;
    this.knownHosts = new KnownHosts(options.knownHostsFile ?? null);
  }

  static async connect(options: SftpOptions): Promise<SftpStorage> {
    const storage = new SftpStorage(options);
    await storage.ensureConnected();
    let root = options.root ?? "";
    if (!root.startsWith("/")) {
      const home = await storage.call<string>((sftp, done) => sftp.realpath(".", done)).catch(() => "/");
      root = join(home, root) || "/";
    }
    storage.root = root;
    storage.label = `sftp://${options.username}@${options.host}:${storage.port}${root}`;
    return storage;
  }

  // ---- connection -------------------------------------------------------------------------------

  private ensureConnected(): Promise<void> {
    // Work still running after close() (a cancelled connect, say) must not open a new connection nobody owns.
    if (this.closed) return Promise.reject(new StorageError("The connection was closed"));
    if (this.client && this.channels.length) return Promise.resolve();
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openConnection(): Promise<void> {
    const { host, username, password, keyFile, keyPassphrase, trustedFingerprint } = this.options;
    const port = this.port;
    let hostKeyProblem: StorageError | null = null;

    const config: ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: this.options.timeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
      tryKeyboard: !!password,
      hostVerifier: (key: Buffer) => {
        const fingerprint = fingerprintOf(key);
        const known = this.knownHosts.check(host, port, key);
        if (known === "match") return true;
        if (known === "mismatch") {
          hostKeyProblem = new HostKeyMismatchError(host, fingerprint);
          return false;
        }
        const trusted = trustedFingerprint?.trim();
        if (trusted && (trusted === fingerprint || `SHA256:${trusted}` === fingerprint)) {
          this.knownHosts.remember(host, port, key);
          return true;
        }
        hostKeyProblem = new UnknownHostKeyError(host, port, keyTypeOf(key), fingerprint);
        return false;
      },
    };
    if (password) config.password = password;
    if (keyFile) {
      try {
        config.privateKey = readFileSync(keyFile);
      } catch (error) {
        throw new StorageError(`Could not read the SSH key file ${keyFile}: ${(error as Error).message}`);
      }
      if (keyPassphrase) config.passphrase = keyPassphrase;
    }
    if (!password && !keyFile) config.agent = process.platform === "win32" ? "pageant" : process.env.SSH_AUTH_SOCK;

    const client = new ssh2.Client();
    // Errors are reported through the requests that hit them (and the connect promise below). This listener
    // stays for the client's whole life so a late socket error can never become an unhandled 'error' event.
    client.on("error", () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        client
          .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password ?? "")))
          .once("ready", () => resolve())
          .once("error", (error: Error & { level?: string }) => {
            if (hostKeyProblem) return reject(hostKeyProblem);
            if (error.level === "client-authentication")
              return reject(new StorageError(`SFTP login failed for ${username}@${host}: ${error.message}`));
            reject(new StorageError(`Could not connect to ${host}:${port} over SFTP: ${error.message}`, { cause: error }));
          })
          // Closed before it was ready without an error (no-op once settled).
          .once("close", () =>
            reject(hostKeyProblem ?? new StorageError(`Could not connect to ${host}:${port} over SFTP: connection closed`)),
          )
          .connect(config);
        // Any bytes from the server count as progress, so a big upload or download is never mistaken
        // for a stall. ssh2 keeps its socket in `_sock`.
        (client as unknown as { _sock?: NodeJS.EventEmitter })._sock?.on("data", () => {
          this.lastHeard = Date.now();
        });
      });
    } catch (error) {
      client.destroy();
      throw error;
    }
    this.watchStalls(client);
    client.on("close", () => {
      if (this.client === client) {
        this.client = null;
        this.channels = [];
      }
    });
    if (this.closed) {
      client.end();
      throw new StorageError("The connection was closed");
    }
    this.client = client;

    try {
      this.channels.push(await openChannel(client, this.options.timeoutMs ?? 20_000));
    } catch (error) {
      client.end();
      this.client = null;
      throw new StorageError(`Server ${host} did not open an SFTP session: ${(error as Error).message}`);
    }
    // Extra channels spread the load, but some servers (Pterodactyl Wings) serve one SFTP session per
    // connection and leave the next one waiting forever. So never wait on them: each joins if and
    // when the server opens it.
    void this.addChannels(client, Math.max(1, this.options.channels ?? 4) - 1);
  }

  /**
   * A server that stops answering (but keeps the TCP connection open) would leave requests
   * waiting forever. Destroying the connection fails them, and `call` retries once on a new one.
   */
  private watchStalls(client: ssh2.Client): void {
    const limit = this.options.stallTimeoutMs ?? 60_000;
    const timer = setInterval(
      () => {
        if (this.client !== client) return clearInterval(timer);
        if (this.inFlight > 0 && Date.now() - this.lastHeard > limit) {
          this.stalled = true;
          client.destroy();
        }
      },
      Math.min(5_000, Math.max(50, limit / 4)),
    ).unref();
    client.once("close", () => clearInterval(timer));
  }

  private async addChannels(client: ssh2.Client, count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      let sftp: SFTPWrapper;
      try {
        sftp = await openChannel(client, EXTRA_CHANNEL_TIMEOUT_MS);
      } catch {
        return; // the server caps sessions; use what we have
      }
      if (this.client !== client) return void sftp.end();
      this.channels.push(sftp);
    }
  }

  /** Run one SFTP request on the next channel, reconnecting once if the connection dropped. */
  private async call<T>(request: (sftp: SFTPWrapper, done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.ensureConnected();
      // The connection this attempt uses, so a failure only resets that one (another request may already have reconnected).
      const client = this.client;
      const sftp = this.channels[this.next++ % this.channels.length]!;
      // Time spent idle before this request is not a stall.
      if (this.inFlight++ === 0) this.lastHeard = Date.now();
      try {
        const value = await new Promise<T>((resolve, reject) =>
          request(sftp, (error, result) => (error ? reject(error) : resolve(result as T))),
        );
        this.stalled = false;
        return value;
      } catch (error) {
        const dropped =
          !this.client ||
          this.client !== client ||
          /No response from server|Not connected|ECONNRESET|channel/i.test((error as Error).message ?? "");
        if (attempt === 0 && dropped && !isMissing(error) && !(error instanceof CancelledError) && !this.closed) {
          client?.end();
          if (this.client === client) {
            this.client = null;
            this.channels = [];
          }
          continue;
        }
        if (dropped && this.stalled) {
          const seconds = Math.round((this.options.stallTimeoutMs ?? 60_000) / 1000);
          throw new StorageError(`the server stopped answering (nothing received for ${seconds}s)`);
        }
        throw error;
      } finally {
        this.inFlight--;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client?.end();
    this.client = null;
    this.channels = [];
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
    let list: FileEntryWithStats[];
    try {
      list = await this.call<FileEntryWithStats[]>((sftp, done) => sftp.readdir(target, done));
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError(target);
      throw new StorageError(`Listing ${target} failed: ${(error as Error).message}`);
    }
    return Promise.all(
      list.map(async (item) => {
        let isDir = item.attrs.isDirectory();
        const link = item.attrs.isSymbolicLink();
        if (link) {
          isDir = await this.call<{ isDirectory(): boolean }>((sftp, done) => sftp.stat(`${target}/${item.filename}`, done)).then(
            (stats) => stats.isDirectory(),
            () => false,
          );
        }
        return { name: item.filename, isDir, size: isDir ? null : item.attrs.size, ...(link ? { link } : {}) };
      }),
    );
  }

  /**
   * Read a whole file in as few round trips as possible: open, then the size and the first chunk
   * together, and the close is sent without waiting for it. Small files (manifests, world JSONs)
   * cost two round trips instead of four.
   */
  private readWhole(sftp: SFTPWrapper, target: string, signal?: AbortSignal): Promise<Buffer> {
    return ask<Buffer>((done) => sftp.open(target, "r", done)).then(async (handle) => {
      try {
        const first = Buffer.alloc(READ_CHUNK);
        const [stats, firstRead] = await Promise.all([
          ask<{ size?: number }>((done) => sftp.fstat(handle, done)),
          ask<number>((done) => sftp.read(handle, first, 0, READ_CHUNK, 0, (error, bytes) => done(error, bytes))),
        ]);
        const size = typeof stats.size === "number" ? stats.size : firstRead;
        if (size <= firstRead) return first.subarray(0, firstRead);
        // Bigger file: fetch the remaining chunks in parallel, stopping between chunks on abort.
        throwIfAborted(signal);
        const whole = Buffer.alloc(size);
        first.copy(whole, 0, 0, firstRead);
        const offsets: number[] = [];
        for (let offset = firstRead; offset < size; offset += READ_CHUNK) offsets.push(offset);
        // A server may answer a read with fewer bytes than asked; keep asking for the rest of that chunk.
        const readChunk = async (offset: number, length: number): Promise<void> => {
          const bytes = await ask<number>((done) => sftp.read(handle, whole, offset, length, offset, (error, got) => done(error, got)));
          if (bytes <= 0) throw new Error(`file ended early at byte ${offset} of ${size}`);
          if (bytes < length) {
            throwIfAborted(signal);
            await readChunk(offset + bytes, length - bytes);
          }
        };
        await windowed(offsets, READ_WINDOW, (offset) => readChunk(offset, Math.min(READ_CHUNK, size - offset)), signal);
        return whole;
      } finally {
        sftp.close(handle, () => undefined);
      }
    });
  }

  /**
   * Write a whole file with its chunks pipelined (ssh2's writeFile waits for each chunk before sending
   * the next): open, up to WRITE_WINDOW writes in flight, then close. The handle is closed on failure too.
   */
  private async writeWhole(sftp: SFTPWrapper, target: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    const handle = await ask<Buffer>((done) => sftp.open(target, "w", done));
    try {
      const offsets: number[] = [];
      for (let offset = 0; offset < data.length; offset += WRITE_CHUNK) offsets.push(offset);
      await windowed(
        offsets,
        WRITE_WINDOW,
        (offset) => ask<void>((done) => sftp.write(handle, data, offset, Math.min(WRITE_CHUNK, data.length - offset), offset, done)),
        signal,
      );
    } catch (error) {
      sftp.close(handle, () => undefined);
      throw error;
    }
    // Wait for the close: some servers only report a failed write (disk full) there.
    await ask<void>((done) => sftp.close(handle, done));
  }

  protected async rawRead(path: string, signal?: AbortSignal): Promise<Buffer> {
    const target = this.abs(path);
    try {
      throwIfAborted(signal);
      return await this.call<Buffer>((sftp, done) => {
        this.readWhole(sftp, target, signal).then(
          (data) => done(null, data),
          (error: Error) => done(error),
        );
      });
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      if (isMissing(error)) throw new NotFoundError(target);
      throw new StorageError(`Reading ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawWrite(path: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    const target = this.abs(path);
    try {
      throwIfAborted(signal);
      await this.call<void>((sftp, done) => {
        this.writeWhole(sftp, target, data, signal).then(
          () => done(null),
          (error: Error) => done(error),
        );
      });
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      throw new StorageError(`Writing ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawMkdir(path: string): Promise<void> {
    await this.call<void>((sftp, done) => sftp.mkdir(this.abs(path), done));
  }

  protected async rawRemoveFile(path: string): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call<void>((sftp, done) => sftp.unlink(target, done));
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError(target);
      throw new StorageError(`Deleting ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawRemoveDir(path: string): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call<void>((sftp, done) => sftp.rmdir(target, done));
    } catch (error) {
      throw new StorageError(`Removing folder ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawRename(from: string, to: string): Promise<void> {
    const [a, b] = [this.abs(from), this.abs(to)];
    try {
      await this.call<void>((sftp, done) => sftp.ext_openssh_rename(a, b, done));
    } catch {
      try {
        await this.call<void>((sftp, done) => sftp.rename(a, b, done));
      } catch (error) {
        // The reply to a rename that went through can be lost with a dropped connection, and the retry then
        // finds no source. If the source is gone and the destination is there, the rename happened.
        if (isMissing(error) && !(await this.pathExists(a)) && (await this.pathExists(b))) return;
        throw error;
      }
    }
  }

  private pathExists(path: string): Promise<boolean> {
    return this.call<unknown>((sftp, done) => sftp.lstat(path, done)).then(
      () => true,
      (error: unknown) => (isMissing(error) ? false : Promise.reject(error)),
    );
  }
}
