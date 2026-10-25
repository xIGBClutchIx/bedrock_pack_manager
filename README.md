# Bedrock Pack Manager

## 100% Vibe Coded - Make backups!

Install and manage Minecraft Bedrock behavior packs and resource packs on a server, from a web UI in your browser.
It works on a server folder on this computer, or on a remote server over **SFTP**, **FTP**, or **FTPS** (explicit or implicit).
Packs can be `.mcaddon`, `.mcpack`, `.zip`, or plain folders, and the tool copes with servers that are already half set up.

## Running It

Download the single executable for your platform (`bedrock-pack-manager.exe` on Windows, `bedrock-pack-manager` on Linux) and run it.
It starts a small server on `127.0.0.1` and opens the dashboard in your browser.

```bash
bedrock-pack-manager --help
bedrock-pack-manager --port 8765 --no-browser
bedrock-pack-manager --data-dir D:\bpm-data
```

| Option             | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `--port <n>`       | Port to listen on (default: a free port)                 |
| `--no-browser`     | Print the link instead of opening the browser            |
| `--data-dir <dir>` | Where to keep run data (default: `run/` next to the app) |

The UI is only reachable from this computer: the server binds to `127.0.0.1`, checks the `Host` and `Origin` headers, and every API request needs the random per-launch token in the link (however the path is spelled).

## What You Can Do

- **Connect** over SFTP, FTP, FTPS (explicit or implicit on port 990), or to a local folder. Save connection profiles; passwords are never saved or logged.
- **Packs tab**: every pack in the selected world with its icon, filters (installed, update available, wrong version, missing, not registered), and anything that needs attention above the list.
  Paths are shown relative to the server folder.
  Built-in game packs (vanilla, chemistry, editor, experimental, server libraries) are hidden and protected.
  Every row has the action it needs:
  - **Add to world** for a pack that is on the server but not registered
  - **Use vX** to switch to a newer (or the only) version on the server
  - **Drop entry** for a registration whose files are gone
  - the **details** arrow for the description, authors, minimum game version, folder and UUID, the load order (move up or down; the first resource pack wins), what the pack needs (with **Activate** for dependencies already on the server), which other worlds use it (and **Add to other worlds…**), and a subpack picker for resource packs
- **Install tab**: drop files or whole folders. The plan panel previews exactly what will be uploaded, replaced, only registered, or skipped, and flags downgrades and UUIDs shared with a different-looking pack, then installs with live upload and per-file progress.
  "Replace" never removes a copy another world still uses.
- **Uninstall** selected packs, or **Delete folder** for packs no world registers. Pack folders are only deleted when no world needs them (a world that registers a version the server lacks keeps the closest copy, and a world whose pack list cannot be read counts as needing it); dev folders and built-ins are never deleted. A keep-files option removes the registration only.
- **World tab**: switch experiments on or off (Beta APIs, Upcoming Creator Features, Molang, custom biomes, and any others the world already has) and set the gamemode, with one `level.dat.backup` of the untouched file. For the server, set `texturepack-required` in `server.properties`.
- **Tools**: check the world, register every pack on the server (newest version of each, keeping the existing order and subpacks), clean up unused pack folders (with a preview), and download a backup zip of a world or the whole server. Nested packs are fixed from the Packs tab.
- **History**: the last 30 tasks with their logs, and a download of the app log.
- **Activity bar**: the bar at the bottom shows the running task and its progress, with **Cancel** for long ones. **Show log** opens the full colour log, which can be resized. Reloading the page during a task picks it back up.
- **Server menu** (the **⋯** next to the server in the sidebar): see and override the server folders (with a folder browser), rescan the worlds, or disconnect.

### SFTP host keys

On the first SFTP connection the host key fingerprint (SHA256) is shown and must be confirmed with **Trust and connect**.
Trusted keys are stored in `run/known_hosts`. If a known host's key changes, the connection is refused.
**Manage trusted keys** on the connect screen lists them; after a server reinstall, forget the old key there and confirm the new fingerprint on the next connect.

### Server layouts

The layout is detected automatically and is deliberately forgiving:

- a Bedrock Dedicated Server folder (`worlds/`, `behavior_packs/`, `resource_packs/`, `server.properties`); `level-name` preselects the world
- the same server one or two folders down, as many hosting panels do (for example `/home/container`)
- the `worlds/` folder itself, using pack folders beside it
- a single world folder, using that world's own `behavior_packs/` and `resource_packs/`
- folder names in any letter case, `development_*_packs` folders, and packs stored inside a world folder

Any part can be overridden from **Server folders…** in the server menu (server root, worlds folder, behavior and resource pack folders, each with a **Browse…** folder picker), and new packs can go into the world's own pack folders instead of the shared ones.

The pack index also flags common server messes: packs nested a folder too deep, half-uploaded folders without a manifest, resource packs in `behavior_packs/`, broken manifests, and the same pack installed more than once.
Folders that hold several packs (like an `old/` storage folder) are left alone with a note.

### How installs work

