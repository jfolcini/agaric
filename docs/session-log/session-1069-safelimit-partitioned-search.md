# Session 1069 — /batch-issues loop: SafeLimit branding, batch 20 (2026-06-19)

## What happened

Twentieth batch of the night `/loop /batch-issues` run, shipped concurrently with
backend batch 19 and correctness batch 21. Single HIGH-severity robustness finding,
built in worktree `wt-safelimit` and adversarially reviewed.

## Shipped

PR `fix/safelimit-partitioned-search-1570`:

- **#1570** (HIGH, robustness) — `searchBlocksPartitioned` declared `pageLimit` /
  `blockLimit` as plain `number`s, bypassing the `SafeLimit` brand every other
  paginated wrapper uses, so a future caller passing e.g. `pageLimit: 500` compiled
  cleanly and was only rejected at the IPC boundary at runtime (backend cap
  `MAX_SEARCH_RESULTS = 100`). Branded both limits as `SafeLimit` so an over-cap
  literal is now a **compile error**. The existing `safeLimit` smart constructor
  enforces `[1, max]`, but the partitioned search needs `[0, max]` (link-mode passes
  `blockLimit: 0`), so added `safeLimitZero(n, max)` (identical to `safeLimit` but
  inclusive-zero lower bound) + `partitionedSearchLimit(n)` (= `safeLimitZero(n, 100)`).
  `palette/constants.ts` constants are now branded via the helper, plus a new
  `LINK_MODE_BLOCK_LIMIT = partitionedSearchLimit(0)` so the link-mode `0` stays
  branded rather than widening the caller's ternary back to `number`. The backend
  runtime cap in `commands/queries.rs` is left intact as defense-in-depth / source of
  truth — FE `[0,100]` matches the backend `[0,100]` exactly.

## Review pass

One adversarial reviewer (APPROVE, no defects): verified `safeLimitZero` accepts 0
and 100 inclusively and rejects negatives / >max / fractionals / NaN (differs from
`safeLimit` in exactly the lower-bound character); confirmed FE/backend bound-parity
is an exact match; independently fired the compile-time guard (inserted `pageLimit:
500` → `TS2322`, reverted); confirmed no remaining caller passes a plain `number`
(no widening hole) and `SafeLimit` is a genuine phantom-branded subtype; mutation-
checked the 0-acceptance tests. 97/97 vitest, `tsc -b --noEmit` clean.

## Notes

- Files: `src/lib/safe-limit.ts`, `src/components/palette/constants.ts`,
  `src/components/common/CommandPalette.tsx`, `src/lib/tauri.ts`,
  `src/lib/__tests__/safe-limit.test.ts`. Backend unchanged.
- Branch base (`58dff693`) is current `origin/main`.
