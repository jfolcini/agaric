# Session 1022 — mixed tech-debt / bug / docs batch (#1095 #1119 #690 #1149 #1088 #654 #1065)

Part of the autonomous `/loop /batch-issues` pass (2026-06-14). Two batches of tractable,
no-maintainer-judgment items across docs/dx, Rust, and frontend, plus reconciliation of the
prior batch's PRs.

## Shipped

- **#1095 (docs) — Badge docstring.** Removed the stale "legacy `variant` prop is kept as a
  deprecated alias" sentence (`BadgeOwnProps`/`BadgeProps` expose only `tone`; no alias logic).
  Added a comment noting the emitted `data-variant` attribute name is retained for test/CSS
  stability. PR #1179 (merged).
- **#1119 (refactor) — restore.rs cohort filter.** Switched `soft_delete/restore.rs` from the
  flat `WHERE deleted_at = ?` match (whose recursive arm lacked the cohort guard) to the shared
  `crate::descendants_cte_cohort!` macro via untyped `sqlx::query` + `concat!` (with a
  `// dynamic-sql:` marker), matching the three #1055-fixed call sites. Removed the orphaned
  `.sqlx` cache entry for the old query. Dead-code-safe (zero non-test callers since #386). PR
  #1180 (merged).
- **#690 (bug) — gcal disconnect token revoke.** Added `GcalApi::revoke_token` (RFC 7009 POST to
  `https://oauth2.googleapis.com/revoke`, 10s timeout, token never logged) and made
  `disconnect_gcal_inner` attempt revoke first (best-effort, non-fatal) before clearing local
  state. Regenerated specta bindings (the `disconnectGcal` JSDoc). PR #1181 (merged).
- **#1149 (tech-debt) — recent-pages MRU consolidation.** Made `stores/recent-pages.ts` the
  single source of truth (superset of the deleted `lib/recent-pages.ts`: pinning, removal,
  pin-first eviction, dedup); one-time localStorage→store migration on rehydrate; rewired 4
  consumers; deleted the lib + its test. PR #1182 (merged).
- **#1088 (docs/dx) — hook host-binary install link.** `docs/BUILD.md` already consolidated the
  prek host-binaries; added the missing deep-link from CONTRIBUTING.md's Bootstrap. PR #1183.
- **#654 (db) — CommandTx Drop debug-assert.** Added `impl Drop` with
  `debug_assert!(!committed || pending.is_empty())` — a `committed` discriminator avoids
  false-positives on legitimate error-path rollback drops. Wrapped `inner` in
  `Option<Transaction>` (required once a manual `Drop` exists; E0509). Removed the `dead_code`
  expectation on `label`. PR #1184.
- **#1065 (bug) — draft flush-on-unmount race.** Added a synchronous per-block `discardedRef`
  Set so Effect B's cleanup skips the flush for a discarded draft, closing the
  unmount-coincides-with-blur window that could resurrect ~2s-stale draft content as the latest
  edit. PR #1185.

## Reconciliation / fixes

- **#1178 (#1099 tag colors) — stale-base failure.** CI vitest failed (not a flake): the
  #1092 focus-ring test merged to main queried a swatch named `'red'`, but #1099 renamed the
  palette to themed accent tokens (emerald/blue/…). Rebased #1099 onto current `origin/main`
  (clean textual rebase, but a *semantic* conflict the merge couldn't catch) and updated the
  swatch query to `'emerald'`. Full suite 12531 green, tsc clean; force-pushed.
- Merged the prior batch's #1180/#1181/#1182 (all green); pruned their worktrees.

## Notes / lessons

- **SSH push transport was flaky** ("Connection closed by remote host" mid-transfer, ~3 drops);
  switched all pushes to HTTPS via `gh auth git-credential` — reliable. Verified remote SHA
  after each push rather than trusting exit code.
- **`npx oxfmt --write` with an empty file list reformats the whole tree** (the banned
  `oxfmt --write .` footgun) — reverted the TOML/workflow collateral and now guard the file list
  before invoking.
- `react-hooks/exhaustive-deps` flags `ref.current` read in an effect cleanup — capture the
  (in-place-mutated, never-reassigned) Set reference in the effect body instead.
