# Session 1509 — a dispatch that is the cron

**Ask:** the weekly deep checks are needed off-cycle (#3443's next slice waits on a mutants run the maintainer cancelled), so a `workflow_dispatch` of `scheduled-deep-checks.yml` should behave exactly like the Monday cron, and then be run.

**What differed.** Three jobs told the two triggers apart, each its own way. `file-fuzz-findings` was gated `if: … github.event_name == 'schedule'` and did not run at all on a dispatch. `file-mutation-survivors` ran but passed `--dry-run` on every non-`schedule` event, so a dispatch never filed survivors. `report-scheduled-failures` had the rule the other two lacked (#3960): a dispatch on `refs/heads/main` with every input at its declared default reproduces the cron and writes; anything else dry-runs. It also passed `--skipped-ok` off the schedule, purely because the fuzz filer legitimately read `skipped` there.

**The change.** That rule becomes one workflow-level `env` value, `CRON_EQUIVALENT`, and the three writer steps read it: `--dry-run` unless it is `true`. The fuzz filer's job gate goes (it runs on every event, like the mutation filer has since #3394) and the reporter's own copy of the input checks goes with the four env vars that fed it. `--skipped-ok` is no longer passed: no lane is gated on the event now, so a skipped lane is a real failure on every authoritative run. The `check-mutants-scope` guard, which pins that the mutation filer selects `--dry-run` from an event variable, now looks for `CRON_EQUIVALENT`; its self-test fixture follows.

**Verified locally:** the guard's self-test (28 assertions) and its real run, `zizmor --offline` on the workflow (no findings), a YAML parse showing the folded expression as one line. Hooks were skipped on the commit; zizmor's online audits and actionlint run in CI's `lint` lane. Hooks hang locally on `.github/` changes.

**Next:** merge, then dispatch on `main` with the defaults. That run's `file-mutation-survivors` writes for real, which is the input #3443's next slice needs.
