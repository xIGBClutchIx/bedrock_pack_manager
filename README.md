# Bedrock Pack Installer

Install Minecraft Bedrock behavior packs and resource packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.
All runtime data lives under `run/` so the project root stays clean.

## Setup

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Use the local `.venv` for normal development, testing, linting, and builds instead of installing tools into the system Python environment.

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
make clean
```

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

This produces a single-file Linux executable at `dist/bedrock-pack-installer`.

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

This produces `dist\bedrock-pack-installer.exe`.

PyInstaller does not reliably cross-build Windows executables from Linux, so use the Windows script on a Windows machine.

## Usage

```bash
python bedrock_pack_installer.py --help
python bedrock_pack_installer.py
python bedrock_pack_installer.py --uninstall
python bedrock_pack_installer.py --rebuild
python bedrock_pack_installer.py --zip
python bedrock_pack_installer.py --zip-name world.zip
python bedrock_pack_installer.py --beta
python bedrock_pack_installer.py --gamemode creative
python bedrock_pack_installer.py --beta --gamemode creative
python bedrock_pack_installer.py --doctor
python bedrock_pack_installer.py --doctor --world-name "My World"
python bedrock_pack_installer.py --rebuild --world-path "My World"
python bedrock_pack_installer.py --duplicate-mode replace
python bedrock_pack_installer.py --rebuild --beta
python bedrock_pack_installer.py --rebuild --beta --zip
```

When launched without flags in an interactive terminal, the app shows a keyboard-driven prompt flow:

- first choose `Install Packs`, `Uninstall Packs`, `Edit World`, or `Audit World`
- `Rebuild World Pack JSONs` is a top-level mode
- if you choose install, it asks for a zip output name
- leave the zip name blank to skip zipping
- enter a name like `world.zip` to run zip mode with that filename
- if you choose uninstall packs, a second menu lets you toggle one or more registered behavior/resource packs to remove from that world
- if you choose edit world, a second menu lets you toggle one or more world edits, then submit them together
- if `Set Gamemode` is selected, a final menu asks which gamemode to write to `level.dat`
- use `Up` and `Down` to move
- press `Space` to toggle options in multi-select menus
- press `Enter` to continue
- press `Q` or `Ctrl+C` to quit
- leave all install options unchecked to continue with normal install mode

The interactive menus work in POSIX terminals and on modern Windows consoles such as Windows Terminal and PowerShell.

When the app finishes in an interactive terminal, it waits for `Enter` before closing.

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
- installed pack folders are only deleted when no other world still references that same pack version

`--duplicate-mode` applies to install mode only. It does not affect `--doctor`, `--uninstall`, `--rebuild`, `--beta`, `--gamemode`, or `--zip` when those are run on their own.

World selection can also be driven directly from the CLI:

- `--world-name "My World"` selects `run/worlds/My World`
- `--world-path "My World"` resolves a relative path from `run/worlds/`
- `--world-path /absolute/path/to/World` uses an absolute path directly
- if neither flag is provided, the existing interactive or prompt-based world picker is used
- `--world-name` and `--world-path` are mutually exclusive

## What It Does

- Extracts archive files, including nested `.mcpack` files inside `.mcaddon` archives
- Detects whether a pack is a behavior pack or resource pack from `manifest.json`
- Copies packs into `run/behavior_packs/` or `run/resource_packs/`
- Registers packs in the selected world's JSON files
- Audits installed packs and world registrations without modifying files
- Warns about missing dependencies, invalid files, and old manifest versions
- Moves processed input from `run/install/` to `run/installed/`
- Writes a plain-text execution log to `run/logs/latest.txt` and keeps the 5 most recent timestamped logs

## Folder Structure

- `run/install/`: drop `.mcaddon`, `.mcpack`, `.zip`, or extracted pack folders here
- `run/installed/`: processed files and folders are moved here
- `run/behavior_packs/`: installed behavior packs
- `run/resource_packs/`: installed resource packs
- `run/worlds/`: world folders containing `level.dat` and pack JSON files
- `run/logs/`: `latest.txt` plus the 5 most recent timestamped run logs

## Project Layout

- `bedrock_pack_installer.py`: thin CLI entrypoint
- `bedrock_pack_installer/cli.py`: startup and argument handling
- `bedrock_pack_installer/commands.py`: install, uninstall, rebuild, zip, world edit, and audit command handlers
- `bedrock_pack_installer/install.py`: install workflow and dependency checks
- `bedrock_pack_installer/worlds.py`: world selection and world JSON helpers
- `bedrock_pack_installer/manifests.py`: manifest parsing and pack classification
- `bedrock_pack_installer/nbt.py`: `level.dat` NBT helpers for world edits
- `bedrock_pack_installer/paths.py`: shared project paths
- `bedrock_pack_installer/console.py`: console output and shared app state
- `bedrock_pack_installer/constants.py`: shared pack/archive constants

## Requirements

- Python 3.10+
- `nbtlib>=2.0.4`
- `pytest>=8.0.0` and `pytest-cov>=5.0.0` for testing
- `ruff>=0.9.0` for linting
- `pyinstaller>=6.0.0` for standalone builds
