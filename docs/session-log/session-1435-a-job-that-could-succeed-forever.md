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

## Addendum — the APPROVED review's non-blocking notes

Five notes, all addressed.

**A second stale list, in the file the PR itself edited.** The watchdog's own last-resort
notice (the by-hand workflow-name list) was updated for #4504; ten lines up in the same
header, a hand-copied cron-offset list was not — the identical staleness class this PR set out
to close, reproduced in its own diff. Rather than fix-and-perpetuate a second copy, the header
now points at `WATCHED`'s own `why` fields instead of repeating the list, and says why: two
hand-maintained copies of the same facts is the defect, not any one stale entry, and a
regex-based cross-check guard over free-form English prose would itself be the kind of brittle
text scanner this file's own `stripComments` doc already warns against. Removing the second copy
is stronger than policing it.

**A derivation that didn't cover its own newest entry.** `check-workflow-liveness.mjs`'s
`maxAgeHours: 200` docstring explained the Monday/Tuesday weekly lanes but not Thu 16:17
(`fuzz-corpus-refresh.yml`), whose tick-to-cron offset (3h20m) is smaller than this repo's
measured weekly-cron lag (3.15h–6.25h) — unlike the other lanes' 13–15h offsets. Re-derived
independently rather than copying the review's number: worst-case age ≈ 168h + 3h20m − 3.15h ≈
**168.2h**, ~31.8h of headroom under 200h. That is lower than the review's own ~170.5h estimate;
both land comfortably under 200h with headroom in the same range as the Monday/Tuesday lanes'
~33h, so the conclusion (200h needs no change) holds either way — the discrepancy is reported
rather than silently resolved. The `selfTestWindows` bound that hardcoded the old "167h" figure
was bumped to 168.2h to match, and mutation-tested (widening it to 300h reds 5 assertions;
restored `cmp`-identical).

**The first alert is not a failure.** `fuzz-corpus-refresh.yml` had zero scheduled runs on
merge, so the watchdog's first tick reports it `never-ran` — and `never-ran` is documented as
NOT short-lived, holding for up to ~7 days until the Thursday cron actually fires. The watchdog's
own header calls out its one-day version of this as expected; the same sentence is now in this
workflow's header too, so the first alert isn't read as a real break.

**An asymmetric failure guarded only by a comment.** The keep-alive cache key
(`fuzz-corpus-keepalive-…`) sat inside the fuzz lane's own `fuzz-corpus-` namespace. Verified
first: `scheduled-deep-checks.yml`'s fuzz-lane restore step reads `restore-keys: | fuzz-corpus-`
— a prefix match — so the old key name would in fact have collided the day someone swapped
`actions/cache/restore` for `actions/cache` (a one-word "simplification"). Renamed to
`keepalive-fuzz-corpus-…`, which does not start with `fuzz-corpus-` and so cannot be picked up
by that restore-keys fallback under any future write path.

**`actions/checkout` on a restore-only job.** Checked whether anything else in the job needs it:
the cache-restore step's `path:` is just a string the action extracts into, and the only other
step reads env vars. Nothing is load-bearing, so the checkout step was removed, with a comment
recording why.

Verification: `check-workflow-liveness.mjs --self-test` (76 checks) and
`file-scheduled-failures.mjs --self-test` both green, exit 0, read unpiped; both edited workflow
files parse as YAML. The `selfTestWindows` change was falsified against a copy (mutated bound →
RED, exit 2; restored `cmp`-identical).
