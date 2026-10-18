# Scripts

Repo-level helper scripts. Selected scripts; the full guard-hook suite is
indexed in `prek.toml`. Most are invoked indirectly (pre-commit hooks,
`package.json` scripts, CI workflows).

| Script | What it does | Invoked by |
| --- | --- | --- |
| `classify-changes.sh` | Classify a diff into the CI lanes it must run (fail-closed: anything it cannot classify runs everything). | `_validate.yml` `detect-changes`, `codeql.yml`, `e2e-tauri-weekly.yml`. |
| `fix-appimage-icons.sh` | Backfill AppImage icon paths in the bundled Linux artifact. | Release tooling (manual). |
| `patch-android-build.sh` | Tauri Android build post-processing (aarch64 + x86_64 only, 64-bit Rust targets — see AGENTS.md §Android). | Tauri CLI via `tauri.conf.json`. |
| `prepare-external-bins.mjs` | Stage the `agaric-mcp` stub (and any future external sidecars) next to the app bundle under the per-platform suffix `tauri-cli` expects. | Tauri build hook. |
| `seed-worktree.sh` | Idempotently seed a fresh `git worktree add` checkout (node_modules symlink, the gitignored `.env` beside `src-tauri/.env.example`, migrated dev DB, upstream fix; `--mcp` opt-in). See CONTRIBUTING.md § Working in a `git worktree`. | Operator, manually, right after `git worktree add`. |
| `test-related-rust.sh` | Run the tests of the Rust crates a change touches and of every crate depending on them (nextest `rdeps()`); staged, range or working-tree diff. | Pre-push Phase D (`--range`); `just test-be-related` (`--worktree`). |
| `test-related-ts.sh` | Run the Vitest tests that import a changed file, or read a changed fixture or `bindings.ts` through `fs`; staged, range or working-tree diff. | `prek` pre-push hook (staged); pre-push Phase C (`--range`); `just test-fe-related` (`--worktree`). |
