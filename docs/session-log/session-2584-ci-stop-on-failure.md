# Session 2584 — a failing CI job stops the PR's other jobs

**Ask:** the maintainer: a failing job, the PR collision job for one, let the
rest of the PR's jobs run to the end, wasting CI slots and time.

**Design.** GitHub has no workflow-wide fail-fast. A step `if: failure()` that
cancels its own run would turn the failing job's red into `cancelled` (the
runner merges Failed with Canceled into Canceled), and the checks list would
no longer say which job failed. So each gating job gets a tiny
`stop-after-<job>` job that starts only once it has failed, and calls
`_stop-pr-ci.yml`: it cancels every unfinished run of the PR's head commit,
its own run last, and leaves the Claude workflows running (the review judges
the code, and a new push re-runs it). Every API failure there is a warning:
a fork or Dependabot token is read-only, and a run may finish between the
listing and the cancel.

**Where:**
- `_validate.yml`: one per job `validate-all` reads. The vitest, Playwright
  and cargo-tests matrices fail fast on a PR, because `needs:` on a matrix
  waits for every shard; pushes to main keep every shard's result.
- `dco.yml`: after `dco`.
- `pr-overlap.yml`: after `merge-result` and `session-log-pr-collision`.
  The latter fails closed on "could not verify", so an API blip there now
  stops the PR's CI too.
- `ci.yml` and `release.yml` grant `actions: write` to their `validate`
  caller; a nested job can't ask for more than its caller grants.
- `scripts/check-pr-overlap-trust-boundary.mjs` lists `_stop-pr-ci.yml` as a
  trusted write-scoped target (#4183): it runs no PR code and holds only
  `actions: write`. Pointing the job at another local workflow is still
  flagged.

**Not triggers:** CodeQL, the e2e-tauri smoke and mutation-pr are not
required, and an infrastructure failure there must not cancel the gate. They
are cancelled when a gating job fails. `ci.yml`'s `build` and
`android-build` need `validate`, so nothing of CI runs beside them.

**`validate-all`** stays out of the stop jobs and they stay out of its
`needs`. It runs `if: always()` after the cancel and fails closed on a
cancelled job.

**Shown:** the stop script, pulled out of the YAML and run against a stub
`gh`, cancels the unfinished non-Claude runs with its own last, and a failing
listing or cancel only warns. Each case went red under its mutation: the
Claude exclusion removed, the own run cancelled first, the own-run warning
dropped. The nested permission grant can only be shown by a real run, which
is this PR's own.

**Costs:** fourteen more skipped rows in a PR's checks list. A flaky or
infrastructure failure in a gating job now cancels the rest, so a re-run
re-runs them all. A run shows only the first red shard's failures.
