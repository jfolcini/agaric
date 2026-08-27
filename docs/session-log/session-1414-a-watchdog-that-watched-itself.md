# Session 1414 — a watchdog that watched itself

#4456 and #4185. Both are CI robustness, and #4456 is the purest instance this session
found of the failure the whole night kept circling: a mechanism that reports success from
the absence of evidence.

## The dead cron was structurally exempt

The watchdog escalates a lane after N consecutive observations, and it keys "consecutive"
on the identity of the newest completed run — sensibly, because it polls daily while most
watched workflows run weekly, so it must distinguish "the same failure seen again" from
"a new failure".

`newestCompletedRunId` returned that id regardless of the verdict. For a `stale` lane —
one whose schedule has stopped firing — there is no new run, so the id never changes, so
the streak never advanced past one, so **the worst failure mode the watchdog exists to
catch was the one case it could never escalate.** The watchdog's own liveness signal was
derived from the thing whose death it was supposed to report.

The fix omits the `runId` key entirely for `stale`, which makes the streak fall back to the
watchdog's own run URL — one poll, one occurrence. That is not a new idea; the deep-checks
profile already works that way. Note the shape: it must be an **absent key**, not an
explicit `null`, because `advanceStreaks` treats `undefined` as "use the fallback" and
`null` as "hold". Review confirmed those two really do diverge in the source rather than
taking it on trust, which mattered — had they been equivalent, the fix would have been a
no-op wearing the costume of a fix.

## The gate on that fix was itself a deny-list

The first version keyed the behaviour on `!result.startsWith('stale (')`. That answers
"carry the frozen id" for every verdict that does not yet exist — so the moment someone
adds `schedule-disabled (…)`, or rewords `stale`, #4456 is reborn silently.

It is now an allow-list of verdicts known to carry a meaningful run id, so an unrecognised
verdict escalates on polls and fails loud instead. This is the third time tonight that a
deny-list turned out to be the actual defect, and the second time inside a fix written to
correct exactly that class.

## A residual, stated rather than papered over

There is a state the fix does not reach. `classifyWorkflow` returns `never-ran` when the
considered-run list is empty, and only reaches `stale` by inspecting `considered[0]` — so a
workflow with *no runs at all* stays `never-ran` no matter how much time passes, holds its
null identity, and never escalates. GitHub disables scheduled workflows in repositories
that go quiet, which is precisely how a lane arrives in that state and stays there.

The first pass asserted in a comment that `never-ran` "resolves into `stale` once
`maxAgeHours` elapses". It does not, and cannot. That claim was checked by classifying an
empty run list at one day, thirty days and a year — all `never-ran`.

The behaviour was left alone, deliberately. The null-hold for `never-ran` is a rule a
previous review adopted on purpose, and reversing it here would contradict that decision
without its author present. What changed is that the code now *states* the residual instead
of asserting the opposite, and it is filed rather than left in a comment, because a workflow
that never fires and is never escalated has a named victim.

## The prose was false for the exact case it was written about

The escalation text said a lane "failed that many DISTINCT observed runs", and the issue
body added "(a run that did not happen does not count)". Both are false precisely for a
dead cron, whose entire count is made of runs that did not happen — the case the change
exists to support. Reworded to observations.

The instructive part is downstream: `announcesEscalation` had two disjuncts, and correcting
only the prose would have left the second one matching nothing forever. Every negative
control would have stayed green, because the first disjunct still matched. A dead disjunct
inside an OR is invisible to the test suite by construction.

## A number, and the part of it nobody had measured

`#4185`'s first half is a differentiated timeout so a hung `install-deps` is reported as a
hung install rather than an undifferentiated job-cap kill. The bound is 25 minutes, derived
from the step's own constants — 300s attempt-1 bound, 30s SIGKILL grace, 180s lock poll,
760s measured cold-mirror attempt-2 — totalling 21m10s, plus about 18% headroom.

The arithmetic checks out and the constants are literal values in the same step. But the
justification "comfortably 5 minutes inside the 30-minute job cap" quietly assumed the step
begins when the job begins. Review measured 26 real Playwright jobs: the preamble is 25-43
seconds, so the true margin is 4m17s, and the correlated worst case (an apt lock wait firing
exactly when apt is sick) is 223s — still inside. The differentiation is real, but it was
resting on a figure nobody had gathered, and it now says so.

Two other corrections: the 1270s sum is the cache-**hit** worst case; on a miss both attempts
are unbounded and the total exceeds the new cap, which makes a standing note about the miss
path keeping "its 30-minute budget" false.

**#4185's second half is deliberately not fixed, and the PR does not claim it.** A step bound
does nothing about a *succeeding* 21-minute setup leaving a nine-minute shard racing the job
cap; and any bound tight enough to protect the shard would sit below the legitimate worst case
and start failing healthy runs, which is a mistake this repo has already made once. The real
options are raising the cap or splitting setup into its own job, and that is a decision the
issue asked for and this work does not make. So the issue stays open with the state recorded,
rather than being closed on half a fix.

## The prose the fix made false

Review found the same defect one paragraph above where this batch had just fixed it. The
escalation text explaining `weeklyEscalation: true` said "three observations really are three
weeks unfixed" — true while only genuine weekly failures could reach three, and false the
moment stale lanes started counting daily polls. The change that made stale lanes escalate
made its own neighbouring sentence wrong.

It now says three observations are three of whatever is actually happening: three of the
lane's own weekly runs for a failing lane, three of the reporter's daily polls for a dead
cron. Both true, and the distinction is the point.

The `false` branch had a subtler version of the same problem. Its justification — that the
profile's units are jobs inside a single scheduled run rather than workflows with their own
cadence — was hard-coded behind a **generically named boolean**. A future daily-cadence
profile would legitimately set `weeklyEscalation: false` and render an explanation that is
false for it. That is the deny-list-by-shape trap this batch spent its time arguing against,
reappearing in the prose selector rather than in a guard.

The fix moves the justification onto the profile: a profile that caps escalation must now
supply its own reason, and the sentence is derived from the profile rather than from the
boolean. Two assertions pin it — that the rendered body contains the profile's own string
verbatim (proving derivation rather than a copy), and that every capping profile declares
one.

## Ruling out a path instead of testing it

One note asked whether manual `workflow_dispatch` runs could now compress three days of
polls into an afternoon, since stale streaks key on the watchdog's own run URL and each
dispatch has a distinct one.

The honest answer turned out to be that the path does not exist. The filer appends
`--dry-run` for any non-schedule event, and under dry-run `main` computes the streak and the
body and then returns before any write. A dispatch run's computed escalation is discarded
every time, so there is no path by which manual runs advance the persisted count.

Writing a test for that would have been worse than useless — it would assert a behaviour the
wiring makes unreachable, and would keep passing if the wiring changed. The finding is
recorded at the `--dry-run` conditional itself, where someone removing it will read it.

## What shipped

- #4456 — stale lanes escalate on poll identity; the gate is an allow-list; the N=3 promise
  is profile-conditional and now honest for both profiles; the `never-ran` residual is stated
  and filed.
- #4185 note 1 — a differentiated 25-minute bound on install-deps, with the preamble measured
  rather than assumed. Note 2 left open by decision.
