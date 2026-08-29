# Session 1435 — a job that could succeed forever

#4504. The fuzz corpus cache is evicted after seven days without access; the fuzz lane runs
weekly, restoring near the start of its run and saving near the end. The save does not count as
an access, so the interval that matters is save-to-next-restore — just under seven days, leaving
almost nothing.

## The margin was not the number the issue carried

The issue's headline said ~25 minutes. The maintainer's own follow-up comment corrected it to
**~17**: restore about 8 minutes in, save about 25 minutes in, so 6d23h43m against a 10080-minute
limit leaves 17. The correction was in the thread rather than the body, which is where a reader
starting from the title would look.

Worth separating what was measured from what was inherited. The 8- and 25-minute timings come
from the maintainer, not from anything reproducible here — no fuzz run is possible in this
environment. The 6.25h maximum cron-delivery lag used to sanity-check the new schedule *is* a
real committed measurement (n=7, already in `check-workflow-liveness.mjs`), but it measures a
different cron than the one being added, and is used as an order-of-magnitude argument rather
than a claim about the new slot. The 3.5-day margin on either side is design arithmetic, not an
observation.

## The fix rests on something GitHub does not document

A restore-only workflow at the midpoint between two fuzz runs refreshes the entry, turning a
17-minute margin into about 3.5 days on each side — even a worst-case 6.25h cron delay leaves
roughly 3d5h.

That only works if a restore actually updates the access timestamp. GitHub's policy says entries
"not accessed in over 7 days" are removed and orders eviction by "last access date", but never
spells out which operations count as an access — and nothing found says whether a `restore-keys`
**prefix-fallback** hit updates the matched entry rather than only an exact-key hit.

So the mechanism is **assumed, not documented**. It is a reasonable assumption — the policy would
be incoherent if only creation time mattered, and it is already the model this repo committed to
in #4503 — but it is the thing the whole workflow is betting on, and the issue's own acceptance
criterion is empirical: the warm/cold line reporting a hit across at least a month.

## The line that would have papered over it

The workflow's success step originally printed `(access timestamp refreshed)`. That asserts the
one mechanism nobody has verified, in a log line that would print every week regardless — and
the job cannot fail on a cache miss either, because a missing corpus emits a warning and exits 0,
matching the fuzz lane's existing non-fatal warm/cold convention.

Together those two properties mean this job could run green every week for months while
accomplishing nothing, with nothing surfacing it. Review named that precisely, and the log line
now says *intended to refresh — unverified mechanism, see #4504*. The behaviour is unchanged; the
claim is not.

That is the difference worth carrying: a job that might not work is acceptable when it says so,
and dangerous when it reports success for the part under test.

## A stale list outside the diff

Adding a watched workflow means updating what watches it. `WATCHED` was updated and verified by
running the code rather than counting by eye — 7, not 6 — and two stale hardcoded counts in
comments were corrected.

Review found a third the file list did not touch: the watchdog's own last-resort failure notice
hardcodes five workflow names for a human to check by hand, and the new one was missing. It fires
only if the watchdog itself breaks, which is exactly when nobody will notice the list is short.
Added.

## Verification

`check-workflow-liveness --self-test` (100 checks) and `file-scheduled-failures --self-test` green;
both workflow files parse; `zizmor` reports nothing on the new file; `actionlint` and the
version-pin guards pass. The `scheduled-deep-checks.yml` edit is comment-only, verified line by
line rather than asserted.

Falsified by removing the new entry from `WATCHED` in a copy: `assertWatchedSetMatchesDisk` throws
naming the file, restored `cmp`-identical.
