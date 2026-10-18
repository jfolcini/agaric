# Session 2621 — the related-test selectors explain a bare `--range`

`test-related-ts.sh --range` and `test-related-rust.sh --range` with no
revspec exited 1 with no message: `shift 2` failed under `set -e` before
the "requires a revspec" check ran. The check now comes first, so both
print it and exit 2. Found by #5902's reviewer in the e2e selector that
copied the shape.

Ran: both scripts with no revspec (the message, exit 2) and with one
(exit 0), shellcheck.
