import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as joinLocal } from "node:path";

import { FTPError } from "basic-ftp";

import { openStorage } from "../src/server/storage/connect";
import { CancelledError, HostKeyMismatchError, NotFoundError, StorageError, UnknownHostKeyError } from "../src/server/storage/errors";
import { FtpStorage, isMissingFtpError } from "../src/server/storage/ftp";
import { KnownHosts, fingerprintOf, keyTypeOf } from "../src/server/storage/knownHosts";
import { LocalStorage } from "../src/server/storage/local";
import { SftpStorage } from "../src/server/storage/sftp";
import { tempDir, writeFile } from "./helpers";
import { startFtpServer } from "./servers/ftpServer";
import { startSftpServer, type SftpTestServer } from "./servers/sftpServer";

describe("sftp connection", () => {
  let dir: ReturnType<typeof tempDir>;
  let server: SftpTestServer;
  beforeEach(async () => {
    dir = tempDir();
    server = await startSftpServer(dir.path);
  });
  afterEach(async () => {
    await server.close();
    dir.cleanup();
  });

  const base = () => ({ host: server.host, port: server.port, username: server.username, password: server.password });

  it("rejects an unknown host key with its fingerprint", async () => {
    const error = await SftpStorage.connect(base()).catch((e) => e);
    expect(error).toBeInstanceOf(UnknownHostKeyError);
    expect(error.fingerprint).toBe(fingerprintOf(server.hostKey));
    expect(error.keyType).toBe("ssh-ed25519");
  });

  it("remembers a confirmed key and later rejects a changed one", async () => {
    const knownHostsFile = joinLocal(dir.path, "known_hosts");
    const first = await SftpStorage.connect({ ...base(), knownHostsFile, trustedFingerprint: fingerprintOf(server.hostKey) });
    await first.close();
    expect(readFileSync(knownHostsFile, "utf8")).toContain(server.hostKey.toString("base64"));

    const second = await SftpStorage.connect({ ...base(), knownHostsFile });
    expect(second.label).toBe(`sftp://mc@127.0.0.1:${server.port}/`);
    await second.close();

    writeFileSync(knownHostsFile, `[127.0.0.1]:${server.port} ssh-ed25519 AAAAdifferent\n`);
    await expect(SftpStorage.connect({ ...base(), knownHostsFile })).rejects.toBeInstanceOf(HostKeyMismatchError);
  });

  it("reports a bad password as a login failure", async () => {
    const error = await SftpStorage.connect({ ...base(), password: "wrong", trustedFingerprint: fingerprintOf(server.hostKey) }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(StorageError);
    expect(error.message).toMatch(/login failed/);
  });

  it("works when the server allows only one SFTP channel", async () => {
    await server.close();
    server = await startSftpServer(dir.path, { maxSessions: 1 });
    for (const name of ["a", "b", "c"]) writeFile(joinLocal(dir.path, `${name}.txt`), name);
    const storage = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey), channels: 3 });
    try {
      const results = await storage.readMany(["a.txt", "b.txt", "c.txt"]);
      expect([...results.values()].map(String)).toEqual(["a", "b", "c"]);
    } finally {
      await storage.close();
    }
  });

  it("does not wait on a server that serves one SFTP session at a time", async () => {
    await server.close();
    server = await startSftpServer(dir.path, { oneSessionAtATime: true });
    writeFile(joinLocal(dir.path, "f.txt"), "ok");
    const started = Date.now();
    const storage = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey), channels: 4 });
    try {
      expect(await storage.readText("f.txt")).toBe("ok");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await storage.close();
    }
  });

  it("gives up when the server never opens an SFTP session", async () => {
    await server.close();
    server = await startSftpServer(dir.path, { ignoreSessions: true });
    const error = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey), timeoutMs: 300 }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(StorageError);
    expect(error.message).toMatch(/did not open an SFTP session/);
  });

  it("drops a stalled connection and retries on a fresh one", async () => {
    writeFile(joinLocal(dir.path, "f.txt"), "ok");
    const storage = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey), stallTimeoutMs: 300 });
    try {
      server.setStalled(true);
      const reading = storage.readText("f.txt");
      setTimeout(() => server.setStalled(false), 100);
      expect(await reading).toBe("ok");
    } finally {
      await storage.close();
    }
  });

  it("fails a request when the server stays silent", async () => {
    writeFile(joinLocal(dir.path, "f.txt"), "ok");
    const storage = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey), stallTimeoutMs: 300 });
    try {
      server.setStalled(true);
      await expect(storage.readText("f.txt")).rejects.toThrow(/stopped answering/);
    } finally {
      server.setStalled(false);
      await storage.close();
    }
  });

  it("reconnects after the connection drops", async () => {
    writeFile(joinLocal(dir.path, "f.txt"), "ok");
    const storage = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey) });
    (storage as unknown as { client: { end(): void } }).client.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storage.readText("f.txt")).toBe("ok");
    await storage.close();
  });

  it("never reconnects once closed", async () => {
    writeFile(joinLocal(dir.path, "f.txt"), "ok");
    const storage = await SftpStorage.connect({ ...base(), trustedFingerprint: fingerprintOf(server.hostKey) });
    await storage.close();
    await expect(storage.readText("f.txt")).rejects.toThrow(/closed/);
    expect((storage as unknown as { client: unknown }).client).toBeNull();
  });
});

