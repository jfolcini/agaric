# Session 1245 — the watchdog: closing "the checking machinery never ran"

Follow-up to session 1244 / #3359, in the same defect class:

> A check that cannot fail is worse than no check, because it reads as green.

#3359 gave `scheduled-deep-checks.yml` a notification path and wrote down the hole it could
not close from inside a workflow: *"if the reporting JOB never starts (invalid workflow
file, runner-pool outage, whole-run cancellation before it is scheduled) nothing reports."*
Every in-workflow reporter has that hole by construction — a workflow cannot report its own
non-existence. Four more scheduled workflows had no reporter at all.

## Shipped — #3374

`.github/workflows/workflow-watchdog.yml` + `scripts/check-workflow-liveness.mjs`: an
out-of-band observer on its own daily cron (19:37 UTC, offset from all five watched crons)
that asks GitHub's runs API, per scheduled workflow, two questions:

1. **Liveness** — did a `schedule`-event run start inside the window its cron implies?
2. **Conclusion** — did the newest *completed* scheduled run succeed?

Question 2 is why one workflow closes both halves of #3374: `e2e-tauri-weekly`, `codeql`,
`scorecard` and `branch-protection-assert` now have a failure notification without any of
them being edited. The trade against adding a reporter job to each: notification is delayed
to the next tick (≤24h) and the granularity is the whole run, not the job. In exchange the
report does not depend on the watched workflow being able to run at all — the case the
in-workflow reporters cannot cover, and the case where silence is most dangerous.

**Reuse, not a parallel mechanism.** The classifier emits exactly the shape
`${{ toJSON(needs) }}` has, so `scripts/file-scheduled-failures.mjs` consumes it unchanged.
That filer grew a `--profile` (`deep-checks` | `workflow-watchdog`) carrying only the
tracking-issue title/labels and the rendered nouns; the parts that could get a notification
wrong — the throw on absent input, job-id dedup, the close path clearing the tracked set —
stay single-copy. One rolling issue per profile: the per-workflow-vs-shared question in
#3374 was posed for the design where each workflow files its own report. With one observer
looking at everything in a single pass, the situation is structurally identical to
`report-scheduled-failures`, so the answer is the same. The notification is the *comment*,
and the comment names the specific workflow and how it failed.

**The self-watch is deliberately non-vacuous.** The watchdog is in its own watched set, and
`--exclude-run-id` drops the in-flight run so it grades the *previous* one. Without that it
would be checking whether the run currently executing is alive.

## Findings, all in the "cannot fail" class

- **The old `file://`-template entry-point gate (#3373) was live in
  `file-scheduled-failures.mjs`.** Found by accident: the verification harness ran the
  workflow's `run:` bodies against a checkout whose `scripts/` was a symlink, and the filer
  exited **0 having filed nothing**, silently. Fixed to the sanctioned realpath form. The
  #3373 branch does not touch this file, so it would otherwise have landed as a violation.
- **The wiring guard matched its own documentation.** `findWatchdogWiringProblems` searched
  the raw workflow text for `--exclude-run-id`; deleting the flag from the actual `node …`
  invocation left the guard green, because the workflow's *header comment explains the flag
  by name*. Now every text assertion scans through `stripCommentLines`. Prose about a check
  must never stand in for the check.
- **`buildResults` forwarding the exclusion was untested.** Every classification assertion
  targeted `classifyWorkflow` directly, so dropping the `entry.selfExcluded ? … : undefined`
  ternary in the caller left all of them green while making the self-watch permanently
  healthy. Both gaps were found by mutation-testing the new code, not by review.

Guards added so these cannot regress: `WATCHED` must equal the set of crons on disk in
**both** directions (a new scheduled workflow nobody watches fails the hook); the watchdog
workflow must pass `--exclude-run-id` and `--profile workflow-watchdog` and run on a *daily*
cron (every window is derived from that); every window must satisfy
`period < window < 2×period`, so a window that can never fire within two cycles is not
configurable by accident.

## Residual, stated plainly

If the watchdog stops running **permanently**, nothing reports — self-watch only fires on
the runs that do happen. That includes GitHub disabling a repo's schedules after 60 days
without commit activity, which silences the watched workflows and the watchdog together.
Closing it requires a dead-man's switch outside GitHub (an external uptime monitor this job
pings), which needs a secret and a third-party account — a separate decision, filed as the
#3374 follow-up.

Also left: per-workflow *immediate* notification (a reporter job inside each of the four
workflows) would cut the ≤24h delay and give per-job granularity. Deliberately not built —
it is four diffs to four unrelated workflows plus a duplicated bash fallback each, and it
does not cover the case this session exists for.

## Verification

Every new `run:` body was extracted verbatim from the workflow YAML and executed against a
stubbed `gh` — healthy (no-op, zero writes), stale, failed-conclusion, `gh` non-zero, `gh`
non-JSON, `gh` empty output, `gh` absent (`ENOENT`), real `gh` with a bad token (HTTP 401),
`workflow_dispatch` (dry-run), and each branch of the last-resort notice including both of
its write failures. Fourteen mutants covering every assertion in the new code were injected
into a copy of the tree; all fourteen were killed. `actionlint`, `zizmor`, `oxlint`,
`oxfmt`, `taplo fmt --check`. Not verifiable locally: the real cron firing, and the real
Actions API's `--event schedule` filtering.
