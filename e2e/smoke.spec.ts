/**
 * End-to-end: the built UI against a real SFTP server. Connect, trust the host key, install an
 * .mcaddon, then uninstall one of its packs. Run with `npm run test:e2e` (builds first).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { buildPaths, ensureDirs } from "../src/server/app/paths";
import { createApp, type App } from "../src/server/http/app";
import { FIXTURES, levelDatBytes, tempDir, writeFile, writeManifest } from "../tests/helpers";
import { startSftpServer, type SftpTestServer } from "../tests/servers/sftpServer";

let dir: ReturnType<typeof tempDir>;
let sftp: SftpTestServer;
let app: App;
let url: string;

test.beforeAll(async () => {
  dir = tempDir("bpm-e2e-");
  const server = join(dir.path, "srv", "home", "container");
  writeFile(join(server, "server.properties"), "level-name=Survival\n");
  writeFile(join(server, "worlds", "Survival", "level.dat"), levelDatBytes({ GameType: { type: "int", value: 0 } }));
  writeManifest(join(server, "behavior_packs", "Wrapper", "Inner BP"), { uuid: "33333333-0000-0000-0000-000000000003", name: "Nested" });
  mkdirSync(join(server, "resource_packs"), { recursive: true });
  sftp = await startSftpServer(join(dir.path, "srv"));

  const paths = buildPaths(join(dir.path, "run"));
  ensureDirs(paths);
  app = createApp({ paths, webDir: join(process.cwd(), "dist", "web") });
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = app.fastify.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  app.setPort(port);
  url = `http://127.0.0.1:${port}/?t=${app.token}`;
});

test.afterAll(async () => {
  await app.session.disconnect();
  await app.fastify.close();
  await sftp.close();
  dir.cleanup();
});

test("connect over SFTP, install an addon, uninstall a pack", async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Connect to a server" })).toBeVisible();

  await page.getByLabel("Host", { exact: true }).fill(sftp.host);
  await page.getByLabel("Port", { exact: true }).fill(String(sftp.port));
  await page.getByLabel("Username", { exact: true }).fill(sftp.username);
  await page.getByLabel("Password", { exact: true }).fill(sftp.password);
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText(/First time connecting to/)).toBeVisible();
  await page.getByRole("button", { name: "Trust and connect" }).click();

  await expect(page.getByRole("heading", { name: "Survival", level: 1 })).toBeVisible();
  await expect(page.getByText(/nested one folder too deep/)).toBeVisible();
  await expect(page.locator(".conn-chip")).toContainText("sftp://mc@127.0.0.1");

  await page.getByRole("button", { name: "Add packs" }).click();
  await page.locator('.dropzone input[type="file"]:not([webkitdirectory])').setInputFiles(join(FIXTURES, "installed", "addon.mcaddon"));
  await expect(page.locator(".plan-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Install 2 packs" }).click();
  await page.locator(".modal").getByRole("button", { name: "Install" }).click();
  await expect(page.getByText(/Done — installed 2/)).toBeVisible();

  await page.getByRole("button", { name: /^Packs/ }).click();
  await expect(page.getByRole("row", { name: /Addon BP/ })).toContainText("Installed");
  await page.getByRole("checkbox", { name: "Select Addon BP" }).check();
  await page.getByRole("button", { name: "Uninstall & delete files" }).click();
  await page.locator(".modal").getByRole("button", { name: "Uninstall" }).click();
  await expect(page.getByRole("row", { name: /Addon BP/ })).toHaveCount(0);
  await expect(page.locator(".console")).toContainText("Uninstalling — done");
});

test("cancel a connect to a server that never answers", async ({ page }) => {
  await app.session.disconnect();
  const stalled = await startSftpServer(join(dir.path, "srv"), { ignoreSessions: true });
  try {
    await page.goto(url);
    await page.getByLabel("Host", { exact: true }).fill(stalled.host);
    await page.getByLabel("Port", { exact: true }).fill(String(stalled.port));
    await page.getByLabel("Username", { exact: true }).fill(stalled.username);
    await page.getByLabel("Password", { exact: true }).fill(stalled.password);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Trust and connect" }).click();

    await expect(page.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await expect(page.locator(".banner.danger")).toHaveCount(0);
  } finally {
    await app.session.disconnect();
    await stalled.close();
  }
});
