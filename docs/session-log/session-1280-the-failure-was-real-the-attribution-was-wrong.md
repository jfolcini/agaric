# Session 1280 — the failure was real, the attribution was wrong

**Date:** 2026-08-09
**Issues:** #3652, #3661, #3646, #3655, #3650, #3653, #3622, #3623, #3637, #3642, #3643,
#3641, #3606, #3635, #3625 (done); #3656, #3659, #3661, #3664, #3667 (filed)
**PRs:** #3651, #3657, #3658, #3660, #3662, #3663, #3665 (merged); #3666 and the
scheduled-checks child-issue branch (open)

A batch session run at width — five worktrees at a time — against the tech-debt and
testing backlog. The through-line is not that things were broken. It is that when they
broke, **they named the wrong culprit**, and the cost was always in the diagnosis rather
than the fix.

Four independent instances, none of which were in the issue that led to them.

## The test that fails one day in seven

Two PRs went red simultaneously on `validate / playwright` shard 3. One of them
(#3657) changes only `.py`, `.sh` and `.toml` and cannot touch a browser test. That
simultaneity was the whole signal: a shard that reddens on every open PR at once is not
coming from any of them.

`weekly-reschedule-drag.spec.ts` drags a task onto `reschedule-drop-zone-${today + 1}`.
`WeeklyView` renders one week, so on the last day of that week "tomorrow" is in the next
one and the drop zone does not exist. The locator then waits out
`scrollIntoViewIfNeeded`'s 15s timeout — on the first attempt and both retries, so the
retry budget buys nothing. Reproduced on clean `main` at `c1268dd6c`: 1.1m, essentially
all of it in timeouts.

Today was a Sunday, which is what made it visible. It reddens on whichever weekday is
last in the rendered week, and `weekStartsOn` is a user preference, so which weekday that
is can move.

The spec had already written the assumption down — a comment describing today as
"(mid-week)". That is why it read as background detail rather than as a precondition. The
fix reads the target from the DOM: the rendered drop zones are the only authority on which
days are on screen, so it cannot drift from `weekStartsOn` and needs no second copy of the
app's week arithmetic in the test. Filed as #3661, fixed in #3662, and both tests now run
in 14.7s.

## The lane that was already green

#3394 listed `mutants` and `file-mutation-survivors` as failing. Investigating the actual
runs showed `mutants` had been fixed by #3392 on 2026-08-04 — five days earlier — and
`file-mutation-survivors` had never had a defect at all: its entire failing log is one
line refusing to run because the lane upstream produced no artifact, which is the #3364
guard working as designed.

The reason the record was wrong is the interesting part. `file-mutation-survivors` was
gated `if: github.event_name == 'schedule'`, so the dispatch run that *proved* `mutants`
healthy skipped it, and the reporter dry-runs itself off the schedule. A lane could
therefore be green for a week with no mechanism able to say so. The gate protected a real
rule — #2947, a smoke run must never rewrite the tracking issue — but that rule belongs on
the step, not the job. Moving it there makes a dispatch a real end-to-end check.

Nothing about `mutants` itself was re-fixed. The temptation to "fix" a lane that is
already working, because an issue says it is broken, is exactly the failure this session
kept running into.

## The canary that was never planted

#3635 reports that a runaway-extraction canary "dies before it reaches the sandbox, so it
proves nothing". On inspection the canary **did not exist as code**: `zizmor-hook.sh`
asserted in a comment that the guarantee "holds and is tested", and `grep -n runaway`
finds only comments. A guard that is documented but not implemented reads exactly like one
that passes.

Re-anchoring the window at `^OS=` → EOF caught 28 interceptions, matching the 28 mutating
invocations #3559 measured independently. A second near-miss surfaced while building it:
counting on stderr would have been nearly vacuous too, because `setup-hooks.sh` runs
installers as `cmd >/dev/null 2>&1` — only 4 of 28 reach stderr and none of those is an
installer.

## The type errors nobody could see

#3606: `e2e/**.ts` was type-checked by no tsconfig, so type errors there could not fail
any gate. Ten real errors had accumulated — tuple indexing under
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` violations, six
`textContent(): string | null` values fed into `toHaveText()`.

They were *visible the whole time*: the editor LSP reports them. That is precisely why the
gap survived — a human opening the file sees red squiggles and assumes something upstream
must care.

## What the guards taught us about guards

Three separate guard defects this session shared a shape: the guard's model of the world
was subtly narrower than the world.

- `check-dynamic-sql`'s marker rule was a *physical line offset*, so `cargo fmt` — which
  owns line offsets — could orphan a valid marker and redden a passing file at
  pre-commit. Verified with real `rustfmt --edition 2021`. It now follows the statement.
- `package_is_installed` compared `dpkg-query`'s `${Status}` against an exact string.
  `dpkg-query` renders its format once per record with no separator, so on a multi-arch
  host a present package returned `install ok installedinstall ok installed` and read as
  **missing** — raising "will not compile or test" on a fully provisioned box.
- The overflow guard's containing-block model predated Tailwind v4's independent
  `translate`/`scale`/`rotate` properties and `content-visibility`.

And one flake found by accident while measuring: `setup-hooks.sh`'s Test 1c piped `awk`
into `grep -q` under `pipefail`. `grep -q` exits on match, `awk` dies of SIGPIPE, the
pipeline returns 141. Measured **3 failures in 40 runs on HEAD**, at pre-commit. Zero in
60 after.

## Coverage that was decorative

#3646: the canonical order for reconstructing prior state is
`(created_at DESC, seq DESC, device_id DESC)`, and no fixture anywhere seeded the
cross-device `(created_at, seq)` collision the `device_id` component exists to break.
Deleting `, device_id DESC` from any of the four hand-copied scans in `reverse/batch.rs`
left the whole suite green.

`seq` is per-device, so the fixture is cheap: two devices' first ops both carry `seq = 1`.
The subtlety was ordering — the first attempt seeded the winner first, copying the
existing #3281 fixture, and two of the four copies stayed undetectable because the
attachment scan's partial index reverses the row order the text and position scans
produce. Running every fixture under **both write orders** states the actual property:
the tie-break decides, not the row order.

Final matrix: 8 sites RED, 2 GREEN — and the two GREEN ones are documented equivalent
mutants, proven by `EXPLAIN QUERY PLAN` to be served by an index whose key already ends in
`device_id`. The clause stays because it is the specification, not a consequence of the
current index.

## A bug that reproduced, and an issue that was half right

#3652 predicted that `register_received_blob`'s `INSERT OR IGNORE` could orphan a live
row's `content_hash`. It reproduced — but the mechanism needed correcting. A receive only
reaches that statement when the existing mapping is already **stale**, because a healthy
one makes the #1993 content-addressed skip fire and no transfer happens at all.

The fix went on the write side, not the prune side: pointing the index at bytes whose
existence has just been proven, rather than teaching the GC to preserve a mapping that may
point at bytes that no longer exist. #3371 already settled that direction.

## Policy change: expensive gates should file work, not just fail

Acting on maintainer direction this session: expensive gates stay weekly rather than
becoming blocking PR checks, but a finding should produce issues — a rolling parent with
current status, and children carrying the individual fixes.

A survey of the nine lanes found the parent half exists and the child half exists nowhere,
plus five lanes whose finding content never reaches an issue at all (`clippy-clean`,
`bench-smoke`, `bench-slo`, `prek-all-files`, `full-suite`) — `bench-slo` being the one
whose findings carry a measured number. The mutation parent #3142 had saturated at 261
survivors across 9 areas in a 40,756-character body with nothing assignable.

Children are keyed on the **area**, the unit a maintainer actually fixes, with dedup that
adopts an orphaned child rather than duplicating it, and a design where a quiet week
issues zero writes. The rest is tracked in #3667 rather than half-built.

## Filed

- **#3656** — a fresh worktree with no `node_modules` fails pre-push as five unrelated
  lint failures, two of them guard *self-tests*, with nothing in the output naming the
  cause. Cost a full verify cycle to diagnose.
- **#3659** — `dynamic-sql-baseline.txt` has drifted, so `--update-baseline` rewrites five
  unrelated entries into your diff. `block_ops.rs` sits nine sites above its ratchet,
  which is the finding, not the bookkeeping.
- **#3664** — `typecheck:e2e-tauri` is invoked by no gate and is red on `main` today.
- **#3667** — the deferred half of the parent/child gate design.

## Also recorded, not fixed

#3579 asks for the android release timeout to be re-derived from a real cold tag build. No
qualifying run exists: the cache removal landed 2026-08-07, the most recent release ran
2026-07-31. Worth recording anyway — the warm job took **15.0 min**, against the 27.8 the
current estimate's arithmetic is built on, so the derivation's starting term looks
pessimistic by roughly 3x. Left open with the data attached rather than closed on a number
nobody measured.
