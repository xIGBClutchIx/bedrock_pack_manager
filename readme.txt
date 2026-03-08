Bedrock Pack Installer
======================

Setup:
  pip install -r requirements.txt

Usage:
  python bedrock_pack_installer.py                    Install packs from install/ folder
  python bedrock_pack_installer.py --rebuild          Rebuild world JSONs from existing packs
  python bedrock_pack_installer.py --zip              Zip worlds, behavior_packs, resource_packs
  python bedrock_pack_installer.py --beta             Enable Beta APIs in a world's level.dat

Flags can be combined:
  python bedrock_pack_installer.py --beta --zip

Folders:
  install/          Drop .mcaddon, .mcpack, .zip files here
  installed/        Processed files get moved here
  behavior_packs/   Extracted behavior packs
  resource_packs/   Extracted resource packs
  worlds/           World folders (level.dat, pack JSONs)
