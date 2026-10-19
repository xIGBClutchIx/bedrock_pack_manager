# Bedrock Pack Manager

## 100% Vibe Coded - Make backups!

Install Minecraft Bedrock behavior packs and resource packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.
Works on a server folder on this computer, or on a remote server over **FTP**, **FTPS**, or **SFTP**, from the terminal or from a local web UI.
All of the tool's own data lives under `run/` so the project root stays clean.

## Web UI

```bash
python bedrock_pack_manager.py --serve
```

This starts a small web server on `127.0.0.1` and opens it in your browser. From there you can:

- connect over SFTP, FTP, FTPS, or to a folder on this computer (save connection profiles; passwords are never saved)
- see every pack in a world: installed, missing files, wrong version, or on the server but not registered
- drag in `.mcaddon` / `.mcpack` / `.zip` files or whole folders, preview exactly what will be uploaded, replaced, or only registered, then install
- uninstall packs, run an audit, rebuild the world JSONs, clean up unused pack folders
- enable Beta APIs and set the gamemode (a `level.dat.backup` is written first)
- download a backup zip of a world or the whole server

The UI is only reachable from this computer: it binds to `127.0.0.1` and every request needs the random token in the printed link.
`--serve --remote sftp://user@host/path --password-env BPM_PW` pre-fills the connection form.

## Remote Servers

Point any command at a server with `--remote`:

```bash
python bedrock_pack_manager.py --remote sftp://steve@play.example.com:2022/home/container --doctor
python bedrock_pack_manager.py --remote ftp://steve@play.example.com/ --world-name "Bedrock level"
python bedrock_pack_manager.py --remote ftps://steve@host/ --allow-self-signed --uninstall
python bedrock_pack_manager.py --remote C:\servers\bedrock --rebuild
```

- The password is prompted for, or read from an environment variable with `--password-env VAR`. It is never written to disk or logs.
- SFTP can use `--key-file ~/.ssh/id_ed25519` or a running SSH agent.
- On the first SFTP connection the host key fingerprint is shown and must be confirmed; trusted keys are stored in `run/known_hosts`. Non-interactive runs can pass `--trust-host-key SHA256:...`.
- `--active-mode` switches FTP to active mode for servers where passive mode does not work.
- Packs are unpacked on this computer; only finished pack folders, world JSONs, and `level.dat` cross the network. `manifest.json` is uploaded last, so an interrupted upload never looks like a complete pack.
- Stop the server before `--beta` or `--gamemode`, or it may overwrite `level.dat` when it shuts down.

### Server layouts

The layout is detected automatically and is deliberately forgiving:

- a Bedrock Dedicated Server folder (`worlds/`, `behavior_packs/`, `resource_packs/`, `server.properties`); `level-name` preselects the world
- the same server one or two folders down, as many hosting panels do (for example `/home/container`)
- the `worlds/` folder itself, using pack folders beside it
- a single world folder, using that world's own `behavior_packs/` and `resource_packs/`
- folder names in any letter case, `development_*_packs` folders, and packs stored inside a world folder

Override any part with `--server-root`, `--worlds-dir`, `--bp-dir`, or `--rp-dir` (relative to the connection root).
`--pack-scope world` installs new packs into the world's own pack folders instead of the shared server folders.

The audit also flags common server messes: packs nested one folder too deep, half-uploaded folders without a manifest, resource packs sitting in `behavior_packs/`, broken manifests, and the same pack installed more than once.

## Interactive Menu

The default interactive mode opens a keyboard-driven menu for install, uninstall, rebuild, audit, cleanup, and world-edit flows.

![Interactive terminal menu](docs/images/interactive-menu.png)

## Setup

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Use the local `.venv` for normal development, testing, linting, and builds instead of installing tools into the system Python environment.
`requirements.txt` includes the runtime dependency plus the project's current test and lint tooling.

## Project Commands

Activate the virtual environment first:

```bash
. .venv/bin/activate
```

