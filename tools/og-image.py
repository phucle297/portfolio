#!/usr/bin/env python3
"""Build public/og.png: a 1200×630 cover crop of the Hello key-state still (d-0.png).

The still is the end of the Hello hold (tools/render-stills.mjs, p = 0.06), so the print is fully
developed and already carries the owner's name and role. Crop is cover, vertically centred: the
still is 1440×900 (8:5), the OG size is 1200×630 (40:21), so only height is trimmed (72 px top and
bottom at still resolution) and then scaled with LANCZOS.

Regenerate after the stills change:
    python3 tools/og-image.py

Needs Pillow. The committed PNG is the artifact that ships; this script is the recipe.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
STILL = ROOT / "src/_pages/home/ui/stills/d-0.png"
OUT = ROOT / "public/og.png"
OG_WIDTH = 1200
OG_HEIGHT = 630


def cover_crop(image: Image.Image, width: int, height: int) -> Image.Image:
    source = image.convert("RGB")
    src_w, src_h = source.size
    crop_h = round(src_w * height / width)
    if crop_h > src_h:
        raise SystemExit(f"still {src_w}×{src_h} is too short to cover {width}×{height}")
    top = (src_h - crop_h) // 2
    return source.crop((0, top, src_w, top + crop_h)).resize((width, height), Image.Resampling.LANCZOS)


def main() -> None:
    if not STILL.is_file():
        raise SystemExit(f"missing still: {STILL}")
    image = cover_crop(Image.open(STILL), OG_WIDTH, OG_HEIGHT)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, "PNG", optimize=True, compress_level=9)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {image.size[0]}×{image.size[1]})")


if __name__ == "__main__":
    main()
