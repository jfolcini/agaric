# Session 2089 — Week view: Add block on an empty day

On a week day with no journal page, "Add block" created the page but showed
no block to type in. Multi-day views pass `autoCreateFirstBlock` only in daily
mode, so the new page's tree seeded nothing. The day's tree was also behind the
lazy mount, whose observer arms once at mount, so a page born after that never
mounted at all.

`DaySection` now remembers that this day's empty-state button was clicked
(`firstBlockRequested`). That flag turns on `autoCreateFirstBlock` for the day's
tree and bypasses the lazy mount, so the tree mounts as soon as the page exists,
seeds one block and focuses it. Every other empty day stays unseeded, and the
per-page Add block button is unchanged. The flag lives as long as the section,
which every view keys by date.

Tests:
- `DaySection` unit tests pin both halves of the fix. They went red with the
  seed flag reverted and with the lazy-mount bypass reverted.
- `e2e/journal-week-empty-day-add-block.spec.ts`, with and without reduced
  motion, went red at the focused-editor assertion with the seed reverted.
- `e2e-tauri/journal-week-empty-day-add-block.e2e.ts` covers the real backend.

Suites run: vitest on `src/components/journal`, `src/components/editor` and
`useJournalBlockCreation`, typecheck, lint, the wdio tsconfig, and Playwright on
the new spec plus the existing journal Add block specs.
