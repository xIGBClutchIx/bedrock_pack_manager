/**
 * Captures the main screens into test-results/screens/ for a visual check. Not an assertion-heavy
 * test: run it with `npx playwright test screenshots` when changing the UI.
 */
import { join } from "node:path";

import { test } from "@playwright/test";

import { buildPaths, ensureDirs } from "../src/server/app/paths";
import { createApp } from "../src/server/http/app";
import { FIXTURES, levelDatBytes, tempDir, writeFile, writeManifest } from "../tests/helpers";
import { startSftpServer } from "../tests/servers/sftpServer";

test("screens", async ({ page }) => {
  const dir = tempDir("bpm-shots-");
  const server = join(dir.path, "srv", "home", "container");
  writeFile(join(server, "server.properties"), "level-name=Survival SMP\n");
  writeFile(join(server, "worlds", "Survival SMP", "level.dat"), levelDatBytes({ GameType: { type: "int", value: 0 } }));
  writeFile(join(server, "worlds", "Creative", "level.dat"), levelDatBytes({ GameType: { type: "int", value: 1 } }));
  writeFile(
    join(server, "worlds", "Survival SMP", "world_behavior_packs.json"),
    JSON.stringify([
      { pack_id: "11111111-0000-0000-0000-000000000001", version: [1, 0, 0] },
      { pack_id: "44444444-0000-0000-0000-000000000004", version: [2, 0, 0] },
    ]),
  );
  writeManifest(join(server, "behavior_packs", "Good BP"), { uuid: "11111111-0000-0000-0000-000000000001", name: "Good Pack" });
  writeManifest(join(server, "behavior_packs", "Wrapper", "Inner BP"), {
    uuid: "33333333-0000-0000-0000-000000000003",
    name: "Nested Pack",
  });
  writeManifest(join(server, "behavior_packs", "vanilla_1.21"), { uuid: "fe9f8597-0000-0000-0000-000000000000", name: "pack.name" });
  writeManifest(join(server, "resource_packs", "Unused RP"), {
    uuid: "22222222-0000-0000-0000-000000000002",
    name: "Unused Textures",
    type: "resources",
  });
  const sftp = await startSftpServer(join(dir.path, "srv"));
  const paths = buildPaths(join(dir.path, "run"));
  ensureDirs(paths);
  const app = createApp({ paths, webDir: join(process.cwd(), "dist", "web") });
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = app.fastify.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  app.setPort(port);
  const out = (name: string) => join("test-results", "screens", `${name}.png`);

  try {
    await page.goto(`http://127.0.0.1:${port}/?t=${app.token}`);
    await page.getByLabel("Host", { exact: true }).fill(sftp.host);
    await page.getByLabel("Port", { exact: true }).fill(String(sftp.port));
    await page.getByLabel("Username", { exact: true }).fill(sftp.username);
    await page.getByLabel("Password", { exact: true }).fill(sftp.password);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Trust and connect" }).waitFor();
    await page.screenshot({ path: out("1-connect-hostkey"), fullPage: true });
    await page.getByRole("button", { name: "Trust and connect" }).click();
    await page.getByText(/nested one folder too deep/).waitFor();
    await page.screenshot({ path: out("2-packs"), fullPage: true });
    await page.getByRole("button", { name: "Add packs" }).click();
    await page.locator('.dropzone input[type="file"]:not([webkitdirectory])').setInputFiles(join(FIXTURES, "installed", "addon.mcaddon"));
    await page.locator(".plan-item").first().waitFor();
    await page.screenshot({ path: out("3-install-plan"), fullPage: true });
    await page.getByRole("button", { name: "World settings" }).click();
    await page.screenshot({ path: out("4-world"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Packs/ }).click();
    await page.screenshot({ path: out("5-phone"), fullPage: true });
  } finally {
    await app.session.disconnect();
    await app.fastify.close();
    await sftp.close();
    dir.cleanup();
  }
});
