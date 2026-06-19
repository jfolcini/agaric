# Session 1014 — /batch-issues loop: frontend correctness/perf, batch 15 (2026-06-19)

## What happened

Fifteenth batch of the `/loop /batch-issues` run: three frontend findings from the
multi-agent deep review, each on a disjoint file/cluster, built by parallel
subagents and adversarially reviewed (each builder paired with a different
reviewer). Ran overlapped with backend batch 16 in the main checkout. Built in
worktree `wt-fe15`.

## Shipped

Single PR `fix/fe-correctness-deep-review-3`:

- **#1623** (MEDIUM, performance) — three list/row renderers re-ran the full
  recursive-descent markdown parser (`renderRichContent` → `parse`) unmemoized on
  every render, while the at-rest block renderers (`StaticBlock`/`BlockListItem`)
  already wrap the identical call in `useMemo`. Brought all three into line with
  that established pattern (key = source content + the `resolveVersion` from
  `useResolveStore`, with the stable `resolve*`/`onTagClick` callbacks from
  `useRichContentCallbacks` as deps):
  - `DiffDisplay.tsx` — a `renderedSpans` memo parses each visible span once; the
    active-hunk ring + `data-hunk-*` attributes stay OUT of the memo, so a
    prev/next hunk-nav click no longer re-parses (was re-parsing up to 500 spans).
  - `HistoryListItem/HistoryItemCore.tsx` — a `previewContent` memo (returns `null`
    for property-payload rows, so they never parse).
  - `TrashView/TrashRowItem.tsx` — a `renderedContent` memo keyed on `block.content`.
  Output is byte-identical — pure perf change.
- **#1784** (LOW, correctness) — `ConfirmDialog.runConfirm` early-returned only on
  the internal `pending` state, while the buttons and `handleCancel` gate on
  `isPending = pending || loading`. An external `loading` prop could therefore let
  a Confirm click (via `fireEvent`, or any path bypassing the `disabled` attribute)
  still invoke `onConfirm`. The Confirm-side cousin of #1611's Cancel fix. Now
  `runConfirm` early-returns on `isPending` (and its `useCallback` dep was updated
  to match), symmetric with the buttons.
- **#1793** (LOW, correctness) — in `ui/calendar.tsx` the `day` base accent gate
  keyed on `[&:has([aria-selected])]:` (a descendant match), but react-day-picker
  v10 sets `aria-selected` on the `<td>` cell itself, not on a descendant, so the
  `:has()` selector was always false and the accent state was dead. Switched to the
  cell's own `[&[aria-selected]]:` predicate (and its `.outside` / `first:` / `last:`
  variants), matching how #1563 fixed the sibling `today` gate.

## Review pass

Three adversarial reviewers (different subagent than each builder), each re-read
the code against the real dependency source, mutation-tested the new tests, and ran
the real gates (tsc --force, oxlint, vitest):

- **#1623 reviewer** confirmed `DiffDisplay` and `HistoryItemCore` memo keys are
  complete (every `resolve*` callback + `resolveVersion`, all referentially stable
  in production — traced to `useRichContentCallbacks`'s `useCallback([])`/`cacheRef`)
  and that both tests are genuine guards (mutation-killing). It found a real defect:
  `TrashRowItem`'s added `React.memo` wrapper was a **no-op** — its only caller
  (`TrashListView`) passes a fresh inline `style` object + recomputed `parentLabel`
  every render, defeating the shallow compare, and the behavioral memo test was
  hollow (`block` recreated inside the test `Harness`). Since the inner `useMemo`
  already delivers the stated win (no re-parse across the same instance's
  selection/focus re-renders), the orchestrator dropped the ineffective `memo`
  wrapper + its misleading comment and removed the two hollow memo tests, keeping
  the real re-parse guards (7/7 pass, tsc/oxlint clean). Engaging `memo` properly
  would have required refactoring the virtualizer's per-row style wiring for
  marginal gain on a perf item whose primary goal is already met.
- **#1784 reviewer** mutation-tested the regression test (reverting to the `pending`
  guard makes it fail) and confirmed it faithfully reaches `runConfirm` by invoking
  the live React `onClick` prop (a plain `fireEvent.click` on the disabled button is
  a jsdom no-op false-green). It fixed one TS2532 tsc-gate defect in the new test
  helper (`].onClick` → `]?.onClick` under `noUncheckedIndexedAccess`).
- **#1793 reviewer** independently verified the DOM claim against the installed
  `react-day-picker@10.0.1` dist (`aria-selected` is spread onto the `<td>`, never
  the inner `DayButton`), compiled the Tailwind arbitrary variants to confirm they
  resolve to correct selectors, and mutation-tested (the suite fails against the old
  `:has()` selector). Cosmetic nit noted (the substring test is the real
  mutation-catcher, not the runtime DOM tests) — not worth churning.

## Notes

- Files: `rendering/DiffDisplay.tsx`, `HistoryListItem/HistoryItemCore.tsx`,
  `TrashView/TrashRowItem.tsx`, `dialogs/ConfirmDialog.tsx`, `ui/calendar.tsx`
  (+ their tests). No backend/codegen.
- Final local gate: tsc --force exit 0, oxlint exit 0, vitest green across the
  touched suites.
- Pushed serially with backend batch 16 to avoid concurrent heavy pre-push (OOM):
  the FE pre-push compiles the full Rust suite in the worktree's own `target/`, so
  it cannot overlap a cargo build in the main checkout.
