# Credits and Asset Licences

This file records where the game's art came from and under what terms. It is
the attribution required by the licences below, so it must travel with the
assets: if you redistribute this project, keep this file.

## OpenTibia sprite pack — Creative Commons Attribution 4.0 International

Three boss sprites in `client/assets/` are derived from the OpenTibia community
sprite pack.

- **Title:** OpenTibia sprite pack
- **Author:** the OpenTibia community contributors listed in the pack's
  `AUTHORS.md` (roughly fifty artists, credited individually there)
- **Source:** <https://github.com/peonso/opentibia_sprite_pack>
- **Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0) —
  <https://creativecommons.org/licenses/by/4.0/>
- **Licence text as shipped with the pack:** `opentibia_sprite_pack/LICENSE.txt`

CC BY 4.0 permits reuse and modification, including commercially, provided the
user gives appropriate credit, links the licence, and indicates that changes
were made. The three points above are that credit. **The sprites below were
modified**: they were cut out of the pack's sprite sheets and re-levelled from a
magenta key to a transparent background.

### Per-sprite provenance

Each sprite records the exact sheet and tile it was cut from, so the derivation
can be checked or redone. `tools/slice_sprite.py` is the tool that did it.

| File | Mob type | Source sheet | Tile (col,row) | `--region` |
|---|---|---|---|---|
| `client/assets/boss_ice_dragon.png` | `ice_dragon` | `sprite_sheets/otsp_creatures_02.png` | 2,1 | 1 |
| `client/assets/boss_skeleton_king.png` | `skeleton_king` | `sprite_sheets/otsp_creatures_04.png` | 1,4 | 2 |
| `client/assets/boss_spider_queen.png` | `spider_queen` | `sprite_sheets/otsp_creatures_02.png` | 8,12 | 1 |

Reproduce any of them with (`--region N` and `--at` are per-creature — see below):

```
python tools/slice_sprite.py \
    --sheet opentibia_sprite_pack/sprite_sheets/otsp_creatures_02.png \
    --at 2,1 --out boss_ice_dragon.png --region 1 --autocrop
```

`--region N` takes the tile's row plus `N-1` rows below it. It is **not** a
constant, and getting it wrong is the failure mode that looks like a broken
slicer:

- **Too small** and the creature is decapitated. The demons of
  `otsp_creatures_04.png` are drawn taller than their row and spill into the one
  below, so they need `--region 2`; at `--region 1` only a red smear and a spear
  survive.
- **Too large** and the region reaches the *next* creature, and because
  `--autocrop` measures the subject, that second creature inflates the bounding
  box and gets scaled in alongside the first. The spider at (8,12) came out as
  two spiders at `--region 2`, and one at `--region 1`.

`--autocrop` measures the creature and fits it to a 32x32 cell, bottom-anchored,
with NEAREST so the pixels stay hard. It is needed because the sheets are not
reliably aligned to the 32px grid; `tools/sprite_sheet_index.py` draws a
labelled grid over a sheet if you need to find a tile's coordinates by eye.

Magenta is keyed by **flood fill from the tile edges**, not by a global colour
threshold, so magenta enclosed by the creature's own outline is kept rather than
punched out as a hole.

### A limit worth stating plainly

The pack credits its contributors by name but does not record which artist drew
which sprite — `AUTHORS.md` is a flat list, and `sprites_by_author/` holds
per-artist sheets that are not indexed against the compiled sheets these tiles
came from. So per-sprite author attribution cannot be determined from the pack's
own metadata, and this file credits the pack as a whole rather than guessing.
The authoritative list of contributors is the pack's `AUTHORS.md`, linked above.

### What is NOT in this project

Two other sprite collections exist in the working tree and are deliberately
excluded, via `.gitignore`:

- `tibia_sprites_repo/` — sprites from various versions of Tibia, no licence
  file. Proprietary, owned by CipSoft International.
- `tibia_sprites_zip/` — a raw dump of Tibia's client sprite archive, one file
  per sprite id. Proprietary, owned by CipSoft International.

Neither is committed, and no asset under `client/assets/` is derived from
either. They are kept locally for reference only. Art from them must not be
added to this project or to anything it publishes: modifying or recolouring
CipSoft's sprites produces a derivative work that remains their copyright, and
is not made permissive by being altered.

## Original art

The remaining sprites in `client/assets/` — the four character classes, the
gather nodes, the terrain tiles, and the non-boss creatures — were generated
for this project and are covered by the repository's own licence. They are
produced by keying a magenta background to transparency; see the
`*_magenta_*` intermediates and `process_all_magenta.py`.
