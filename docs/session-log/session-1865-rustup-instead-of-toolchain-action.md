# Session 1865 — CI installs Rust with rustup, not dtolnay/rust-toolchain

The maintainer asked why the weekly `scheduled-deep-checks` run kept going red.
The two latest reds were already fixed on main. 09-21 was zizmor
`ref-version-mismatch` on the `dtolnay/rust-toolchain` pin. 09-28 was an
`import_parse` fuzz crash, fixed by #5228. But the first one recurs: upstream
moves its `v1` tag whenever it pushes, the SHA under our `# v1` comment goes
stale, and the online audit fails. It was re-pinned by hand four times
(#3434, #4502, #5116, #5230), each after a red run.

The action is now gone. A local composite, `.github/actions/rust-toolchain`,
runs `rustup toolchain install <toolchain> --profile minimal
--no-self-update` with the same `components` / `targets` inputs, then
`rustup default`. It also sets `CARGO_INCREMENTAL=0` and
`CARGO_TERM_COLOR=always` only when unset, which is the replaced action's
behaviour. Every call site changes only its `uses:` line. No SHA, no tag,
nothing to drift.

Left out on purpose: the action's rustup bootstrap, because the 0.14.0
release run's Windows and macOS logs show it was a no-op (rustup ships on
every image); its version-alias parsing ("stable minus N releases"), unused
here; and its env shims for Rust 1.66–1.71.

## Verified

The action's script, run locally with `components` and `targets` set and
with empty inputs, exits 0 and writes only unset env vars. actionlint and
zizmor pass. The PR's CI runs the desktop bundle and Android builds through
it, and a dispatched `clippy-clean,fuzz` deep-checks run covers the
components and nightly paths. `release.yml` only runs on a tag push. It uses
the same `rustup toolchain install` command the replaced action ran on its
Windows/macOS legs.
