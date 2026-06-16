# Session 1003 — agenda query/load-more error surfacing (#1345)

`/loop /batch-issues` run (2026-06-16), one of three issues built in parallel isolated
worktrees (#1325 Rust, #1341 checkbox guard, #1345 this).

## Shipped

- **#1345 — agenda query + load-more failures silently swallowed.** Two failure-handling gaps
  in AgendaView:
  1. An initial query failure rendered the benign `agenda.noTasks` ("No tasks found") empty
     state — the catch only `logger.warn`ed, cleared the blocks, and stopped. The user couldn't
     distinguish a backend failure from an empty agenda.
  2. A load-more failure was invisible — `loadMoreAgenda`'s catch only warned; the button
     silently reset with no retry.

  Fix: track an `agendaError` state in `AgendaView` (cleared at the start of each run, set in
  the `runFilters` catch), pass `error`/`onRetry` to `AgendaResults`, which renders a distinct
  error card (taking precedence over loading/empty states) mirroring `SearchPanel`'s error card
  — `role="alert"`, destructive styling, title/body + an outline Retry button. `onRetry`
  re-triggers the fetch via the existing `refreshKey` bump. For load-more, the catch now calls
  `notify.retry(t('agenda.loadMoreFailed'), loadMoreAgenda)`.

## i18n

New keys in `src/lib/i18n/agenda.ts` (single-locale app — `i18n/index.ts` pins to `en` and
forbids new locale resources, so this is the only locale file): `agenda.loadFailed`,
`agenda.loadFailedBody`, `agenda.loadMoreFailed`. Retry label reuses the shared `action.retry`.

## Tests

- `AgendaView.test.tsx`: query failure surfaces the error state (not `noTasks`) + Retry
  re-invokes the query; load-more rejection calls `notify.retry` with the load-more callback.
- `AgendaResults.test.tsx`: error card renders (not `noTasks`), overrides the active-filter
  empty state, and passes `axe(container)`.
- 58 tests green; `tsc`/oxlint/oxfmt clean; i18n key-validation suite 112/112. Independent
  reviewer confirmed both failure paths surfaced, retry genuinely retries, and UX matches
  SearchPanel.
