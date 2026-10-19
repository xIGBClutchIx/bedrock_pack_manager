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

The UI is only reachable from this computer: the server binds to `127.0.0.1`, checks the `Host` header, and every request needs the random per-launch token in the link.

## What You Can Do

- **Connect** over SFTP, FTP, FTPS (explicit or implicit on port 990), or to a local folder. Save connection profiles; passwords are never saved or logged.
- **Packs tab**: see every pack in the selected world with filter chips (installed, wrong version, missing, not registered) and any problems listed above the table.
  Built-in game packs (vanilla, chemistry, editor, experimental, server libraries) are hidden and protected.
- **Install tab**: drop files or whole folders. The plan panel previews exactly what will be uploaded, replaced, only registered, or skipped, then installs with live per-file progress.
- **Uninstall** selected packs. Pack folders are only deleted when no other world uses them; dev folders and built-ins are never deleted. A keep-files option removes the registration only.
- **World settings**: enable Beta APIs and set the gamemode. A `level.dat.backup` is written first.
- **Tools**: audit, rebuild the world JSONs (newest version of each pack), clean up unused pack folders (with a preview), fix packs nested one folder too deep, and download a backup zip of a world or the whole server.
- **Console**: the docked console streams each job's log with colours, and long jobs can be cancelled.

### SFTP host keys

On the first SFTP connection the host key fingerprint (SHA256) is shown and must be confirmed with **Trust and connect**.
Trusted keys are stored in `run/known_hosts`. If a known host's key changes, the connection is refused.

### Server layouts

The layout is detected automatically and is deliberately forgiving:

- a Bedrock Dedicated Server folder (`worlds/`, `behavior_packs/`, `resource_packs/`, `server.properties`); `level-name` preselects the world
- the same server one or two folders down, as many hosting panels do (for example `/home/container`)
- the `worlds/` folder itself, using pack folders beside it
- a single world folder, using that world's own `behavior_packs/` and `resource_packs/`
- folder names in any letter case, `development_*_packs` folders, and packs stored inside a world folder

Any part can be overridden from the layout dialog (server root, worlds folder, behavior and resource pack folders), and new packs can go into the world's own pack folders instead of the shared ones.

The pack index also flags common server messes: packs nested a folder too deep, half-uploaded folders without a manifest, resource packs in `behavior_packs/`, broken manifests, and the same pack installed more than once.
Folders that hold several packs (like an `old/` storage folder) are left alone with a note.

### How installs work

- Archives are unpacked on this computer, including archives nested at any depth and zips with odd extensions. `__MACOSX`, `.DS_Store` and similar junk are dropped. Zip-slip paths are rejected.
- `manifest.json` files with comments, trailing commas, a BOM, or string versions are accepted.
- Only finished pack folders, world JSONs, and `level.dat` cross the network. `manifest.json` is uploaded last, so an interrupted upload never looks like a complete pack.
- Replacing a same-named folder uploads beside it, then swaps. The world JSON is written once at the end.
- Missing dependencies, beta-API requirements, and odd `.mcaddon` / `.mcpack` contents are reported as warnings.

Stop the Minecraft server before changing world settings, or it may overwrite `level.dat` when it shuts down.

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
| `npm run demo`        | Start local SFTP and FTP demo servers holding a messy server layout          |
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

- `.github/workflows/quality-checks.yml`: lint, typecheck, and tests on Node 24
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