- Archives are unpacked on this computer, including archives nested at any depth and zips with odd extensions. `__MACOSX`, `.DS_Store` and similar junk are dropped. Zip-slip paths are rejected, and so are archives that would unpack to more than 4 GB or 200,000 files.
- When one install holds two versions of the same pack, only the newest goes in. A `Manifest.json` in odd casing is uploaded as `manifest.json`.
- `manifest.json` files with comments, trailing commas, a BOM, or string versions are accepted.
- Only finished pack folders, world JSONs, and `level.dat` cross the network. `manifest.json` is uploaded last, so an interrupted upload never looks like a complete pack.
- Replacing a same-named folder uploads beside it, then swaps. The world JSON is written once at the end.
- Missing dependencies, beta-API requirements, and odd `.mcaddon` / `.mcpack` contents are reported as warnings.

Stop the Minecraft server before changing world settings, or it may overwrite `level.dat` when it shuts down.
Stop it for backups too: files it rewrites while running are skipped (and listed in the log) rather than ending the backup. A backup that fails part-way is reported as a failed download, never saved as a truncated zip, and stopping the download cancels it.

Symbolic links on the server are never followed: deleting one removes the link, not the folder it points at.

## Runtime Data

Everything the app writes lives under `run/` (beside the executable, or the current folder in development):

- `run/logs/`: `latest.txt` plus the 5 most recent timestamped job logs
- `run/staging/uploads/`: files dropped into the browser, before install
- `run/staging/unpack/`: scratch space for unpacking archives
- `run/known_hosts`: SFTP host keys you have trusted
- `run/profiles.json`: saved connection profiles (no passwords)

## Development

Requires Node 24.

```bash
npm ci
npm run dev
```

`npm run dev` runs the API server with `tsx watch` on port 5174 and the Vite dev server for the UI, which proxies `/api` to it.

To try the app without a real server, run `npm run demo` in a second terminal. It serves a deliberately messy Bedrock server over SFTP on port 2022 and FTP on port 2021 (user `mc`, password `pw`, a fixed test host key).
With `npm run dev` (or the `--test-server` option) the connect page has a **Test server** tab that connects to it in one click.

| Command               | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`         | API server and Vite UI with live reload                                      |
| `npm run build`       | Build the UI into `dist/web` and bundle the server into `dist/server.cjs`    |
| `npm start`           | Run the built server                                                         |
| `npm run build:sea`   | Build, then produce the single executable in `dist/`                         |
| `npm test`            | Vitest: storage, core, install, commands, API and component tests            |
| `npm run test:e2e`    | Playwright smoke test: connect, install, uninstall over SFTP                 |
| `npm run screenshots` | Capture the main screens into `test-results/screens/`                        |
| `npm run bench`       | Time connect, world status, install and uninstall against a slow SFTP server |
| `npm run demo`        | Start local SFTP (2022) and FTP (2021) demo servers with a messy layout      |
| `npm run lint`        | ESLint                                                                       |
| `npm run format`      | Prettier                                                                     |
| `npm run typecheck`   | `tsc --noEmit`                                                               |

Run `npx playwright install chromium` once before the Playwright commands.

### Single executable

`npm run build:sea` uses Node's single executable applications: the bundled server becomes the entry point and every file of the built UI is embedded as an asset.
On Windows the copied `node.exe` signature is invalidated by the injection, so the exe is unsigned and SmartScreen may warn about it.

### Git hooks

```bash
bash scripts/install_git_hooks.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_git_hooks.ps1
```

- `pre-commit`: `npm run lint` and `npm run typecheck`
- `pre-push`: `npm test`

### GitHub Actions

- `.github/workflows/quality-checks.yml`: lint, typecheck, and tests on Node 24, plus the Playwright smoke test in Chromium (traces uploaded on failure)
- `.github/workflows/build-artifacts.yml`: builds the Windows and Linux executables, runs `--help` on each, and uploads them as artifacts

## Project Layout

- `src/shared/`: types shared by the server and the UI (model, API routes, job events)
- `src/server/main.ts`: argument parsing, server start, browser launch
- `src/server/http/`: Fastify app, session, routes, uploads, SSE job streams, static files (from `dist/web` or SEA assets)
- `src/server/jobs/runner.ts`: one job at a time, cancel support, buffered events with replay
- `src/server/storage/`: local, SFTP (`ssh2`) and FTP/FTPS (`basic-ftp`) backends behind one file API, plus known hosts
- `src/server/core/`: manifests, layout detection, built-in packs, pack index, world JSON, `level.dat`, job logs
- `src/server/core/install/`: unpacking, planning, and applying installs
- `src/server/core/commands/`: world status, uninstall, audit, rebuild, cleanup, fix nesting, world edits, backup
- `src/server/app/`: run folder paths, connection profiles, log files
- `src/web/`: React + Vite dashboard (connect screen, packs, install, world settings, tools, console)
- `tests/`: Vitest tests with in-process SFTP and FTP servers and fixtures under `tests/fixtures/`
- `e2e/`: Playwright tests
- `scripts/`: server bundle, SEA build, benchmark, demo servers, git hook installers
