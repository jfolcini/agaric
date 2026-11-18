# Session 4277 — toasts only for what the user did or must know

Follow-up to #6878 (#6870). The maintainer asked for the rest of the toast review: drop success toasts that repeat what the screen already shows, move a tip and two form messages out of toasts, and stop screen readers hearing a toast twice. The rule now lives in `docs/UX.md` § Toasts and § Announcer; `notify.ts` points there.

- **Success toasts that repeat a visible change are gone:** week start, journal date format, external image policy, welcome tour reopened, the phone search sheet's pin and unpin, a renamed saved view, an applied Pages view.
- **Kept, because a real-backend spec waits on them as the only sign a write committed:** tag renamed, loaded view, template inserted, agent access on/off, agent added, address updated, page renamed, set location. Removing them needs another commit signal, shown in that lane.
- **Kept, because the effect is not where the user is looking:** date chip updated (the task leaves the agenda's filtered list), template status saved or removed (only the closed menu shows it), restored view (the Undo click closes the list).
- **The filter-syntax tip** is a fixed line under the search field, tied to it with `aria-describedby`, instead of a one-time toast; its hook and preference are gone. The deadline-warning clamp is said under its field (it never toasted: the controlled field had already snapped back by blur), and a refused peer address shows in the open popover.
- **Duplicate announcements:** sonner's toaster is an always-present `aria-live="polite"` section, so an `announce()` beside a toast for the same event said it twice. 48 such calls are gone (Trash, undo and redo, History, pairing, page header, aliases, reschedule, palette export, the sync hooks), with the `announce.*` strings they used. `announce()` stays where no toast is raised. `announceMoveResult` still says a failed block move twice: its `false` covers both a boundary no-op (no toast) and a backend error (toasted), and telling them apart needs a store change.
- **Absence checks:** where a flow raises no other announcement, the tests assert `announce` is not called at all, not that it skipped one deleted string, which could never fail; where it does announce (sync start, alias removal, pairing's waiting state), they pin the exact calls or clear before the step. (Review note.)
- **`usePageDeleteAction`'s `onFailed`** lost its only caller with the page-header announcement, and is deleted.
- **#6878's review note:** the phone drawer button's sync subscriptions and minute clock moved into a component rendered only on a phone, so a desktop window no longer re-renders it every minute. Its other note (dedup the kept-in-Trash titles) rests on a false premise: each report names Trash pages that import just created, so a title in two reports is two pages.
- **Catalogs:** #6879 landed the es, pt, de and fr catalogs while this was built, so the deleted strings leave all five, with the translator notes that named them, and the reworded filter hint is translated in each. Its `language-preference.spec.ts` checked a translated week-start toast; it now checks the picked option in the trigger. `advanced-query-board.spec.ts` waited on the announcer's "Undone" after a page undo; it now waits on the undo toast, shown red by unbinding Ctrl+Z.

Built by five subagents in their own worktrees on disjoint files; the orchestrator did the sync hooks, the catalogs and the docs.

## What ran

- `npx vitest related --run` over the changed source: 1129 files green, the catalog guards included; 1132 after the replay onto #6879's catalogs.
- Each removal shown red by putting it back (subagents: 6 settings, 2 views, 7 forms, 6 part-A and 5 part-B announcement sites; orchestrator: both sync announcements), each restored by a `trap`.
- Playwright: the 71 specs for the areas touched (search, Settings, Trash, undo, History, pairing, saved views, page header, reschedule, agenda, phone sheets) green, 349 tests. New: the search hint and the clamp notice, each shown red with its change removed.
- `npm run typecheck`, `typecheck:e2e`, `oxlint` and `oxfmt --check` on the changed files: clean.
- After the replay: the i18n suite, and 40 Playwright tests (language, search hint, clamp, phone sheets, and the page-mode slash and picker specs main had changed), green; the language spec's new trigger check shown red by breaking the Sunday pick.
