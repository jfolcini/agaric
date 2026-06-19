# Session 1000 — /batch-issues loop: FE robustness hardening (2026-06-19)

## What happened

Autonomous `/loop /batch-issues`. One cohesive batch of five frontend robustness
findings from the multi-agent deep review, grouped into a single PR — each item on
a non-overlapping file, built by parallel subagents and adversarially reviewed
before ship. PR #1783 (advanced-query ref-read + grey subsumed agenda chips, #1638
/#1746) was already open and pending CI at the start; left to reconcile at the
batch boundary.

## Shipped

Single PR `fix/fe-robustness-deep-review`:

- **#1612** — `ConfirmDialog` rendered an empty accessible name when a caller
  omitted both `title` and `titleKey`; now falls back to the existing `dialog.confirm`
  i18n string (+ dev-only warn), so the required AlertDialog/Sheet Title always has
  a non-empty name (axe aria-dialog-name).
- **#1611** — `ConfirmDialog` desktop `AlertDialogCancel` bound the raw `onCancel`,
  relying solely on `disabled={isPending}`; now binds `handleCancel` (the isPending
  guard) on both mobile and desktop paths.
- **#1608** — persisted `activeTabIndex` was validated `>= 0` but never clamped to
  tab count, so a corrupt blob made every page click a silent no-op; added
  `clampIndex` and clamped flat + per-space indices at both persist seams and on read.
- **#1609** — `search-history` store coerced corrupt blobs in `migrate` but not
  `merge`, so a current-version malformed blob bypassed coercion; added a `merge`
  reusing `coerceBySpace` + `historyEnabled` validation, mirroring `journal.ts`.
- **#1617** — the single shared polite live region clobbered overlapping
  announcements; distinct messages now queue and flush sequentially with a gap, plus
  a `document.hidden` setTimeout fallback so backgrounded-tab announcements land.
- **#1619** — `safeLimit` threw a synchronous RangeError with no clamping variant;
  added non-throwing `clampLimit(n, max)` for dynamic inputs + documented the throw
  contract. Audit found no dynamic call sites today; the export is the issue's ask.

## Review pass

Five adversarial reviewers (one per item, none self-reviewing) re-read the code and
re-ran the targeted suites; each reviewer owned the item's full targeted run.

## Notes

- All five touch disjoint files (`ConfirmDialog.tsx`, `stores/tabs.ts`,
  `stores/search-history.ts`, `lib/announcer.ts`, `lib/safe-limit.ts`) — clean
  parallel build with no worktree needed, shipped as one cohesive PR.
