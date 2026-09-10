# Session 1674 — four kill-dates moved past the release they were set for

Cutting 0.12.0 tripped `remove-after-markers`: #4885 stamped four guard
baselines with `REMOVE AFTER 0.12.0`, and every one still has entries. The
hook offers two exits — burn the baseline down, or bump the marker and say
why in the diff. Burning four baselines down is four PRs of migration work,
not something a release cut should carry, so each marker moves to 0.13.0
with its remaining count written beside it. The pressure #4885 wanted is
intact: the next cut asks the same question, with the number in view.

## Verified

`node scripts/check-remove-after-markers.mjs` green against the working
tree at the 0.12.0 manifests it was red against; nothing else changed.
