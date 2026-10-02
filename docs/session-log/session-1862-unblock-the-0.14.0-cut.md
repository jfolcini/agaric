# Session 1862 — unblocking the 0.14.0 cut: REMOVE AFTER markers and the rust-toolchain pin (#4885)

Cutting 0.14.0 would fail `remove-after-markers` on the bump commit: the
three baseline-ratchet guards (`check-json-parse-cast.mjs`,
`check-lib-layering.mjs`, `check-strict-invoke-optout.mjs`) carry
`REMOVE AFTER 0.14.0 (#4885)`, and each says the burn-down is its own PR,
not a release's. The markers move to 0.15.0 and nothing else changes. The
baselines still hold 9, 12 and 8 entries, so the 0.15.0 cut hits the same
wall unless someone burns them down first.

The first push bumped only two of the three; the reviewer caught
`check-json-parse-cast.mjs:74`.

## Verified

`node scripts/check-remove-after-markers.mjs --worktree` in a scratch
worktree with `tauri.conf.json` at 0.14.0 exits 1 on
`check-json-parse-cast.mjs:74` at the first push's head, and 0 with all
three markers at 0.15.0.

## The rust-toolchain pin moved again

The second push's `lint` went red on zizmor `ref-version-mismatch` at all
twelve `dtolnay/rust-toolchain` call sites: upstream moved `v1` from
`02cb101e` onto `7e38f4b4` (dtolnay/rust-toolchain#186, a retry loop around
`rustup toolchain install` on release-server checksum failures; verified
merge commit, `action.yml` only). Same move as #5116. It also blocks the
release, whose `validate` job runs `prek run --all-files`.

`prek run zizmor --all-files` passes with the twelve pins moved; putting
the old pin back in a copy of `ci.yml` fails it again.
