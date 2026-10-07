# Session 1911 — unblocking the 0.15.0 cut: REMOVE AFTER markers (#4885)

Cutting 0.15.0 would fail `remove-after-markers` on the bump commit: the
three baseline-ratchet guards (`check-json-parse-cast.mjs`,
`check-lib-layering.mjs`, `check-strict-invoke-optout.mjs`) carry
`REMOVE AFTER 0.15.0 (#4885)`. Their baselines still hold 9, 12 and 8
entries, unchanged since the 0.14.0 cut, so session 1862's warning came
true. The maintainer chose to bump the markers to 0.16.0 again rather than
hold the release for the burn-down, which each marker says is its own PR.
This is the second deferral in a row; the 0.16.0 cut hits the same wall.

The other release preflights were clean on `origin/main` at `71029bcfd`:
`prek run zizmor --all-files` (online) and `npx better-npm-audit audit`
both pass.

## Verified

`node scripts/check-remove-after-markers.mjs --worktree` with
`tauri.conf.json` at 0.15.0 exits 1 on all three lines on `origin/main`,
and 0 with the markers at 0.16.0. Setting the version to 0.16.0 flags all
three again, so the markers still fire.