```bash
make run
make test
make test-verbose
make lint
make lint-fix
make build-linux
make build-windows
make install-hooks
make clean
```

## Local Git Hooks

For practical local enforcement on every change:

```bash
make install-hooks
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_git_hooks.ps1
```

That configures Git to use the tracked hooks in `.githooks/`:

- `pre-commit`: runs `python -m ruff check .` from the local `.venv`
- `pre-push`: runs `python -m pytest` from the local `.venv`

The hooks work with either `.venv/bin/python` or `.venv\Scripts\python.exe`.

## GitHub Actions

This repo includes two GitHub Actions workflows:

- `.github/workflows/quality-checks.yml`
  - installs dependencies from `requirements.txt`
  - runs `ruff check .`
  - runs `pytest`
- `.github/workflows/build-artifacts.yml`
  - builds the Linux one-file executable on `ubuntu-latest`
  - builds the Windows one-file executable on `windows-latest`
  - uploads both executables from `dist/` as workflow artifacts

## Testing

```bash
pytest
```

Coverage is enabled by default through pytest configuration. Running `pytest` will print a terminal coverage report and write `coverage.xml`.

## Linting

```bash
make lint
make lint-fix
```

`make lint` runs Ruff across the project using the configuration in `pyproject.toml`.
`make lint-fix` applies Ruff's automatic fixes where possible.
The current Ruff line length is `180`.

## Build Linux Executable

Activate the virtual environment, install the build dependency if needed, and run:

```bash
. .venv/bin/activate
python -m pip install pyinstaller
bash scripts/build_linux.sh
```

This produces a single-file Linux executable at `dist/bedrock-pack-manager`.

When running the packaged binary, runtime data is still created under a `run/` folder beside the executable.

## Build Windows Executable

Build the Windows executable on Windows:

```powershell
.venv\Scripts\Activate.ps1
python -m pip install pyinstaller
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1
```

Or from `cmd.exe`:

```bat
call .venv\Scripts\activate.bat
scripts\build_windows.bat
```

This produces `dist\bedrock-pack-manager.exe`.

PyInstaller does not reliably cross-build Windows executables from Linux, so use the Windows script on a Windows machine.

## Usage

```bash
python bedrock_pack_manager.py --help
python bedrock_pack_manager.py
python bedrock_pack_manager.py --uninstall
python bedrock_pack_manager.py --uninstall --uninstall-keep-files
python bedrock_pack_manager.py --rebuild
python bedrock_pack_manager.py --cleanup-pack-folders
python bedrock_pack_manager.py --zip
python bedrock_pack_manager.py --zip-name world.zip
python bedrock_pack_manager.py --beta
python bedrock_pack_manager.py --gamemode creative
python bedrock_pack_manager.py --beta --gamemode creative
python bedrock_pack_manager.py --doctor
python bedrock_pack_manager.py --doctor --world-name "My World"
python bedrock_pack_manager.py --rebuild --world-path "My World"
python bedrock_pack_manager.py --duplicate-mode replace
python bedrock_pack_manager.py --rebuild --beta
python bedrock_pack_manager.py --rebuild --beta --zip
python bedrock_pack_manager.py --dry-run
python bedrock_pack_manager.py --reupload
python bedrock_pack_manager.py --cleanup-pack-folders --dry-run
python bedrock_pack_manager.py --serve
python bedrock_pack_manager.py --serve --port 8765 --no-browser
python bedrock_pack_manager.py --remote sftp://user@host:22/path --password-env BPM_PW --doctor
```

`--zip-name` implies `--zip`, so `python bedrock_pack_manager.py --zip-name world.zip` is valid on its own.
With `--remote`, `--zip` downloads the worlds and pack folders into a local zip, which doubles as a backup.

`--dry-run` shows what install (or `--cleanup-pack-folders`) would change without touching anything.
`--reupload` uploads packs again even when the same version is already on the server, which repairs half-uploaded packs.

When launched without flags in an interactive terminal, the app shows a keyboard-driven menu flow:

