# Session 4187 — The release's macOS jobs get 90 minutes

On the 0.24.0 tag (run 43591828865) the `aarch64-apple-darwin` leg of `build-and-release` was cancelled at its 60-minute limit, in "Upload macOS updater signature", its last upload step. The `x86_64-apple-darwin` leg took 51 minutes. Linux took 30 of its 90 and Windows 39 of its 75.

## What shipped

- `release.yml`'s `build-and-release` gives the macOS legs 90 minutes, as Linux has. The 60 came from one measured build of 50 minutes plus 10 for signing, attesting and uploading.

## Traps

- A re-run of a tag's release run uses the workflow file at that tag, so this does not change a re-run of 0.24.0.
- The cancelled leg had already uploaded `Agaric_0.24.0_aarch64.dmg`, `Agaric_0.24.0_aarch64.app.tar.gz` and its `.sig` to the draft release before it was cut off.
- On both macOS legs the "Build frontend" step took over 20 minutes and "Install Tauri CLI for signing" about 7. Neither was looked into.

## Suites run

The pre-commit hooks on the workflow file (actionlint, zizmor). Nothing else reads the value.
