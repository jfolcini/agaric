# Session 1104 — /batch-issues loop: continuous infinite-scroll journal view (#1415)

## What happened

New feature from the maintainer's list: a Logseq-style continuous infinite-scroll journal
stream. Built in `wt-1415`, adversarially code-reviewed (its e2e was run by the builder).

## Shipped

PR `feat/1415`:

- **#1415** (feat) — a new `'stream'` journal view: a continuous, chronologically-ordered
  stream of daily date pages, today anchored at top, older days loading as you scroll down.
  - **Data** (`hooks/useStreamDates.ts`): a windowed descending date list (today at index 0),
    starting at 14 days and extended 14 at a time by `loadOlder()` (clamped at the 2020-01-01
    horizon); fetches the `dateStr→pageId` map via `listJournalPagesInRange` for the full
    window on each grow; `addPage` merges a locally-created page without refetch.
  - **View** (`components/journal/StreamView.tsx`): renders each day via the EXISTING
    `DaySection` (`mode="stream"`, `compact`, `lazyMount`); a zero-height bottom sentinel
    watched by an `IntersectionObserver` (600px rootMargin) calls `loadOlder`; self-disables
    at the horizon.
  - **Virtualization**: reuses `DaySection`'s `lazyMount` one-shot observer — a day's
    `BlockTree` (one TipTap editor) mounts only when scrolled into view, so mounted editors
    are bounded by what's been scrolled past, not the loaded-window size. No new library.
  - **Empty days** render a date heading + the compact empty-state Add-block CTA (creates
    the page on demand via the same atomic path the weekly surface uses).
  - **View-switcher**: `'stream'` added to `JournalMode` + `JOURNAL_MODES` + the exhaustive
    `JOURNAL_SHIFT_PREV/NEXT` records + the tab list (between Month and Agenda). Date-nav +
    Today button hidden in stream (new `hidesDateNav` flag) — no per-day cursor in a
    continuous column; the calendar picker stays.

## Design decision flagged for maintainer

The issue said "older days load as you scroll **up**" but also "today anchored at top" —
those conflict. The implementation anchors today at the top and loads the past **downward**
(the Logseq journal convention), which sidesteps scroll-anchor math (no scroll-position
preservation needed when growing). The whole stack agrees on this orientation. If
today-at-bottom / scroll-up-into-the-past is wanted instead, that's a follow-up flip.

## Review pass

Reviewer (ship-ready, no defects): no regression to day/week/month/agenda (all exhaustive
`Record<JournalMode,…>` tables + the switcher carry the `'stream'` arm; tsc clean; sibling
views byte-for-byte untouched; journal 229 + stores/hooks 2655 tests pass); virtualization
genuinely bounded (BlockTree mounts only on viewport entry — covered at the `DaySection`
layer); infinite-scroll loop correct (ref-wired observer, self-disables at horizon, no
duplicate days, stale-fetch guarded); empty-day creation merges without reload; axe clean;
no over-reach (exactly the 10 files). e2e `infinite-journal-1415.spec.ts` ran 3/3 in a real
browser (builder). Non-blocking nits left as follow-ups: a dead `STREAM_BATCH_DAYS>6`
branch; a cosmetic midnight-rollover today-styling drift.

## Notes

- Files (new): `hooks/useStreamDates.ts`, `components/journal/StreamView.tsx`,
  `components/journal/__tests__/StreamView.test.tsx`, `hooks/__tests__/useStreamDates.test.ts`,
  `e2e/infinite-journal-1415.spec.ts`. (modified): `stores/journal.ts`,
  `components/journal/JournalControls.tsx`, `components/JournalPage.tsx`,
  `hooks/useAppKeyboardShortcuts.ts`, `lib/i18n/pages.ts`.
- Branch base is current `origin/main`.
