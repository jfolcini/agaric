# Session 3349 — CI merge queue

Merges had stalled: the ruleset required branches to be up to date, so every
merge sent every other PR behind and its re-run queued behind 30+ Actions
runs, while `ci.yml` kept one full `main` run per commit.

The maintainer approved two changes, both intended as reversals of earlier
rules:

- `main` shares one `ci-main` concurrency group without cancel, so only the
  newest `main` commit is tested. This gives up #3672's per-commit verdict; the
  merge queue now tests each merge before it lands. `codeql.yml` already
  worked this way and `scorecard.yml` cancels, so neither changed.
- The required contexts run on `merge_group`. `classify-changes.sh` treats a
  merge group like a PR over `base_sha..head_sha` (one new test, shown red
  with the branch removed), and the migrations backstop and the advisory
  gating read the same range. `dco` passes a merge group without scanning,
  because the queue admits only PRs whose own commits passed `dco`. The
  bundle and Android builds skip merge groups: they are not required and the
  post-merge `main` run builds them. `branch-protection-assert.yml` now
  expects a `merge_queue` rule and a false strict flag.

Trap: the ruleset's `pull_request` rule wants one approving review and only
the admin role bypasses it, so a PR nobody approved, which is every own and
Dependabot PR, may not be able to enter the queue. An admin bypass merge
skips the queue, and with the strict flag off nothing then tests the merged
result.

Ran: `src/__tests__/classify-changes.test.ts`, `prek run --all-files` and
`prek run --hook-stage manual --all-files`.
