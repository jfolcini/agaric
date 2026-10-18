# CI and GitHub configuration

> Workflows, composite actions (`actions/`), Dependabot, zizmor and CodeQL config. What each lane runs is in the header of [`workflows/_validate.yml`](workflows/_validate.yml) and root [`AGENTS.md`](../AGENTS.md) § Pre-commit & CI; what runs locally and what only CI runs is in [`docs/BUILD.md`](../docs/BUILD.md#pre-commit--ci). This file holds what an edit here can break.

## The gate

- **The required context is the check run's full name, `validate / validate-all`,** because `ci.yml`'s `validate` job calls `_validate.yml`; a bare `validate-all` never matched it (#5853). A script that reads CI matches the name by suffix and counts a missing check as a failure, never a pass. `branch-protection-assert.yml` pins the contexts (`EXPECTED_CONTEXTS`) with the rest of the ruleset.
- **`validate-all` aggregates the `_validate.yml` jobs and fails closed per category.** A job that must gate goes into its `needs`, plus a `check_job` line with its category's skip rule; a job left out gates nothing. Aggregators run `if: always()`: a skipped aggregator (a needed job failed) counts as passing.
- **Gate by path through `scripts/classify-changes.sh`, never `on: paths:` on a workflow that gates.** A workflow skipped by `paths` reports no check run, and a required context that never reports blocks the merge forever (#4671); `mutation-pr.yml` can use `paths:` because it gates nothing. The classifier fails closed: a diff it cannot compute runs everything. `_validate.yml`'s `detect-changes`, `codeql.yml` and `e2e-tauri-weekly.yml` all read it, and `src/__tests__/classify-changes.test.ts` tests it, so a new category lands with a test there. To preview a branch's lanes: `git diff --name-only origin/main...HEAD | bash scripts/classify-changes.sh --stdin`.
- **The real-backend lane (`e2e-tauri-weekly.yml`) runs on every PR but gates nothing** (#4671); its `e2e-tauri-gate` job is the context it would add if promoted. A red run never blocks a merge, so read its result yourself.
- **`_validate.yml` has two callers, `ci.yml` and `release.yml`,** so a change to its inputs or outputs must work for both. It has no `schedule:` on purpose (see its header): a weekly whole-tree run belongs in `scheduled-deep-checks.yml`.
- **DCO:** every commit in a PR carries a `Signed-off-by:` that matches its author. Never use GitHub's "Update branch": its merge commit has no sign-off and fails `dco`. Rebase, or run `git merge --signoff origin/main`.

## Runner slots

- **Slots are scarce; minutes are not.** Standard runners are free on a public repo, but every workflow and PR shares the account's concurrent-job limit ([plan limits](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners)), and an uncapped matrix queues every PR gate behind it (`max-parallel` in `scheduled-deep-checks.yml`). A new matrix leg, job or workflow takes a slot in every run: justify it by the critical-path time it saves, measured on a dispatch run.
- **PR refs cancel superseded runs; `main` never cancels and uses one group per commit** (`concurrency` in `ci.yml`, #3672). A group holds one pending run, so a shared group would evict queued `main` runs unrun, and a red `main` would not be attributable to its merge.
- Every job sets `timeout-minutes`, sized for a slow apt mirror rather than a typical run.

## Caches

- **Each job class has its own `Swatinem/rust-cache` `shared-key` (#813); only `main` writes it (`save-if: github.ref == 'refs/heads/main'`) and PRs read it.** List them with `grep -rn 'shared-key' .github/`. A PR restores `main`'s entries but never another PR's, because a PR's saves are scoped to `refs/pull/N/merge`. A weekly full-suite lane in `scheduled-deep-checks.yml` takes no key, because its cache is evicted before the next run.
- **All keys share one cache quota per repo, evicted least-recently-used** ([limits](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)). Each Rust key holds a whole `target/` tree and a `Cargo.lock` change starts a new generation of every key, so past the quota `main`'s Rust caches are evicted and PR lanes build cold. A new key, or a cache every PR run saves, costs every other lane.
- **After every `main` push, `ci.yml`'s `cache-prune` job keeps the newest `refs/heads/main` entry of each `v0-rust-<shared-key>-` family and deletes the rest, PR copies included;** `mutants-merge` deletes `rust-mutants` once the shards finish. It reads keys as `<family>-Linux-x64-<env>-<lock>` and fails on any other shape, so a rust-cache bump that changes the key format reds `main` until the pattern is updated.
- **Data read only weekly does not belong in the Actions cache:** past the quota the least-recently-used entries go first, so a weekly reader finds nothing. The fuzz corpus is a 90-day `fuzz-corpus` artifact, and the fuzz job restores the newest one `main` uploaded.
- **The real-backend lane's build restores `rust-mcp` with `save-if: false`:** `main` runs that lane only weekly, so a key of its own never hit (#5853). Its shards install runtime packages with no apt key, for the same reason.
- A lane with its own package set takes its own `apt-*` key, and bumps its `-vN` suffix whenever the list changes. The `apt-tauri-*-v1` key is shared.
- A cache-poisoning suppression is an inline `# zizmor: ignore[cache-poisoning]` on its step, never an entry in `zizmor.yml`; adding one means bumping `EXPECTED_INLINE_SUPPRESSIONS` (`scripts/check-cache-poisoning-suppressions.mjs`). Only a job that never signs or publishes may restore a cache; `release.yml` restores none (#3542).

## Pins

- **Every third-party `uses:` is pinned to a full commit SHA with its `# vX.Y.Z` comment.** zizmor checks that the comment matches the SHA, and Dependabot (`dependabot.yml`) bumps both. `actions/rust-toolchain` exists because a tag that moves under a pinned SHA failed that check after every move.
- The Rust toolchain is an exact version in every workflow except the nightly `fuzz` lane, in lockstep with `rust-toolchain.toml` and `src-tauri/Cargo.toml` `rust-version` (#640); the header of `rust-toolchain.toml` lists the places.
- zizmor and prek are each pinned in two places that Dependabot cannot track: zizmor in `scripts/zizmor-hook.sh` and the `tool:` lists of `taiki-e/install-action`, prek in `scripts/setup-hooks.sh` and those lists. The `zizmor-version-pin` and `prek-version-pin` hooks keep each pair equal. actionlint is pinned by SHA in `prek.toml`.
- Every checkout sets `persist-credentials: false`. Each workflow's top-level `permissions` are read-only, and a job widens only what it needs.
- apt installs go through `actions/prepare-apt` and `actions/apt-install`. Exit 75 with `AGARIC_APT_INFRA` means the mirror failed: rerun the job.
- `workflow-watchdog.yml` watches every workflow with a cron, plus `ci.yml`'s post-merge run on `main`. `WATCHED` in `scripts/check-workflow-liveness.mjs` lists them keyed by filename, so adding a cron or renaming a workflow means updating it.

## Reading a run

`gh run view --log` refuses while the run is in progress. The job-log endpoint serves a finished job mid-run (`gh api` takes the same paths):

```sh
curl -sS "https://api.github.com/repos/jfolcini/agaric/actions/runs/<run_id>/jobs?per_page=100" \
  | jq '.jobs[] | {id, name, conclusion, created_at, started_at}'
curl -sSL "https://api.github.com/repos/jfolcini/agaric/actions/jobs/<job_id>/logs" > job.log
```

- `started_at` minus `created_at` is how long a job waited for a slot.
- A Rust lane's cache state is its restore line: `Restored from cache key "…" full match: true`.
- To show a workflow change working, use `workflow_dispatch` on its branch where the workflow has one. Every dispatch takes slots.
