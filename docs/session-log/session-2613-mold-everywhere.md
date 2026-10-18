# Session 2613 — every local Rust build links with mold

The maintainer's call on #5847: mold is the linker. CI already links with
it; locally, `setup.sh` wired it only into the checkout it ran in, and
`.cargo/config.toml` is gitignored, so every `git worktree add` checkout,
where agents build, linked with the system default.

- `ensure_fast_linker` moves to `scripts/lib/fast-linker.sh`, which
  `setup.sh` and `seed-worktree.sh` both source; `seed-worktree.sh` wires
  the config as its fourth step, and leaves an existing one alone.
- `setup-system-deps.sh` installs `mold`, and counts it with `patchelf` as
  optional when reporting what is missing. `setup.sh` wires the linker
  after installing the system packages, so a first run finds mold.
- `BUILD.md`, `CONTRIBUTING.md`, `scripts/README.md` and the config example
  say mold is the linker, lld the fallback when mold is absent.

Ran: shellcheck and `bash -n`; `seed-worktree.sh` in a fresh worktree
(wired mold) and again (left it untouched); prek on every file.

Closing #5847 with it: the build-once `cargo-tests` archive is dropped,
and `needs: validate` on `build` and `android-build` stays.
