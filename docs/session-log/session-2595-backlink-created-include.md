# Session 2595 — Backlink filters: Created Date on the real backend, and a source-page include (#5736)

The last open part of #5736's backlink-filters item. Status, Priority, Has Tag,
Property, a source-page exclude and both Clear all buttons already had specs; two
pieces did not.

**Created Date** (real lane; the mock does not model `CreatedInRange`): the filter
compares each block's ULID against prefixes built from the two dates' UTC midnights
(`after` inclusive, `before` exclusive). `references-filters.e2e.ts` (renamed from
`references-status-priority-filters.e2e.ts`, since it now covers more than those two)
reuses the five sources its first `it` imports: a range from two days ago to two days
ahead lists all five ("Showing 5 of 5 backlinks"); before two days ago alone and after
two days ahead alone each list none ("Showing 0 of 5"). Bounds two days out keep the
assertions true in any time zone. The date fields are set through the native value
setter, as `reminder-due-task.e2e.ts` does, because WebKitGTK's date input ignores
WebDriver keystrokes.

**Source-page include** (mock lane): a plain click on the Projects row of "Filter by
source page" leaves exactly its three tasks; the popover's own Clear all brings back all
five rows.

**Shown red:** `projection.rs` `b.id < ?` widened with `OR 1=1` (the before-only step)
and `b.id >= ?` the same way (the after-only step); `useBacklinkGroups.ts` sending no
included pages, and `SourcePageFilter.tsx` with include and exclude swapped (the new
include test, which then read the exclude result).

**Ran:** both spec files on a binary rebuilt from this tree; `npm run typecheck`,
`npm run typecheck:e2e-tauri`, oxlint, oxfmt and `npx vitest run e2e-tauri`.
