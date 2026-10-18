# Session 2568 — three cache and cancellation fixes from #5853

**Gap:** #5853 measured the 20-job concurrency cap and a Rust cache over its
10 GB quota. This PR takes the four items that are one-line workflow edits and
refs the issue without closing it: the cap itself, the ruleset context, the
re-measure tooling and the test-only classifier rows stay open.

**Evidence, from the issue (about 400 runs, 2026-10-18):**
- CodeQL on main: 34 of 46 runs cancelled mid-run, 140 runner-min wasted
  against 179 for the runs that finished.
- `apt-tauri-e2e-Linux-v5`: every e2e-tauri PR run missed it and saved 87 MB
  scoped to `refs/pull/N/merge`, which no other run can restore.
- `rust-cov`: both `cargo-tests` main shards saved one key ("Unable to reserve
  cache").
- Five Dependabot cargo merges in 12 minutes made several `Cargo.lock`
  generations of the Rust keys.

**What changed:**
- `codeql.yml`: `cancel-in-progress` is `${{ github.event_name == 'pull_request' }}`.
  A group holds one pending run, so on main a newer run now waits and replaces
  the pending one instead of killing the running analysis.
- `e2e-tauri-weekly.yml`: the `apt-tauri-e2e` step is now two steps. On
  `refs/heads/main` it stays `actions/cache` (save on a miss, after a green
  run); anywhere else it is `actions/cache/restore`. Main only ever runs this
  workflow from the Monday schedule and `workflow_dispatch`, so the weekly run
  is the one writer, and a main-scoped entry is what PRs restore. The option of
  dropping the step was rejected: a hit saves the apt mirror time the sibling
  lanes record as ~12 min on a bad mirror.
- `_validate.yml`: the `rust-cov` `save-if` adds `&& matrix.shard == 1`. Both
  shards compile the same instrumented tree, so one save loses nothing.

**Item 4 skipped, premise wrong:** `.github/dependabot.yml` already groups the
cargo ecosystem (`tauri`, `sqlx`, `tokio`, `loro`, `opentelemetry`, `tracing`,
`rustls`, `serde`, `chrono`, `iroh` and a `minor-and-patch` catch-all). The
five merges were five of those groups (`tauri`, `serde`, `opentelemetry`,
`minor-and-patch`, plus `fuzz`, which has its own lockfile), each correctly a
separate PR because its members are coupled. Another `groups:` entry would
have to either swallow the coupled stacks or sit behind them and match
nothing. What is left is how the weekly batch is merged (one Cargo.lock
generation per merge to main), or deleting superseded cache generations after
a main save; both stay on #5853.

**Verification after merge:**
- CodeQL: the next two pushes to main close together; the first run must
  finish `success` and the second start after it (no `cancelled` conclusion on
  a main run): `gh run list --workflow codeql.yml --branch main`.
- apt cache: after the next e2e-tauri run on main (Monday 02:43 UTC or a
  dispatch), a PR run's "Restore apt archives" step logs
  `Cache restored successfully` for `apt-tauri-e2e-Linux-v5`, and the PR run
  no longer ends with a "Post Cache apt archives" save.
- `rust-cov`: a main run of `cargo-tests` shows `Rust cache` saving on shard 1
  only, and no "Unable to reserve cache" line on shard 2.

**Guards run:** `prek run --files` over the changed workflows, which covers
actionlint, zizmor, `zizmor-version-pin`, `prek-version-pin` and
`cache-poisoning-suppressions` (the new `actions/cache` step needs no
`zizmor: ignore`, so `EXPECTED_INLINE_SUPPRESSIONS` is unchanged).
