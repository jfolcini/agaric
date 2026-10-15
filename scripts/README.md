# Scripts

Repo-level helper scripts. Selected scripts; the full guard-hook suite is
indexed in `prek.toml`. Most are invoked indirectly (pre-commit hooks,
`package.json` scripts, CI workflows).

| Script | What it does | Invoked by |
| --- | --- | --- |
| `fix-appimage-icons.sh` | Backfill AppImage icon paths in the bundled Linux artifact. | Release tooling (manual). |
| `patch-android-build.sh` | Tauri Android build post-processing (aarch64 + x86_64 only, 64-bit Rust targets — see AGENTS.md §Android). | Tauri CLI via `tauri.conf.json`. |
| `prepare-external-bins.mjs` | Stage the `agaric-mcp` stub (and any future external sidecars) next to the app bundle under the per-platform suffix `tauri-cli` expects. | Tauri build hook. |
| `seed-worktree.sh` | Idempotently seed a fresh `git worktree add` checkout (node_modules symlink, the gitignored `.env` beside `src-tauri/.env.example`, migrated dev DB, upstream fix; `--mcp` opt-in). See CONTRIBUTING.md § Working in a `git worktree`. | Operator, manually, right after `git worktree add`. |
| `test-related-rust.sh` | Run only the Rust tests whose modules touch files staged in the current commit. | `prek` pre-commit hook. |
| `test-related-ts.sh` | Run only the Vitest tests whose files touch files staged in the current commit. | `prek` pre-commit hook. |
