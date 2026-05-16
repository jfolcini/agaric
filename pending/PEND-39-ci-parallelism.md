# PEND-39 — CI parallelism overhaul

> Captured 2026-05-16. Three small CI improvements already landed alongside this plan (see "What's done" below). This file covers the **four interacting items** that wanted a coherent design rather than piecemeal edits: vitest sharding, Playwright sharding, splitting the monolithic `validate` job into parallel siblings, and sharing the `Swatinem/rust-cache` between them. Order matters because cache keys, job dependency graphs, and the `_validate.yml` callable shape all need to move together.

## What's done (landed with this plan, not part of the overhaul)

- **C1 — `taiki-e/install-action@v2` for cargo-installed dev tools** (`cargo-deny`, `cargo-machete`, `sqruff`, `typos-cli`, `zizmor`, `taplo-cli`; nextest was already using this). Pre-built binaries → ~15 min compile step gone when `Cargo.lock` invalidates the binary cache. `sqlx-cli` keeps `cargo install` because it needs custom features; `prek` keeps it because the action's binary list doesn't cover it yet.
- **C2 — `concurrency: cancel-in-progress`** on `ci.yml` for all branches except `main`. Pushing twice in quick succession cancels the older run instead of double-billing. `main` is excluded so release-adjacent runs always complete.
- **C4 — `mold` linker installed + activated** in both `_validate.yml` and `ci.yml`'s Linux build steps. Linker step of every Rust compile in CI gets a ~30 % cut.

These three are independent, low-risk, and already shipped. The remaining four are entangled.

## In-scope items (the actual overhaul)

### C3 — vitest sharding

Today `_validate.yml` runs `npm test` (single process, all 409 files, 9 874 tests). On the maintainer's 10-core workstation this takes 169 s; GitHub's 4-vCPU `ubuntu-24.04` runners would scale that to ~5-7 min wall clock.

Vitest's built-in sharding:

```yaml
strategy:
  fail-fast: false
  matrix:
    shard: [1, 2, 3]
jobs:
  vitest-${{ matrix.shard }}:
    steps:
      - run: npx vitest run --shard ${{ matrix.shard }}/3
```

3 shards typically gives near-linear scaling (each shard pays its own jsdom-env-setup cost — that's the per-file overhead the local profile flagged at 836 s CPU). Wall clock per shard: ~2.5-3 min. Combined wall clock: same as the slowest shard.

**Trade-off:** loses a single coherent JUnit report. Vitest can emit per-shard JSON which a small merge step can roll up; for now, GitHub's native job UI is sufficient (3 green checkmarks instead of 1) and we can defer the merge step until someone needs aggregated stats.

### C5 — split `_validate.yml` into parallel jobs

Today's `_validate.yml` is one job, one runner, ~25-30 min wall clock. Steps run sequentially: install → prek → nextest → mcp-build → mcp-smoke → vitest → playwright-install → playwright → sqlx-prepare-check → externalBin-smoke.

These have minimal cross-step data flow (each step writes to disk and the next reads). Splitting into parallel jobs lets the matrix execute on multiple runners simultaneously:

| Proposed job | Runs in parallel | Approximate runtime |
| --- | --- | --- |
| `lint` | prek (excluding `vitest`, `cargo-test`, `tsc` if separated) | 3-5 min |
| `typecheck` | `tsc -b` (+ tsbuildinfo cache hit) | 2-3 min cold, <1 min warm |
| `vitest` (sharded → C3) | 3-shard matrix | 2.5-3 min per shard |
| `nextest` (Rust, optionally sharded) | `cargo nextest run --profile ci` | 5-7 min |
| `playwright` (sharded → C8) | 2-shard matrix | 4-5 min per shard |
| `mcp-smoke` | mcp build + uds roundtrip test | 2-3 min |
| `sqlx-prepare-check` | `cargo sqlx prepare --check` | 1-2 min |

Wall clock would drop from ~25-30 min to **~7-10 min** (limited by the longest single job — likely `nextest` or `playwright`).

**Trade-off — cache sharing (interacts with C6).** Each job pays its own `Swatinem/rust-cache` restore. With unique cache keys per job, that's 7× the restore cost. With a shared key (C6), they share the dep cache but each pays the per-job target/incremental restore. Workable, but the cache-management plan needs to be designed before the split.

**Trade-off — workflow-level skip logic.** Some changes don't need every job (a doc-only change doesn't need Rust nextest). Today's monolith implicitly couples everything; the split would let us add `paths-ignore` per job. Doable but expands surface area.

