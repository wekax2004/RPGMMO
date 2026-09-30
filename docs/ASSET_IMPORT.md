# RPG Asset Import

The visual asset set from `https://github.com/wekax2004/RPG.git` was imported
under:

```text
client/assets/rpg-import/
```

## Status: published, in violation of the rule below

This file originally said the import was "intentionally ignored by Git until
licensing is confirmed", and that because the source repository had no root
`LICENSE` file, "the files must not be published or distributed yet".

**That rule was not followed.** The files have been tracked in this repository
and present on `origin/main` since the initial commit `f624f26` (2026-09-25).
`.gitignore` never listed `rpg-import/`, so `git add` picked the directory up
along with everything else.

The current state:

| | |
|---|---|
| Files | 67 under `client/assets/rpg-import/` |
| Size | 56.3 MB |
| On `origin/main` | yes, all 67, since `f624f26` |
| Source repository licence | none — GitHub reports `"license": null` for `wekax2004/RPG` |
| Source commit | `acf42ef3a0628ecbe73f6f901d0405eda96ec3db`, path `public/assets/` |
| Referenced by client or server code | **nothing** |
| Listed in `.gitignore` | no |

Nothing in the game loads any of it. The client renders through its own sprites
and the procedural renderer, so this is not a case of working art being shipped
by accident — it is unused files that should never have been published.

## What would resolve it

This is an ownership question, and the answer is not in this repository. It is
the project owner's to make.

1. **The art is yours.** Licence it in the source repository, record the
   attribution in `CREDITS.md`, and keep the assets. Nothing else changes.
2. **Ownership is unclear.** Remove them. See the note below on how.

## Removing them, and what that does not do

A normal commit that deletes the directory stops the files being served from the
working tree and stops the problem growing. It **does not unpublish them**: the
blobs stay in git history, and anyone who has already cloned the repository has
them.

Unpublishing requires rewriting history — `git filter-repo` over the
`client/assets/rpg-import/` path, followed by a force-push. That rewrites every
commit from `f624f26` onward, so every existing clone and fork needs recloning,
and commit ids change throughout. It is deliberate and effectively irreversible,
so it is not done here and should not be done casually.

## Integration gate

Before wiring any of these assets into the renderer:

1. Resolve ownership/licence of every imported image. **This is unmet**, and until
   it is, the files should not be in this repository at all.
2. Add required attribution to `CREDITS.md`.
3. Create a manifest mapping asset IDs to world entity types.
4. Add an offline asset-loading test.
5. Render sprites with a procedural fallback.
6. Verify the isometric/2.5D coordinate transform in the current camera.

The current game continues to use its procedural renderer, so steps 2–6 have not
started and none of them are blocked by the licence question.
