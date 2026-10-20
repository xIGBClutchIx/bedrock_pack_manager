#!/usr/bin/env python3
"""Build the static browser app into dist/site for GitHub Pages or local preview."""

import argparse
import shutil
import zipfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT_DIR / "web"
PACKAGE_DIR = ROOT_DIR / "bedrock_pack_manager"
DEFAULT_OUT_DIR = ROOT_DIR / "dist" / "site"
PACKAGE_ZIP_NAME = "bedrock_pack_manager.zip"


def build_site(out_dir: Path = DEFAULT_OUT_DIR) -> Path:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(WEB_DIR, out_dir)

    # The page unpacks this zip into Pyodide so the browser runs the same Python code as the CLI.
    with zipfile.ZipFile(out_dir / PACKAGE_ZIP_NAME, "w", zipfile.ZIP_DEFLATED) as zf:
        for source in sorted(PACKAGE_DIR.glob("*.py")):
            zf.write(source, f"bedrock_pack_manager/{source.name}")

    (out_dir / ".nojekyll").write_text("", encoding="utf-8")
    return out_dir


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="Output folder (default: dist/site).")
    args = parser.parse_args()
    out_dir = build_site(args.out.resolve())
    print(f"Built site: {out_dir}")


if __name__ == "__main__":
    main()
