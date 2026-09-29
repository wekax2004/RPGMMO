#!/usr/bin/env python3
"""
tools/slice_sprite.py

Cuts one 32x32 tile out of a sprite sheet and writes it as a transparent PNG.

Magenta keying
--------------
The OpenTibia sheets are drawn on a flat magenta (#FF00FF) backdrop, which has
to become transparency. The obvious implementation is a global threshold --
"any pixel close enough to magenta is background" -- and that is wrong in a way
that only shows up later: it also erases magenta that is genuinely part of the
creature. A purple cloak, an amethyst, a glowing eye. The result is a sprite
with a hole in it that nobody notices until it is in the game.

So this keys by FLOOD FILL FROM THE EDGES instead. A pixel is background only
if it is magenta-ish AND reachable from the tile border through magenta-ish
pixels. Magenta enclosed by the creature's own outline is interior, and is kept.
A magenta key that cannot reach an edge is not a backdrop.

Antialiasing
------------
The sheet's edge pixels are blends between the creature and the backdrop, so
they are not pure magenta and a strict test leaves a magenta fringe. After the
flood fill, one pass of alpha feathering is applied: pixels adjacent to a
transparent pixel lose alpha proportionally to how magenta they are. This is
what keeps a sprite from wearing a pink halo against dark cave rock.

Usage:
    python tools/slice_sprite.py --sheet SHEET.png --col 2 --row 1 --out NAME.png
    python tools/slice_sprite.py --sheet SHEET.png --at 2,1,3,1,4,1 --out dragon.png
        (--at takes col,row pairs; a multi-tile --at produces a horizontal strip)
"""
import argparse
import os
import sys
from collections import deque

from PIL import Image

# How far a pixel may stray from pure magenta and still count as backdrop.
# The sheets are flat, so this can be tight; it is loose enough to absorb JPEG
# ringing in any sheet that has been through a lossy step.
KEY_TOLERANCE = 60


def is_backdrop(r, g, b, tol=KEY_TOLERANCE):
    """True when the pixel is close enough to the magenta backdrop to be key-able."""
    return (abs(r - 255) <= tol and g <= tol and abs(b - 255) <= tol)


def flood_key_background(px, w, h, tol=KEY_TOLERANCE):
    """
    Mark every magenta-ish pixel reachable from the border as background.

    Returns a bytearray of 1 for background, 0 for subject. Iterative rather than
    recursive: a 32x32 tile is small, but a whole sheet region is not, and
    Python's recursion limit is not something to rediscover mid-run.
    """
    bg = bytearray(w * h)
    queue = deque()

    def push(x, y):
        i = y * w + x
        if bg[i]:
            return
        r, g, b = px[x, y][:3]
        if is_backdrop(r, g, b, tol):
            bg[i] = 1
            queue.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not bg[i]:
                    r, g, b = px[nx, ny][:3]
                    if is_backdrop(r, g, b, tol):
                        bg[i] = 1
                        queue.append((nx, ny))
    return bg


def feather(tile):
    """
    Soften the boundary left by the key.

    A pixel touching transparency and still carrying backdrop colour is a blend
    pixel. Its alpha is scaled down by how magenta it is, which turns a hard
    magenta fringe into a gradient. Done after the flood fill so the fringe --
    which is NOT magenta enough to have been keyed -- is what gets softened.
    """
    w, h = tile.size
    px = tile.load()
    snapshot = [[px[x, y] for y in range(h)] for x in range(w)]

    for x in range(w):
        for y in range(h):
            r, g, b, a = snapshot[x][y]
            if a == 0:
                continue
            touching = False
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h and snapshot[nx][ny][3] == 0:
                    touching = True
                    break
            if not touching:
                continue
            # Blend factor: 1.0 for pure magenta, 0.0 for a fully opaque subject.
            mag = max(0.0, 1.0 - ((abs(r - 255) + g + abs(b - 255)) / 255.0))
            if mag > 0:
                px[x, y] = (r, g, b, int(a * (1.0 - mag * 0.85)))


def subject_bbox(tile):
    """Bounding box of everything that survived the key, or None if nothing did."""
    alpha = tile.getchannel("A")
    box = alpha.getbbox()
    return box if box and box[2] > box[0] and box[3] > box[1] else None


