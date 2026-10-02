# Session 1862 — the 0.14.0 cut bumps three REMOVE AFTER markers (#4885)

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
