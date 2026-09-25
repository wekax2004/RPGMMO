# RPG Art Assets

Art source:

- Repository: https://github.com/wekax2004/RPG
- Source path: `public/assets/`
- Commit: `acf42ef3a0628ecbe73f6f901d0405eda96ec3db`

These are the project's own art assets, carried over from the RPG repository
when the two codebases were consolidated. They are tracked in git and are part
of the shipped client.

Notes:

- `processed/` and `sprites/` are the output of the asset pipeline in
  `scripts/`; the raw files at the top level are the inputs.
- The duplicated `*_1768*` files are byte-identical copies produced by an
  earlier re-run of the pipeline. They are kept for now and can be pruned.
- See `docs/ASSET_IMPORT.md` for the integration status of each asset group.
