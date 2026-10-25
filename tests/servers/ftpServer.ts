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

export async function startFtpServer(root: string, options: { port?: number } = {}): Promise<FtpTestServer> {
  const port = options.port ?? (await freePort());
  const pasvMin = 40000 + Math.floor(Math.random() * 20000);
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: "127.0.0.1",
    pasv_min: pasvMin,
    pasv_max: pasvMin + 200,
    anonymous: false,
    greeting: "test",
    // ftp-srv expects a bunyan logger; tests want silence.
    log: quietLog as never,
  });
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
    },
  };
}
