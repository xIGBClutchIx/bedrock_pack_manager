# Bedrock Pack Installer

Install Minecraft Bedrock behavior packs and resource packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.
All runtime data lives under `run/` so the project root stays clean.

## Setup

```bash
pip install -r requirements.txt
```

## Testing

```bash
pytest
```

Coverage is enabled by default through pytest configuration. Running `pytest` will print a terminal coverage report and write `coverage.xml`.

## Usage

```bash
python bedrock_pack_installer.py --help
python bedrock_pack_installer.py
python bedrock_pack_installer.py --rebuild
python bedrock_pack_installer.py --zip
python bedrock_pack_installer.py --beta
python bedrock_pack_installer.py --rebuild --beta
```

## What It Does

- Extracts archive files, including nested `.mcpack` files inside `.mcaddon` archives
- Detects whether a pack is a behavior pack or resource pack from `manifest.json`
- Copies packs into `run/behavior_packs/` or `run/resource_packs/`
- Registers packs in the selected world's JSON files
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
- `bedrock_pack_installer/commands.py`: rebuild, zip, and beta command handlers
- `bedrock_pack_installer/install.py`: install workflow and dependency checks
- `bedrock_pack_installer/worlds.py`: world selection and world JSON helpers
- `bedrock_pack_installer/manifests.py`: manifest parsing and pack classification
- `bedrock_pack_installer/nbt.py`: `level.dat` NBT helpers for experiment toggles
- `bedrock_pack_installer/paths.py`: shared project paths
- `bedrock_pack_installer/console.py`: console output and shared app state
- `bedrock_pack_installer/constants.py`: shared pack/archive constants

## Requirements

- Python 3.10+
- `nbtlib>=2.0.4`
