# Session 1709 — the watchdog blamed a queued `main` run the next merge had cancelled

`#3388` reopened twice this month with the same row: `ci.yml` "failure (newest
completed push run concluded `cancelled`)". Both times nothing was red. The run
it pointed at (`34533348730`, the #4956 merge, 2026-09-10 21:39Z) had no jobs at
all: it was cancelled at 21:47, the minute the #4953 merge queued its own run.
`ci.yml`'s concurrency group is `ci-${{ github.ref }}` with `cancel-in-progress`
false on `main`, and that setting protects the RUNNING run only. GitHub keeps
one pending run per group and cancels the older pending one when a newer
trigger queues, so on a day with merges minutes apart the superseded `main`
runs conclude `cancelled` by design. Today's merges produced two more
(`fd8ffca38`, `f5e785504`).

`scripts/check-workflow-liveness.mjs` judged a push-watched lane on its newest
COMPLETED run and `file-scheduled-failures.mjs` counts every result but the
literal `success` as failing, so a superseded cancelled run was a red row the
moment the watchdog ticked before the newer run finished. At the 21:48Z tick
the list was: the #4953 run queued, the cancelled #4956 run, the #4944 run still
in progress, and behind them the #4952 merge's genuinely failed run.

The judged run is now the newest completed one that is not a `cancelled` run
with something newer above it, in a `judgedRun` helper shared by
`classifyWorkflow` and `newestCompletedRunId` so the row and its streak id
cannot disagree. A cancelled run with nothing newer is still judged as
cancelled: nothing followed it, and a manual cancel of the newest run should
stay visible. Against the tick above the lane would have reported the #4952
failure, which was real, and recovered on the next tick when the #4954 run
succeeded.

## Verified

- `node --test scripts/check-workflow-liveness.test.mjs`: 5 passed. The file is
  new; the classifier had no tests. It is wired into `_validate.yml`'s `lint`
  job beside `pr-diff-base.test.mjs`, named explicitly per that step's comment.
- Falsified against a copy: with `judgedRun` reverted to the old
  `find((r) => r.status === 'completed')`, four of the five cases fail (the
  tick-shaped case reports `cancelled` instead of `success`; the "waits for the
  newer run" case reports `cancelled` instead of `no-completed-run`; the
  older-real-failure and two-cancelled cases likewise). The fifth, "the newest
  run being cancelled with nothing after it is still a failure", passes under
  both, which is the behaviour it exists to pin. Copy restored, `cmp` clean.
- Not run here: the watchdog itself. The next scheduled tick, or a
  `workflow_dispatch` of `workflow-watchdog.yml`, is the end-to-end check;
  #3388 should close itself on the first tick that sees a settled `main` run.

## Not done

- Why `ci.yml` is judged on `main` push runs at all when every merge's checks
  were green on the PR is the design recorded in the script's header; not
  revisited.
- Three Playwright formatting specs in `e2e/toolbar-and-blocks.spec.ts` failed
  together on the `fc093b7a6` `main` run (17 s each, "element(s) not found" in
  the static render after save) and passed on the two runs after it with no
  editor change in between. Noted, not investigated.
