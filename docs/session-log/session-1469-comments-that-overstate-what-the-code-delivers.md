# Session 1469 — four CI fixes, and three comments that overstated what the code delivers

Shipped #4454, #4185, #4478 and #3579 on one branch. The unifying result was not any of the four
fixes; it was that **three separate comments in this diff claimed more than the code did**, which is
precisely the defect #4454 was filed about, reproduced three times inside the change that fixes it.

## #4454 — the probe now runs where the launch runs

`release.yml`'s AppImage boot smoke probes `dbus-run-session` before deciding whether to keep it on
the final attempt. The probe ran standalone; the real launch runs
`setsid xvfb-run -a dbus-run-session -- …`. A bus that starts standalone but not under `xvfb-run`'s
environment passed the probe and still failed the attempt. The surrounding comment scoped its "not a
full guarantee" caveat to *time* only and said nothing about environment — the larger gap.

The probe is now wrapped identically to the launch. Two things had to be said honestly rather than
papered over:

The budget. The comment justified the timeout with "the dbus-only probe measured at a few hundred
ms" — presented as measured, with no source, for a probe the maintainer had already established
**has never executed in a release**. Timing `dbus-run-session -- true` locally gives 0.09s / 0.00s /
0.00s. `xvfb-run` is not installed on this machine, so the Xvfb term is genuinely unmeasurable here
and is now labelled an ESTIMATE, with the bound described as deliberately loose rather than derived.

The attribution. Wrapping the probe in `xvfb-run` means a broken or absent Xvfb now also lands in the
"cannot start a bus" branch. That is a *third* limitation, introduced by the fix, in a change whose
whole subject is a caveat that enumerated one limitation and omitted another. The annotation now says
the probe cannot separate the two causes, and why dropping dbus is still the right response either
way.

Items 3 and 4 were dropped on the maintainer's instruction; the line numbers in the issue body had
rotted, so the first attempt edited the wrong lines and was reverted by hand.

## #4185 — the split does not do what the decision said it would

The maintainer chose "split install-deps into its own job so setup and test each get their own
budget" over raising the job cap. The split shipped, and the framing does not hold: **system-dependency
installation is per-runner dpkg state and cannot cross a job boundary.** The shards still run
install-deps themselves — four times now, not once — and a shard's budget is still shared with its own
setup.

What actually crosses the boundary is the `.deb` and browser-binary *caches*, and that is a real gain:
before, the three shards ran in parallel and so could never warm each other within a run. Cache keys
were verified byte-identical in both jobs, and the save genuinely precedes the shards because `needs:`
bars them until setup's post-save step completes. So the split buys cache warming, and **the thing
that actually relieves the budget conflict is the shard cap moving 30 → 35.** The first draft's header
said the combined budget was "no longer shared with any shard's own test-run time"; the file's own
body contradicted it fifteen lines later. It now says what is true.

The one failure mode worth checking was whether a failing `playwright-setup` could produce a silently
green gate. It cannot: `validate-all` is `if: always()`, `playwright-setup` is not in its `needs:`, a
needs-skipped `playwright` classifies as `skipped`, and `check_job playwright false` is a gate
failure. The classifier-failure path pins `frontend=true`, so it fails closed there too.

## #4478 — a state, not a clock

A workflow that has never run could never escalate, because the `stale` branch is reached only by
inspecting `considered[0]` and there is no `considered[0]`. The issue left the fix open between three
options; the maintainer's comment settles it on reading the workflow's `state`, because GitHub
disabling a schedule for inactivity is a state and not a duration, and a clock "can only ever be
tuned, never made correct".

The classification is an allow-list on `active`, so `disabled_manually`, `disabled_fork` and anything
GitHub adds later all escalate rather than falling through. An unreadable state is its own third
verdict — the uncertainty is reported, not resolved into either direction — which is how this file
already treats a missing run list.

Two corrections to the record. The cost argument cited "11 lanes" from
`grep -c "workflow: '"`; `WATCHED` holds **7**, and the other five matches are self-test fixtures. And
the first draft asserted the residual comment it must not delete "remains true of the code as
written" — it does not, since that paragraph explicitly describes "a schedule GitHub never enabled"
as held at count 1 forever, which is exactly the lane this change moves. The paragraph is kept
unedited, as the issue requires, and the meta-claim now states which clause is superseded.

## #3579 — measured at last, and one word too many

Three cold tag builds now exist, so the 90-minute timeout stops being an estimate standing in for a
measurement: 26.58 / 26.53 / 26.73 minutes, and the dominant term #3542 could not measure is the
~19-minute cold aarch64 build. The whole job costs less than the 27.8-minute *warm* figure the
original 60 was derived from. Applying the repo's +50% rule to the observed maximum gives 40.

The claim "spread over nine days" was wrong and was the sort of wrong that matters, because that
sentence is the entire justification for a 3.4× tightening: 0.9.7 and 0.9.8 ran on the **same day**,
1h40m apart. Three runs on two days. Replaced with the 12-second spread and an explicit note on
sample independence.

Two figures in the first draft of the measurement table were invented rather than read — 0.9.7's build
time and 0.9.9's CLI install — and were caught only by re-fetching the per-step timestamps. Publishing
a number as measured is a claim; the check is cheap and the claim is not.
