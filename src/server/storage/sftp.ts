/**
 * SFTP over ssh2. Requests are pipelined: each channel carries many operations at once, and a
 * few channels share one SSH connection, so bulk work is bandwidth-bound, not latency-bound.
 */
import { readFileSync } from "node:fs";

import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from "ssh2";

import { HostKeyMismatchError, NotFoundError, StorageError, UnknownHostKeyError } from "./errors";
import { KnownHosts, fingerprintOf, keyTypeOf } from "./knownHosts";
import { join } from "./path";
import { Storage, type Entry } from "./storage";

const NO_SUCH_FILE = 2;

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
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === NO_SUCH_FILE || code === "ENOENT";
}

export class SftpStorage extends Storage {
  label = "";
  root = "/";
  private client: Client | null = null;
  private channels: SFTPWrapper[] = [];
  private next = 0;
  private connecting: Promise<void> | null = null;
  private readonly knownHosts: KnownHosts;
  private readonly port: number;

  private constructor(private readonly options: SftpOptions) {
    super(options.concurrency ?? 16);
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

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client
        .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password ?? "")))
        .once("ready", () => resolve())
        .once("error", (error: Error & { level?: string }) => {
          if (hostKeyProblem) return reject(hostKeyProblem);
          if (error.level === "client-authentication") return reject(new StorageError(`SFTP login failed for ${username}@${host}: ${error.message}`));
          reject(new StorageError(`Could not connect to ${host}:${port} over SFTP: ${error.message}`, { cause: error }));
        })
        .connect(config);
    });
    client.on("close", () => {
      if (this.client === client) {
        this.client = null;
        this.channels = [];
      }
    });
    client.on("error", () => undefined);
    this.client = client;

    const wanted = Math.max(1, this.options.channels ?? 3);
    for (let index = 0; index < wanted; index++) {
      try {
        this.channels.push(await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)))));
      } catch (error) {
        if (!this.channels.length) {
          client.end();
          throw new StorageError(`Server ${host} does not allow SFTP: ${(error as Error).message}`);
        }
        break; // the server caps sessions; use what we have
      }
    }
  }

  /** Run one SFTP request on the next channel, reconnecting once if the connection dropped. */
  private async call<T>(request: (sftp: SFTPWrapper, done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.ensureConnected();
      const sftp = this.channels[this.next++ % this.channels.length]!;
      try {
        return await new Promise<T>((resolve, reject) => request(sftp, (error, value) => (error ? reject(error) : resolve(value as T))));
      } catch (error) {
        const dropped = !this.client || /No response from server|Not connected|ECONNRESET|channel/i.test((error as Error).message ?? "");
        if (attempt === 0 && dropped && !isMissing(error)) {
          this.client?.end();
          this.client = null;
          this.channels = [];
          continue;
        }
        throw error;
      }
    }
  }

  async close(): Promise<void> {
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
        if (item.attrs.isSymbolicLink()) {
          isDir = await this.call<{ isDirectory(): boolean }>((sftp, done) => sftp.stat(`${target}/${item.filename}`, done)).then(
            (stats) => stats.isDirectory(),
            () => false,
          );
        }
        return { name: item.filename, isDir, size: isDir ? null : item.attrs.size };
      }),
    );
  }

  protected async rawRead(path: string): Promise<Buffer> {
    const target = this.abs(path);
    try {
      return await this.call<Buffer>((sftp, done) => sftp.readFile(target, done));
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError(target);
      throw new StorageError(`Reading ${target} failed: ${(error as Error).message}`);
    }
  }

  protected async rawWrite(path: string, data: Buffer): Promise<void> {
    const target = this.abs(path);
    try {
      await this.call<void>((sftp, done) => sftp.writeFile(target, data, done));
    } catch (error) {
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
      await this.call<void>((sftp, done) => sftp.rename(a, b, done));
    }
  }
}
