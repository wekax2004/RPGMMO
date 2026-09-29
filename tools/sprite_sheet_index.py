#!/usr/bin/env python3
"""
tools/sprite_sheet_index.py

Renders a sprite sheet with a coordinate grid drawn over it, so a tile can be
identified by eye and then addressed numerically.

The OpenTibia sheets are a plain 32x32 grid, 16 tiles wide. Reading a tile's
coordinates off an unlabelled 512x2048 sheet is guesswork; this makes it a
lookup.

Usage:
    python tools/sprite_sheet_index.py <sheet.png> <out.png> [--cols 16] [--cell 32]
"""
import argparse
import sys
from PIL import Image, ImageDraw

# High-contrast, and deliberately not magenta: the sheets are magenta-keyed and
# a magenta grid would be indistinguishable from the background.
GRID = (0, 255, 255)
LABEL = (255, 255, 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("out")
    ap.add_argument("--cols", type=int, default=16)
    ap.add_argument("--cell", type=int, default=32)
    ap.add_argument("--every", type=int, default=1,
                    help="label every Nth row, to keep the labels readable")
    ap.add_argument("--crop-rows", type=int, default=0,
                    help="only index the first N rows, for tall sheets")
    ap.add_argument("--example", default="0,0",
                    help="a 'col,row' to spell out at the end, e.g. 5,12")
    args = ap.parse_args()

    try:
        src = Image.open(args.sheet).convert("RGBA")
    except OSError as exc:
        print(f"cannot read {args.sheet}: {exc}", file=sys.stderr)
        return 1

    cell = args.cell
    cols = args.cols
    total_rows = src.height // cell
    rows = min(total_rows, args.crop_rows) if args.crop_rows else total_rows

    # Compose onto an opaque dark background: the sheet's own background is
    # transparent-or-magenta depending on how it was saved, and a grid drawn on
    # one of those is hard to see.
    out = Image.new("RGBA", (src.width, rows * cell), (24, 24, 32, 255))
    out.alpha_composite(src.crop((0, 0, src.width, rows * cell)))

    d = ImageDraw.Draw(out)
    for c in range(cols + 1):
        x = c * cell
        d.line([(x, 0), (x, out.height)], fill=GRID, width=1)
    for r in range(rows + 1):
        y = r * cell
        d.line([(0, y), (src.width, y)], fill=GRID, width=1)

    # Label the first tile of every Nth row with "r<row>" at the row's left edge,
    # and the column index along the top.
    for r in range(0, rows, args.every):
        d.text((2, r * cell + 2), f"r{r}", fill=LABEL)
    for c in range(cols):
        d.text((c * cell + 3, 2), f"{c}", fill=LABEL)

    out.save(args.out, "PNG")
    c0, r0 = (int(v) for v in args.example.split(","))
    print(f"{args.sheet}: {src.width}x{src.height}, {cols}x{total_rows} tiles of {cell}px")
    print(f"indexed the first {rows} rows -> {args.out}")
    print(f"example tile (col={c0}, row={r0}) spans x={c0 * cell}..{c0 * cell + cell - 1}, "
          f"y={r0 * cell}..{r0 * cell + cell - 1}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