describe("sftp short reads", () => {
  it("asks again for the rest when the server answers with fewer bytes", async () => {
    const dir = tempDir();
    const server = await startSftpServer(dir.path, { maxReadBytes: 1000 });
    const big = Buffer.alloc(200_000);
    for (let index = 0; index < big.length; index++) big[index] = index % 251;
    writeFileSync(joinLocal(dir.path, "big.bin"), big);
    const storage = await SftpStorage.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      trustedFingerprint: fingerprintOf(server.hostKey),
    });
    try {
      expect((await storage.readFile("big.bin")).equals(big)).toBe(true);
    } finally {
      await storage.close();
      await server.close();
      dir.cleanup();
    }
  });
});

describe("ftp connection", () => {
  it("reports a bad login and an unreachable host", async () => {
    const dir = tempDir();
    const server = await startFtpServer(dir.path);
    try {
      await expect(FtpStorage.connect({ host: server.host, port: server.port, username: "mc", password: "wrong" })).rejects.toThrow(
        /login failed|Could not connect/,
      );
    } finally {
      await server.close();
      dir.cleanup();
    }
    await expect(FtpStorage.connect({ host: "127.0.0.1", port: 1, username: "mc", password: "pw", timeoutMs: 2000 })).rejects.toThrow(
      /Could not connect/,
    );
  });

  it("joins a relative root to the login folder and keeps working with a small pool", async () => {
    const dir = tempDir();
    for (const name of ["a", "b", "c"]) writeFile(joinLocal(dir.path, "bedrock", `${name}.txt`), name);
    const server = await startFtpServer(dir.path);
    const storage = await FtpStorage.connect({
      host: server.host,
      port: server.port,
      username: "mc",
      password: "pw",
      root: "bedrock",
      poolSize: 1,
    });
    try {
      expect(storage.root).toBe("/bedrock");
      expect(storage.describe("x")).toBe("/bedrock/x");
      const results = await storage.readMany(["a.txt", "b.txt", "c.txt"]);
      expect([...results.values()].map(String)).toEqual(["a", "b", "c"]);
      await storage.close();
      await expect(storage.readText("a.txt")).rejects.toThrow(/closed/);
    } finally {
      await storage.close();
      await server.close();
      dir.cleanup();
    }
  });
});

describe("openStorage", () => {
  it("opens local folders relative to the base folder and checks they exist", async () => {
    const dir = tempDir();
    try {
      writeFile(joinLocal(dir.path, "srv", "x"), "");
      const storage = await openStorage(
        { protocol: "local", host: "", port: null, username: "", root: "srv", tlsVerify: true },
        { baseDir: dir.path, knownHostsFile: null },
      );
      expect(storage).toBeInstanceOf(LocalStorage);
      await expect(
        openStorage(
          { protocol: "local", host: "", port: null, username: "", root: "missing", tlsVerify: true },
          { baseDir: dir.path, knownHostsFile: null },
        ),
      ).rejects.toThrow(/does not exist/);
      await expect(
        openStorage(
          { protocol: "sftp", host: " ", port: null, username: "", root: "", tlsVerify: true },
          { baseDir: dir.path, knownHostsFile: null },
        ),
      ).rejects.toThrow(/host is required/);
    } finally {
      dir.cleanup();
    }
  });
});

