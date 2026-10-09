# Session 1987 — bump three guard kill-dates to 0.17.0 for the 0.16.0 cut

Cutting 0.16.0 failed at the bump commit: the `remove-after-markers` hook
found three `REMOVE AFTER 0.16.0` markers (#4885) in
`scripts/check-json-parse-cast.mjs`, `scripts/check-lib-layering.mjs` and
`scripts/check-strict-invoke-optout.mjs`.

Each marker allows a bump if the diff says why. Why: the maintainer asked for
a release today, and burning a baseline down is its own PR, not a release's.
The three burn-downs are tracked in #5469 with 0.17.0 as the deadline; this
is the third bump, so the next cut should not take another.

The release preflight would have caught this before the bump: the REMOVE
AFTER check at the target version belongs in it.