### C6 — shared `Swatinem/rust-cache` key

`_validate.yml` uses default keys (per-job, per-workflow). `ci.yml`'s desktop build matrix also uses defaults — meaning each platform job and the validate job all compile dependencies from scratch the first time. With `shared-key: 'rust-deps'`, the validate job's dep cache is restored by the build matrix's Linux job (and vice versa).

```yaml
- uses: Swatinem/rust-cache@v2
  with:
    workspaces: src-tauri
    shared-key: rust-deps      # same key in validate + build-linux
    save-if: ${{ github.ref == 'refs/heads/main' }}
```

The `save-if` guard prevents every feature branch from poisoning the shared cache; only `main` updates it. Other branches read from `main`'s cache and write their own incremental layer on top (which expires per the standard 7-day GH cache TTL).

**Risk:** profile mismatch. Validate compiles in test mode; build matrix compiles in release mode. The `Swatinem/rust-cache` action segregates cache slots by profile internally, so this works — but verify with a cold-cache test run before merging.

### C8 — Playwright sharding

Today `npx playwright test` runs single-process. Playwright supports `--shard 1/2` natively. Mirror C3:

```yaml
strategy:
  matrix:
    shard: [1, 2]
steps:
  - run: npx playwright test --shard ${{ matrix.shard }}/2
```

E2E wall clock approximately halves. The Playwright HTML report aggregation across shards needs a merge step (`playwright-report` artifact per shard + a final `merge-reports` job) — already documented in Playwright's own docs.

## Recommended sequencing

Because of the cache interactions, the right order is:

1. **C6 first** (shared rust-cache key). Cheap, no other job changes, sets up the cache invariant the split will rely on.
2. **C3** (vitest sharding). Standalone within `_validate.yml`; replaces one step with a matrix without touching the other steps.
3. **C8** (Playwright sharding). Same shape as C3, lower risk.
4. **C5** (split `_validate.yml`). The big one. Easier to land after C3/C8 because the matrices are already proven, and the cache strategy from C6 is in place.

Each step is independently shippable and revertable. C5 is the only one that's a substantial YAML rewrite; the other three are localized.

## Open questions

1. Do we want a single `validate` aggregate "check" gate (a job that `needs:` all the split children + passes if all green) for branch-protection rules to reference, or update branch protection to require all child checks individually? The former is more stable; the latter has cleaner failure surfaces.
2. Should sharded test reports get a merged-report job, or is per-shard GitHub-UI signal enough? (Merged reports help when reading historical test trends; not having them means we can't do flake detection across shards.)
3. For shared rust-cache: comfortable with the `save-if: refs/heads/main` guard, or want a broader save policy (e.g., all PRs targeting main)? The trade-off is cache eviction speed vs. PR-side cold-restore cost.
4. C5 wants paths-ignore per child job (e.g., docs-only PRs skip nextest). Where do we put the canonical path-pattern list — duplicated in each job's `on: push: paths`, or extracted to a reusable check? GitHub's `paths` filter doesn't compose well across reusable workflows; might need to live in `_validate.yml` callers.

## Cost / Impact / Risk

- **Cost:** M (~1-2 days end-to-end for all four; C5 is the half-day item, the others are ~1 h each). Mostly YAML; no app code changes.
- **Impact:** **High.** CI wall clock from ~25-30 min → ~7-10 min. Feedback on a PR push from "go get coffee" to "look at the dashboard while you finish typing the comment". Compounds with C1/C2/C4 (already landed) — the cold-cache path improves the most because `taiki-e` + shared cache stack favorably.
- **Risk:** **Medium.** YAML refactors at this size do leak subtle bugs (a job ordering miss, a permissions gap, a cache-key typo). Mitigate by landing in order above, running each step on a feature branch with `act` or a throwaway draft PR before merging, and not changing branch-protection rules in the same PR.

## Related

- `pending/PEND-37-local-dev-speed.md` — local-dev counterpart; mold (C4 / L1) and vitest tuning (C3 / L3) overlap.
- `.github/workflows/_validate.yml` — primary target of C3, C5, C6.
- `.github/workflows/ci.yml` — C6 also applies here for the desktop build matrix.
- `.github/workflows/release.yml` — calls `_validate.yml`, so benefits automatically. Verify the release-tag path still works after C5.
