# Session 3394 — CI without a merge queue

Follow-up to #6319 (session 3374). GitHub offers its merge queue only to
organization-owned repos, and this one belongs to a personal account, so the
queue #6319 prepared for can never be enabled. The maintainer changed the
ruleset instead: no approving review required, no last-push approval, and the
strict up-to-date flag off.

This PR aligns the repo with that ruleset:

- `branch-protection-assert.yml` expects it exactly: no `merge_queue` rule,
  strict off, review count 0, last-push approval off. Its daily run had been
  red since #6319, which expected a queue.
- Every `merge_group` trigger and its handling are gone (`dco.yml`,
  `e2e-tauri-weekly.yml`, `_validate.yml`, `classify-changes.sh` and its
  test), restored to their pre-#6319 text, since nothing can fire them.
  `ci.yml` keeps the single `ci-main` concurrency group.
- The merge step in the batch-issues skill, `.github/AGENTS.md` and
  `docs/architecture/ci-and-tooling.md` is now a plain squash merge on the
  checked head once the three required checks are green. The queue's
  replacement is the maintainer's rule: a PR whose own files changed on
  `main` since its merge base merges `main` in and re-runs CI first.

Ran: `prek run --all-files` and `prek run --hook-stage manual --all-files`.
The ruleset was read back with a GET to confirm what the assert now expects.
