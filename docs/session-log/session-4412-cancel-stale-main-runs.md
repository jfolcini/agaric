# Session 4412 — a newer main push cancels the stale run, and main diffs against its last green run

**Ask.** Cancel stale CI runs on `main`. They queued one behind another (`cancel-in-progress` off for `main`), so a merge's verdict waited behind a run of a commit it already contained, and held runners PR gates needed.

**Why this needs the diff base too.** `detect-changes` diffed a main push against `github.event.before`, the commit before it. A lane that diff skipped reported green over its own last red: `540c286`'s main run failed `cargo-tests`, and `3f6aad8`'s run, a timings-only diff, skipped `cargo-tests` and turned main green while the Rust lane was still broken. Cancelling a superseded run widens the same hole: the cancelled commit's files never reach any diff.

**Change.**
- `ci.yml`: one group per ref, `cancel-in-progress: true` for every ref.
- `_validate.yml` `detect-changes`: on a push to `main`, a `base` step looks up the head sha of main's last successful CI run and the classifier diffs against it. A failed or empty lookup writes the all-zero sha, which `classify-changes.sh` already treats as unresolved and answers with the full set. The job gains `actions: read`; both callers (`ci.yml`, `release.yml`) already grant `actions: write`.

**Shown.**
- The `base` step's script, run against the repo: `sha=3f6aad8…` (main's last green run); against a repository that does not exist: the all-zero sha.
- `classify-changes.sh` on main's push `ca26ffa`: with the old base (`3033d4e5`) `rust_tests=false`; with the new base (`3f6aad8`) `rust_tests=true` and every lane whole; with the all-zero base "Base sha unresolved: running the full set".

**Trade-off.** In a burst of merges `main` gets no verdict until the burst ends, and the jobs that save the shared Rust caches (main only) can be cancelled before saving. The newest run always completes once merges pause, and it now covers everything since the last green run.

**Ran:** the pre-commit hooks on both workflows (zizmor, actionlint where wired).
