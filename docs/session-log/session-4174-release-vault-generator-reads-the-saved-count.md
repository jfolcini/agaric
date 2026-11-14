# Session 4174 — The release vault's generator reads the saved count

`scripts/release.sh 0.24.0` stopped at its release-vault step: `tests/fixtures/release-vault/generator.rs` no longer compiled. `save_engines_and_advance_cursor` now returns a `SavePass`, and the generator still compared its result with a number. Nothing had been bumped, tagged or pushed.

## What shipped

- The generator's two calls read `.saved` from the pass.

## Traps

- No cargo target holds the generator. `scripts/gen-release-vault.sh` copies it into `src-tauri/examples/` of a throwaway worktree, so neither `cargo clippy --all-targets` nor CI compiles it, and a change to an API it calls shows only at the next release.
- `release.sh` builds the frontend in the checkout it runs from. A `node_modules` older than `package-lock.json` fails its build check with a missing module; run `npm ci` first.

## Suites run

The generator copied to `src-tauri/examples/gen_release_vault.rs` and `SQLX_OFFLINE=true cargo check --example gen_release_vault`: it compiles. Not run: the generator itself and the upgrade test over its vault, which `release.sh` runs next; the Rust suites, which compile nothing this changes.
