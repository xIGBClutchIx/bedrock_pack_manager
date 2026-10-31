/** A real FTP server for tests (ftp-srv) serving a local folder. User `mc`, password `pw`. */
import { createServer } from "node:net";

import { FtpSrv } from "ftp-srv";

export interface FtpTestServer {
  host: string;
  port: number;
  username: string;
  password: string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const quietLog = {
  child: () => quietLog,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};

const SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const;

export async function startFtpServer(root: string, options: { port?: number } = {}): Promise<FtpTestServer> {
  const port = options.port ?? (await freePort());
  // ftp-srv adds process signal listeners in its constructor and never removes them; remember this server's own.
  const before = SIGNALS.map((signal) => new Set(process.listeners(signal)));
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: "127.0.0.1",
    anonymous: false,
    greeting: "test",
    // ftp-srv expects a bunyan logger; tests want silence.
    log: quietLog as never,
  });
  const added = SIGNALS.map((signal, index) => process.listeners(signal).filter((listener) => !before[index]!.has(listener)));
  // ftp-srv picks a passive data port by test-listening on it, closing it, and listening again later. Under
  // load another socket can take the port in that gap (the old 40000-60200 range overlapped the OS ephemeral
  // ports), and on Windows the probe then fails with EACCES, which ftp-srv does not retry: it answers PASV/EPSV
  // with a line that has no reply code and the client waits forever. Port 0 lets the OS pick a free port at
  // the moment the data server listens, so there is no gap; the PASV/EPSV reply reads the real port back.
  (server as unknown as { getNextPasvPort: () => Promise<number> }).getNextPasvPort = () => Promise.resolve(0);
  server.on("login", ({ username, password }, resolve, reject) => {
    if (username === "mc" && password === "pw") resolve({ root });
    else reject(new Error("bad login"));
  });
  await server.listen();
  return {
    host: "127.0.0.1",
    port,
    username: "mc",
    password: "pw",
    close: async () => {
      await server.close();
      SIGNALS.forEach((signal, index) => added[index]!.forEach((listener) => process.off(signal, listener)));
    },
  };
}