describe("known hosts helpers", () => {
  const keyBlob = (type: string, fill: number) =>
    Buffer.concat([Buffer.from([0, 0, 0, type.length]), Buffer.from(type), Buffer.alloc(16, fill)]);

  it("reads the key type from a public key blob", () => {
    const blob = keyBlob("ssh-ed25519", 0);
    expect(keyTypeOf(blob)).toBe("ssh-ed25519");
    expect(keyTypeOf(Buffer.alloc(2))).toBe("unknown");
    expect(fingerprintOf(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it("compares host keys per key type", () => {
    const dir = tempDir();
    try {
      const hosts = new KnownHosts(joinLocal(dir.path, "known_hosts"));
      const ed = keyBlob("ssh-ed25519", 1);
      expect(hosts.check("h", 22, ed)).toBe("unknown");
      hosts.remember("h", 22, ed);
      expect(hosts.check("h", 22, ed)).toBe("match");
      // Same type, different key: refused.
      expect(hosts.check("h", 22, keyBlob("ssh-ed25519", 2))).toBe("mismatch");
      // A key type never seen for this host goes back to the user, not reported as a change.
      const rsa = keyBlob("ssh-rsa", 3);
      expect(hosts.check("h", 22, rsa)).toBe("unknown");
      hosts.remember("h", 22, rsa);
      expect(hosts.check("h", 22, rsa)).toBe("match");
      expect(hosts.check("h", 22, ed)).toBe("match");
      expect(hosts.check("h", 2222, ed)).toBe("unknown");
      expect(hosts.forget("h", 22)).toBe(2);
      expect(hosts.check("h", 22, ed)).toBe("unknown");
    } finally {
      dir.cleanup();
    }
  });
});

describe("ftp missing-file replies", () => {
  it("only treats not-found replies as missing", () => {
    expect(isMissingFtpError(new FTPError({ code: 550, message: "550 No such file or directory" }))).toBe(true);
    expect(isMissingFtpError(new FTPError({ code: 550, message: "550 /x/y: not found" }))).toBe(true);
    expect(isMissingFtpError(new FTPError({ code: 550, message: "550" }))).toBe(true);
    expect(isMissingFtpError(new FTPError({ code: 550, message: "550 Permission denied" }))).toBe(false);
    expect(isMissingFtpError(new FTPError({ code: 553, message: "553 Not allowed" }))).toBe(false);
    expect(isMissingFtpError(new FTPError({ code: 450, message: "450 File not found (busy)" }))).toBe(false);
    expect(isMissingFtpError(new FTPError({ code: 451, message: "451 Local error" }))).toBe(false);
    expect(isMissingFtpError(new Error("connection not found"))).toBe(false);
    expect(isMissingFtpError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
  });

  it("maps a missing file on the FTP server to NotFoundError", async () => {
    const dir = tempDir();
    const server = await startFtpServer(dir.path);
    const storage = await FtpStorage.connect({ host: server.host, port: server.port, username: "mc", password: "pw" });
    try {
      await expect(storage.readFile("missing.json")).rejects.toBeInstanceOf(NotFoundError);
      await expect(storage.readFile("nope/missing.json")).rejects.toBeInstanceOf(NotFoundError);
      // There but unreadable (here: a folder read as a file) is an error, never "missing".
      mkdirSync(joinLocal(dir.path, "world_behavior_packs.json"));
      const error = await storage.readFile("world_behavior_packs.json").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).not.toBeInstanceOf(NotFoundError);
    } finally {
      await storage.close();
      await server.close();
      dir.cleanup();
    }
  });
});

describe("cancelling transfers", () => {
  it("stops an SFTP read between chunks when the job is cancelled", async () => {
    const dir = tempDir();
    const server = await startSftpServer(dir.path, { latencyMs: 40 });
    // 640 chunks of 32 KB: ten rounds of the read window.
    writeFileSync(joinLocal(dir.path, "big.bin"), Buffer.alloc(640 * 32 * 1024, 1));
    const storage = await SftpStorage.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      trustedFingerprint: fingerprintOf(server.hostKey),
    });
    try {
      const controller = new AbortController();
      server.requests.clear();
      setTimeout(() => controller.abort(), 150);
      const results = await storage.readMany(["big.bin"], controller.signal);
      expect(results.get("big.bin")).toBeInstanceOf(CancelledError);
      expect(server.requests.get("READ") ?? 0).toBeLessThan(400);
    } finally {
      await storage.close();
      await server.close();
      dir.cleanup();
    }
  });
});
