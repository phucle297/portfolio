#!/usr/bin/env python3
"""Merge Instrument Serif latin + latin-ext woff2 files into one file per style.

Why: @fontsource ships two unicode-range faces per style. The layout preloads the latin
files, but WebKit does not treat a preloaded file as satisfying a unicode-range @font-face,
so it downloads the same ~43 KB again (latin 400 + italic). One @font-face per style with
no unicode-range, pointing at a single merged woff2, lets every browser use the preload.

Sources are the @fontsource/instrument-serif package already in the repo. Output:

    src/app/fonts/instrument-serif-400.woff2
    src/app/fonts/instrument-serif-400-italic.woff2

Needs fontTools and brotli (see the header of fonts-instrument-serif.css). Regenerate with:

    python3 tools/build-instrument-serif.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import compress, decompress

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "node_modules/@fontsource/instrument-serif/files"
OUT = ROOT / "src/app/fonts"

STYLES = {
    "instrument-serif-400.woff2": [
        "instrument-serif-latin-400-normal.woff2",
        "instrument-serif-latin-ext-400-normal.woff2",
    ],
    "instrument-serif-400-italic.woff2": [
        "instrument-serif-latin-400-italic.woff2",
        "instrument-serif-latin-ext-400-italic.woff2",
    ],
}


def woff2_to_ttf(src: Path, dest: Path) -> None:
    decompress(str(src), str(dest))


def merge_style(out_name: str, parts: list[str], work: Path) -> Path:
    ttfs: list[Path] = []
    for part in parts:
        src = SRC / part
        if not src.is_file():
            raise SystemExit(f"missing fontsource file: {src}")
        dest = work / f"{src.stem}.ttf"
        woff2_to_ttf(src, dest)
        ttfs.append(dest)
        print(f"  decompressed {src.name} -> {dest.name} ({dest.stat().st_size} bytes)")

    merger = Merger()
    font = merger.merge([str(p) for p in ttfs])
    merged_ttf = work / f"{Path(out_name).stem}.ttf"
    font.save(str(merged_ttf))
    out = OUT / out_name
    out.parent.mkdir(parents=True, exist_ok=True)
    compress(str(merged_ttf), str(out))
    # Confirm the expected glyphs survived the merge.
    merged = TTFont(str(merged_ttf))
    cmap = merged.getBestCmap() or {}
    for char in "Phúc Lê Đàm":
        if char == " ":
            continue
        if ord(char) not in cmap:
            raise SystemExit(f"{out_name} is missing U+{ord(char):04X} {char!r}")
    merged.close()
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return out


def main() -> int:
    if not SRC.is_dir():
        raise SystemExit(f"fontsource files not found at {SRC} (run bun install)")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for out_name, parts in STYLES.items():
            merge_style(out_name, parts, work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
