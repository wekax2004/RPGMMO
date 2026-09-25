# RPG Asset Import

The visual asset set from `https://github.com/wekax2004/RPG.git` is staged
locally under:

```text
client/assets/rpg-import/
```

The import is intentionally ignored by Git until licensing is confirmed.
The inspected repository did not contain a root `LICENSE` file, so the files
must not be published or distributed yet.

## Integration gate

Before wiring assets into the renderer:

1. Confirm ownership/license of every imported image.
2. Add required attribution to the project.
3. Create a manifest mapping asset IDs to world entity types.
4. Add an offline asset-loading test.
5. Render sprites with a procedural fallback.
6. Verify the isometric/2.5D coordinate transform in the current camera.

The current game continues to use its procedural renderer until this gate is
complete.
