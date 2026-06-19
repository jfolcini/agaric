# Session 1072 — /batch-issues loop: empty-surface seed recovery, batch 23-D (2026-06-19)

## What happened

Frontend lane of the night `/loop /batch-issues` run, built in worktree `wt-fe23`,
overlapped with the batch-22 god-file splits and the batch-23 backend builders. Single
HIGH-severity robustness fix.

## Shipped

PR `fix/fe-seed-retry-1566`:

- **#1566** (HIGH, robustness) — the two empty-surface seed hooks set their idempotency
  ref to the current id BEFORE awaiting `createBlock`, and their `.catch` only
  logged + toasted. On a `createBlock` IPC rejection the ref stayed set, the dep array
  was unchanged, so the guard short-circuited every subsequent render — stranding the
  user on a permanently blank page/zoom pane with no block to type into and no recovery
  short of navigating away and back. Fixed both hooks
  (`use-block-auto-create-first-block.ts`, `use-block-zoom-empty-seed.ts`): on failure,
  after the existing log/toast, reset the ref to `null` — but only if it still equals
  the id this run set (`if (ref.current === thisId) ref.current = null`), so a
  concurrent page-switch / re-zoom that re-armed the ref for a different id is not
  clobbered. A bare ref write doesn't trigger a re-render, so this cannot spin a hot
  retry loop; the retry fires on the next natural re-render.

## Recovery semantics (intentional)

Recovery is **best-effort, not guaranteed-prompt**: the catch path produces no
re-render itself, so the retry fires on the next render the surface does for an
unrelated reason (store subscription, sync tick, focus/visibility). These editor
surfaces re-render frequently, so recovery is realistic in practice. A self-scheduled
timed retry was deliberately avoided — it would risk the very create→fail→retry hot
loop the conditional ref-reset is designed to prevent. This is a strict improvement
over the prior permanent-strand bug.

## Review pass

Reviewer (APPROVED, no defects): swept all `createBlock`/`useRef` usages and confirmed
only these two hooks have the one-shot pre-await seed-ref pattern (both fixed); verified
the conditional reset has no stale-closure hazard; traced the persistent-rejection path
to confirm no re-render is produced (`<Toaster>` is mounted at app root, not in the
hook's subtree) → no hot loop; confirmed success-path idempotency is preserved; and
mutation-checked both the recovery and idempotency tests. 52/52 block-tree tests pass,
`tsc -b --noEmit` clean.

## Notes

- Files: `src/components/block-tree/use-block-auto-create-first-block.ts`,
  `src/components/block-tree/use-block-zoom-empty-seed.ts` + their test files.
  Test-only + hook logic; no backend.
- Branch base is current `origin/main`.