- first choose install, edit world, uninstall, audit, rebuild, cleanup, connect to a remote server, or open the web UI from the menu
- `Connect To Remote Server` asks for a server URL such as `sftp://user@host:22/path`, then shows the menu again for that server
- if you choose install, it asks for a zip output name
- leave the zip name blank to skip zipping
- enter a name like `world.zip` to run zip mode with that filename
- if you choose uninstall packs, a second menu lets you toggle one or more registered behavior/resource packs to remove from that world
- uninstall mode warns before removing now-unused pack folders from disk and lets you keep files with JSON-only removal instead
- rebuild and cleanup menu entries include warnings because rebuild overwrites world pack JSONs and cleanup deletes unregistered pack folders
- if you choose edit world, a second menu lets you toggle one or more world edits, then submit them together
- world edit prompts warn that selected changes are written directly to `level.dat`
- if `Set Gamemode` is selected, a final menu asks which gamemode to write to `level.dat`
- use `Up` and `Down` to move
- press `Space` to toggle options in multi-select menus
- press `Enter` to continue
- press `Q` or `Ctrl+C` to quit
- leave all install options unchecked to continue with normal install mode

When stdin/stdout is not a fully interactive terminal, the app falls back to plain prompt-based input instead of the arrow-key menu UI.

The interactive menus work in POSIX terminals and on modern Windows consoles such as Windows Terminal and PowerShell.

When the app finishes in an interactive terminal, it waits for `Enter` before closing.
On startup, the app creates the full runtime folder tree under `run/` before logging, world selection, install, or uninstall logic runs.

Install mode can also control how duplicate pack UUIDs are handled:

- `--duplicate-mode replace`: replace existing installed copies for that UUID and update the world entry
- `--duplicate-mode skip`: keep the currently installed UUID/version and skip the incoming pack
- `--duplicate-mode keep-both`: keep older copies on disk, install the new one beside them, and update the world entry to the new version

World edit mode can also be driven directly from the CLI:

- `--beta` enables Beta APIs in the selected world's `level.dat`
- `--gamemode survival|creative|adventure` sets the world's default gamemode in `level.dat`
- `--beta --gamemode creative` applies both world edits in one run

Uninstall mode can also be driven directly from the CLI:

- `--uninstall` opens a pack picker for the selected world
- uninstall always removes the pack from the selected world's JSON
- `--uninstall-keep-files` removes the JSON registration but leaves installed pack folders on disk
- installed pack folders are only deleted when no other world still references that same pack version
- if `run/uninstall/` contains pack files or folders, uninstall mode uses those manifests as the removal list instead of opening the picker
- processed uninstall inputs are moved to `run/uninstalled/`

Cleanup mode can also be driven directly from the CLI:

- `--cleanup-pack-folders` scans the installed pack folders (shared and world-local; `development_*` folders are never touched)
- each folder's `manifest.json` UUID and version is compared against the selected world's JSON registrations
- folders not registered in that world are deleted
- folders are kept when another world still references that same pack version

`--duplicate-mode` applies to install mode only. It does not affect `--doctor`, `--uninstall`, `--rebuild`, `--cleanup-pack-folders`, `--beta`, `--gamemode`, or `--zip` when those are run on their own.

World selection can also be driven directly from the CLI:

- `--world-name "My World"` selects `My World` in the worlds folder (`run/worlds/` locally)
- `--world-path "My World"` resolves a relative path from the worlds folder, then from the server folder
- `--world-path /absolute/path/to/World` uses an absolute path directly
- if neither flag is provided, the interactive or prompt-based world picker is used, starting on the server's `level-name`
- `--world-name` and `--world-path` are mutually exclusive

## What It Does

