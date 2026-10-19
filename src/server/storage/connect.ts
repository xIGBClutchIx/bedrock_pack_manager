/** Open the right storage for a set of connection settings. */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { DEFAULT_PORTS, type ConnectionSettings } from "../../shared/model";
import { StorageError } from "./errors";
import { FtpStorage } from "./ftp";
import { LocalStorage } from "./local";
import { SftpStorage } from "./sftp";
import type { Storage } from "./storage";

export interface OpenOptions {
  /** Folder that relative local paths resolve against, and the default local root (run/). */
  baseDir: string;
  knownHostsFile: string | null;
}

export async function openStorage(settings: ConnectionSettings, options: OpenOptions): Promise<Storage> {
  const port = settings.port ?? DEFAULT_PORTS[settings.protocol] ?? undefined;
  switch (settings.protocol) {
    case "local": {
      const root = settings.root ? (isAbsolute(settings.root) ? settings.root : resolve(options.baseDir, settings.root)) : options.baseDir;
      if (!existsSync(root)) throw new StorageError(`Local folder does not exist: ${root}`);
      return new LocalStorage(resolve(root));
    }
    case "sftp":
      requireHost(settings);
      return SftpStorage.connect({
        host: settings.host,
        port: port ?? 22,
        username: settings.username,
        password: settings.password || undefined,
        keyFile: settings.keyFile || undefined,
        keyPassphrase: settings.keyPassphrase || undefined,
        root: settings.root,
        knownHostsFile: options.knownHostsFile,
        trustedFingerprint: settings.trustedFingerprint || undefined,
      });
    case "ftp":
    case "ftps":
    case "ftps-implicit":
      requireHost(settings);
      return FtpStorage.connect({
        host: settings.host,
        port: port ?? 21,
        username: settings.username,
        password: settings.password ?? "",
        root: settings.root,
        tls: settings.protocol === "ftp" ? false : settings.protocol === "ftps" ? "explicit" : "implicit",
        tlsVerify: settings.tlsVerify,
      });
    default:
      throw new StorageError(`Unsupported protocol ${String((settings as { protocol: unknown }).protocol)}`);
  }
}

function requireHost(settings: ConnectionSettings): void {
  if (!settings.host.trim()) throw new StorageError("A host is required for remote connections");
}
