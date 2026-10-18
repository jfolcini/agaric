# Session 2605 — the real-backend lane builds once and runs its specs in 3 shards

#5849's CI items and step 3 of #5853's cache map, in
`e2e-tauri-weekly.yml`.

- **Graph:** `detect` → `build` → `specs` (3 shards, or one leg running the
  listed specs of a spec-only diff) → `e2e-tauri-gate`, which fails closed
  on a failed, cancelled or wrongly skipped build or shard.
- **One compile:** the Tauri CLI already runs `cargo build --bins`, and
  forwards what follows `--`, so `-- -p agaric -p agaric-diagnostics`
  emits the app, `agaric-mcp` and `e2e_sync_peer` together: `agaric`
  compiles once instead of three times. A separate cargo call would
  recompile it anyway, because its build script reruns when `TAURI_CONFIG`
  changes and only the CLI sets it. Adding diagnostics changes no
  dependency's features (`cargo tree -e features`).
- **Warm cache:** `build` restores `rust-mcp` read-only. Two things would
  have kept it from ever matching: `CARGO_TERM_QUIET` was set job-wide, and
  rust-cache hashes every `CARGO*` variable into the key, so it is now set
  only on the cargo steps; and mold was set up after the cache step, which
  changes `.cargo/config.toml` in the key, so the setup now runs in
  `actions/toolchain`'s order, as mcp-tests' does. `rust-e2e-tauri` and
  `apt-tauri-e2e` are gone: `main` runs this lane only weekly, so neither
  ever hit on a PR.
- **Shards:** the artifact (app, both sidecars, tauri-driver,
  `retention-days: 1`) needs no Rust toolchain; each shard installs runtime
  packages only (their dependencies cover every shared library the two
  binaries load, checked on Ubuntu 24.04). WDIO's own split of the real
  config gives 29 + 29 + 28 = 86 files, each once.

Estimates, to measure on this PR's own run: build about 4 min warm,
critical path 17–18 min against 25–27 (shard 3 holds `reminder-due-task`),
and about 33 slot-minutes against 27, with up to three held at once. The maintainer approved the `e2e-tauri/AGENTS.md`
recipe and the `.github/AGENTS.md` cache rule.