- Extracts archive files, including archives nested any number of levels deep and zip files with odd extensions
- Ignores `__MACOSX`, `.DS_Store`, and similar junk from archives
- Detects whether a pack is a behavior pack or resource pack from `manifest.json`
- Accepts `manifest.json` files with `//` or `/* ... */` comments, trailing commas, a BOM, or string versions
- Plans every install first (upload, register only, replace, or skip), so `--dry-run` and the web UI preview show exact changes
- Uploads packs into the server's `behavior_packs/` and `resource_packs/` (or the world's own folders with `--pack-scope world`)
- Registers packs that are already on the server without uploading them again
- Registers packs in the selected world's JSON files
- Rebuilds world pack JSON files from installed pack folders on demand
- Cleans up installed pack folders that are no longer registered to the selected world
- Audits installed packs and world registrations without modifying files, listing detected packs in the terminal
- Warns about missing dependencies, invalid files, and old manifest versions
- Moves processed input from `run/install/` to `run/installed/`
- Writes a plain-text execution log to `run/logs/latest.txt` and keeps the 5 most recent timestamped logs

## Folder Structure

- `run/install/`: drop `.mcaddon`, `.mcpack`, `.zip`, or extracted pack folders here
- `run/installed/`: processed files and folders are moved here
- `run/uninstall/`: drop `.mcaddon`, `.mcpack`, `.zip`, or extracted pack folders here to remove matching packs from a world
- `run/uninstalled/`: processed uninstall files and folders are moved here
- `run/behavior_packs/`: installed behavior packs
- `run/resource_packs/`: installed resource packs
- `run/worlds/`: world folders containing `level.dat` and pack JSON files
- `run/logs/`: `latest.txt` plus the 5 most recent timestamped run logs
- `run/staging/`: local scratch space for unpacking archives and web UI uploads
- `run/backups/`: backup zips created from the web UI
- `run/known_hosts`: SFTP host keys you have trusted
- `run/profiles.json`: saved web UI connection profiles (no passwords)

`run/behavior_packs/`, `run/resource_packs/`, and `run/worlds/` are only used when no `--remote` is given.

## Project Layout

- `bedrock_pack_manager.py`: thin CLI entrypoint
- `bedrock_pack_manager/cli.py`: startup, argument handling, interactive menus, and connecting
- `bedrock_pack_manager/commands.py`: install, uninstall, rebuild, cleanup, zip, world edit, audit, and world status handlers
- `bedrock_pack_manager/install.py`: unpacking, install planning, upload, and dependency checks
- `bedrock_pack_manager/storage/`: local, FTP/FTPS, and SFTP backends behind one small file API
- `bedrock_pack_manager/layout.py`: server layout detection and the `Target` (storage + layout) every command uses
- `bedrock_pack_manager/pack_index.py`: one scan of installed packs per operation, with problem detection
- `bedrock_pack_manager/web/`: local web UI server, background jobs, and static assets
- `bedrock_pack_manager/worlds.py`: world selection and world JSON helpers
- `bedrock_pack_manager/manifests.py`: manifest parsing and pack classification
- `bedrock_pack_manager/nbt.py`: `level.dat` NBT helpers for world edits
- `bedrock_pack_manager/logger.py`: run log capture and retention
- `bedrock_pack_manager/paths.py`: shared project paths
- `bedrock_pack_manager/console.py`: console output and shared app state
- `bedrock_pack_manager/terminal.py`: terminal capability and keypress helpers
- `bedrock_pack_manager/constants.py`: shared pack/archive constants

## Requirements

- Python 3.10+
- `nbtlib>=2.0.4`
- `paramiko>=3.4.0` for SFTP
- `pytest>=8.0.0`, `pytest-cov>=5.0.0`, and `pyftpdlib>=1.5.9` for testing
- `ruff>=0.9.0` for linting
- `pyinstaller>=6.0.0` for standalone builds

Project dependency layout in `pyproject.toml`:

- runtime dependencies: `nbtlib`, `paramiko`
- optional `test` extras: `pytest`, `pytest-cov`, `pyftpdlib`, `ruff`
- optional `lint` extras: `ruff`
- optional `build` extras: `pyinstaller`
