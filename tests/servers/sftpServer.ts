/**
 * A real SFTP server for tests and benchmarks: ssh2's Server speaking SFTP v3 over a local folder.
 * `latencyMs` delays every response, to make round-trip costs visible.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { Server, utils, type Attributes, type Connection, type SFTPWrapper } from "ssh2";

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface SftpTestServer {
  host: string;
  port: number;
  username: string;
  password: string;
  hostKey: Buffer;
  /** Count of SFTP requests served, by type. */
  requests: Map<string, number>;
  close(): Promise<void>;
}

const HOST_KEY = utils.generateKeyPairSync("ed25519");

function toAttrs(stats: Stats): Attributes {
  return {
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

export async function startSftpServer(root: string, options: { latencyMs?: number; maxSessions?: number } = {}): Promise<SftpTestServer> {
  const username = "mc";
  const password = "pw";
  const latency = options.latencyMs ?? 0;
  const requests = new Map<string, number>();
  const local = (path: string) => join(root, path.replace(/^\/+/, ""));

  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [HOST_KEY.private] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    let sessions = 0;
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === username && ctx.password === password) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (options.maxSessions && sessions >= options.maxSessions) return rejectSftp();
          sessions++;
          serveSftp(acceptSftp());
        });
      });
    });
    client.on("error", () => undefined);
  });

  function serveSftp(sftp: SFTPWrapper): void {
    const handles = new Map<number, { type: "dir"; path: string; done: boolean } | { type: "file"; fd: number }>();
    let nextHandle = 1;
    const makeHandle = (value: { type: "dir"; path: string; done: boolean } | { type: "file"; fd: number }) => {
      const id = nextHandle++;
      handles.set(id, value);
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(id);
      return buffer;
    };
    const lookup = (handle: Buffer) => handles.get(handle.readUInt32BE(0));
    const later = (name: string, fn: () => void) => {
      requests.set(name, (requests.get(name) ?? 0) + 1);
      if (latency) setTimeout(fn, latency);
      else fn();
    };
    const fail = (reqid: number, error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      sftp.status(reqid, code === "ENOENT" || code === "ENOTDIR" ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, String((error as Error)?.message ?? error));
    };
    const guarded = (reqid: number, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        fail(reqid, error);
      }
    };

    sftp
      .on("REALPATH", (reqid, path) => later("REALPATH", () => sftp.name(reqid, [{ filename: path === "." ? "/" : path, longname: "", attrs: {} as Attributes }])))
      .on("OPENDIR", (reqid, path) =>
        later("OPENDIR", () =>
          guarded(reqid, () => {
            if (!statSync(local(path)).isDirectory()) throw Object.assign(new Error("not a dir"), { code: "ENOTDIR" });
            sftp.handle(reqid, makeHandle({ type: "dir", path, done: false }));
          }),
        ),
      )
      .on("READDIR", (reqid, handle) =>
        later("READDIR", () =>
          guarded(reqid, () => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (entry.done) return sftp.status(reqid, STATUS_CODE.EOF);
            entry.done = true;
            const names = readdirSync(local(entry.path)).map((name) => ({ filename: name, longname: name, attrs: toAttrs(statSync(join(local(entry.path), name))) }));
            if (!names.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.name(reqid, names);
          }),
        ),
      )
      .on("STAT", (reqid, path) => later("STAT", () => guarded(reqid, () => sftp.attrs(reqid, toAttrs(statSync(local(path)))))))
      .on("LSTAT", (reqid, path) => later("LSTAT", () => guarded(reqid, () => sftp.attrs(reqid, toAttrs(statSync(local(path)))))))
      .on("OPEN", (reqid, filename, flags) =>
        later("OPEN", () => guarded(reqid, () => sftp.handle(reqid, makeHandle({ type: "file", fd: openSync(local(filename), flagsToString(flags) ?? "r") })))),
      )
      .on("FSTAT", (reqid, handle) =>
        later("FSTAT", () =>
          guarded(reqid, () => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            sftp.attrs(reqid, toAttrs(fstatSync(entry.fd)));
          }),
        ),
      )
      .on("READ", (reqid, handle, offset, length) =>
        later("READ", () =>
          guarded(reqid, () => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            const buffer = Buffer.alloc(length);
            const read = readSync(entry.fd, buffer, 0, length, offset);
            if (!read) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, buffer.subarray(0, read));
          }),
        ),
      )
      .on("WRITE", (reqid, handle, offset, data) =>
        later("WRITE", () =>
          guarded(reqid, () => {
            const entry = lookup(handle);
            if (!entry || entry.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            writeSync(entry.fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS_CODE.OK);
          }),
        ),
      )
      .on("CLOSE", (reqid, handle) =>
        later("CLOSE", () =>
          guarded(reqid, () => {
            const entry = lookup(handle);
            if (entry?.type === "file") closeSync(entry.fd);
            handles.delete(handle.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          }),
        ),
      )
      .on("MKDIR", (reqid, path) => later("MKDIR", () => guarded(reqid, () => (mkdirSync(local(path)), sftp.status(reqid, STATUS_CODE.OK)))))
      .on("RMDIR", (reqid, path) => later("RMDIR", () => guarded(reqid, () => (rmdirSync(local(path)), sftp.status(reqid, STATUS_CODE.OK)))))
      .on("REMOVE", (reqid, path) => later("REMOVE", () => guarded(reqid, () => (unlinkSync(local(path)), sftp.status(reqid, STATUS_CODE.OK)))))
      .on("RENAME", (reqid, from, to) =>
        later("RENAME", () =>
          guarded(reqid, () => {
            // SFTP v3 rename refuses to overwrite.
            if (statSync(local(to), { throwIfNoEntry: false })) return sftp.status(reqid, STATUS_CODE.FAILURE, "target exists");
            renameSync(local(from), local(to));
            sftp.status(reqid, STATUS_CODE.OK);
          }),
        ),
      )
      .on("SETSTAT", (reqid) => later("SETSTAT", () => sftp.status(reqid, STATUS_CODE.OK)))
      .on("FSETSTAT", (reqid) => later("FSETSTAT", () => sftp.status(reqid, STATUS_CODE.OK)));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const publicKey = utils.parseKey(HOST_KEY.public);
  const hostKey = Array.isArray(publicKey) ? publicKey[0]!.getPublicSSH() : (publicKey as { getPublicSSH(): Buffer }).getPublicSSH();
  return {
    host: "127.0.0.1",
    port,
    username,
    password,
    hostKey,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        server.close(() => resolve());
      }),
  };
}
