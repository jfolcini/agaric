# Session 1722 — the 0.13.0 cut bumps three REMOVE AFTER markers (#4885)

`scripts/release.sh 0.13.0` passed the local release build and then the
bump commit failed `remove-after-markers`: the three baseline-ratchet
guards (`check-json-parse-cast.mjs`, `check-lib-layering.mjs`,
`check-strict-invoke-optout.mjs`) carry `REMOVE AFTER 0.13.0 (#4885)`,
and each says the burn-down is its own PR, not a release's. This PR is the
"bump the version and say in the diff why not" arm of that instruction:
the three markers move to 0.14.0 and nothing else changes. The three
baselines still hold 9, 13 and 8 entries, so the next cut hits the same
wall unless someone burns them down before 0.14.0.

The staged manifest bump from the failed attempt was reverted and the
release is re-cut on the merged result.

## Verified

`node scripts/check-remove-after-markers.mjs` against a 0.13.0
`tauri.conf.json` reports no expired markers with the bump applied; the
same run reddens with the markers at 0.13.0.