def fit_to_tile(tile, cell=32):
    """
    Scale a keyed region down to fit a cell and anchor it to the bottom.

    Creatures in the sheets are not reliably confined to one 32px row. Some are
    drawn taller than their row and spill into the next, and some sit with their
    feet below the row they nominally start in. Cropping a fixed 32x32 therefore
    decapitates or amputates them depending on which creature it is.

    So the region is taken taller, the subject is measured, and it is fitted:
    scaled by the tighter of the two axes with NEAREST so the pixels stay hard
    (a smooth resample turns pixel art to mush), then anchored bottom-centre,
    because a creature's feet belong on the tile it stands on.
    """
    box = subject_bbox(tile)
    if box is None:
        return tile.resize((cell, cell), Image.NEAREST)
    crop = tile.crop(box)
    w, h = crop.size
    if w <= cell and h <= cell:
        out = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
        out.alpha_composite(crop, ((cell - w) // 2, cell - h))
        return out
    scale = min(cell / w, cell / h)
    nw = max(1, min(cell, int(round(w * scale))))
    nh = max(1, min(cell, int(round(h * scale))))
    scaled = crop.resize((nw, nh), Image.NEAREST)
    out = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
    out.alpha_composite(scaled, ((cell - nw) // 2, cell - nh))
    return out


def slice_tile(sheet, col, row, cell=32, tol=KEY_TOLERANCE, feather_edges=True,
               region=None, autocrop=False):
    """
    Pull one creature out of the sheet.

    `region` is how many pixels tall to take, in cell units (1 = a single 32px
    row, 3 = the row plus two below it). It only matters with `autocrop`, where
    a taller region gives the fitter something to measure.
    """
    x0, y0 = col * cell, row * cell
    height = cell * (region if region else 1)
    if x0 + cell > sheet.width or y0 + height > sheet.height:
        raise ValueError(
            f"tile ({col},{row}) region is outside the sheet: it needs "
            f"{x0 + cell}x{y0 + height} but the sheet is {sheet.width}x{sheet.height}"
        )
    tile = sheet.crop((x0, y0, x0 + cell, y0 + height)).convert("RGBA")
    w = cell
    bg = flood_key_background(tile.load(), w, height, tol)
    px = tile.load()
    for y in range(height):
        for x in range(w):
            if bg[y * w + x]:
                px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 0)
    if feather_edges:
        feather(tile)
    if autocrop or region:
        tile = fit_to_tile(tile, cell)
    return tile


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--at", default="0,0",
                    help="comma-separated col,row pairs; >1 produces a strip")
    ap.add_argument("--cell", type=int, default=32)
    ap.add_argument("--tolerance", type=int, default=KEY_TOLERANCE)
    ap.add_argument("--no-feather", action="store_true")
    ap.add_argument("--region", type=int, default=0,
                    help="take N cell-heights starting at --row, to catch art "
                         "that spills below its nominal row")
    ap.add_argument("--autocrop", action="store_true",
                    help="measure the subject and fit it to a 32x32 cell, "
                         "bottom-anchored, instead of trusting the grid")
    ap.add_argument("--assets", default="client/assets")
    args = ap.parse_args()

    if not os.path.exists(args.sheet):
        print(f"no such sheet: {args.sheet}", file=sys.stderr)
        return 1

    sheet = Image.open(args.sheet).convert("RGBA")
    parts = [p for p in args.at.split(",") if p.strip() != ""]
    if len(parts) % 2 != 0:
        print("--at needs col,row pairs (an even number of values)", file=sys.stderr)
        return 1

    tiles = []
    for i in range(0, len(parts), 2):
        col, row = int(parts[i]), int(parts[i + 1])
        try:
            tiles.append(slice_tile(sheet, col, row, args.cell, args.tolerance,
                                    not args.no_feather, args.region or None,
                                    args.autocrop))
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1

    if len(tiles) == 1:
        out_img = tiles[0]
    else:
        out_img = Image.new("RGBA", (args.cell * len(tiles), args.cell), (0, 0, 0, 0))
        for i, t in enumerate(tiles):
            out_img.alpha_composite(t, (i * args.cell, 0))

    os.makedirs(args.assets, exist_ok=True)
    dest = os.path.join(args.assets, args.out)
    out_img.save(dest, "PNG")

    alpha = out_img.getchannel("A")
    histogram = alpha.histogram()
    transparent = histogram[0]
    print(f"wrote {dest}  ({out_img.width}x{out_img.height}, "
          f"{transparent} fully transparent px of {out_img.width * out_img.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
