# Session 2707 — findings from the post-merge review of #5968–#5985

Several PRs merged while the Claude reviewer was out of usage; independent read-only reviewers wrote findings, each re-checked against `origin/main` before building.

Applied:
- **#5969 Back / Forward (blocking).** `HistoryNavButtons` hid on `max-md`, so a mouse-and-keyboard window below 768 px had no Back or Forward: the "system back" is Android-only and no shortcut exists. It now hides on `useIsTouch() && useIsMobile()` (the signal `PageRow`'s `touchSelect` uses) through the `hidden` attribute, so the button stays in the DOM and `e2e/phone-views.spec.ts` can still drive `goBack` through it.
- **#5969 header bar.** The 56 px bar (`min-h-14 py-1.5`) is padded for 44 px targets, so it takes the same signal; a fine-pointer narrow window keeps the 48 px bar. `max-md:gap-1` stays, it is spacing not touch padding.
- **#5969 docs and tests.** `FEATURE-MAP.md` row corrected. New: `navigation-history.spec.ts` at 700 × 900 without touch (reachable, steps, bar under 56 px); `phone-header-bar.spec.ts` asserts Back / Forward, Today / Agenda / calendar absent outside the journal and the search trigger absent on the Search view, plus the page-editor header (`openPageMobile`).
- **#5970 toggle group.** `rovingKeyRef` is set only when no modifier is held, since Radix ignores a modified arrow and the flag stayed true into the next mouse focus.
- **#5973 saved views.** The phone ⋮ menu always renders `SavedViewsDropdown`; only "Save current view…" is gated on `pages.length > 0` (`canSaveCurrentView`). The Popover-only fallback branch and its `moreOpen` state are deleted.
- **#5973 comments.** `CollapsibleGroupList` chevron comment reworded; the `phone-views` 1000 ms wait is documented as an absence check (no condition marks "no hide came").
- **#5975.** `nextest.toml` #5712 paragraph reworded; the PR's "16 s to 9 s" row is edited to unmeasured (a reviewer saw ~15.5 s alone at load 5 to 7). Cost-is-the-test comments deleted from the journal op-cap, multi-chunk import and snapshot-over-QUIC tests (each under 10 s alone per the PR table); the n-way comment says devices squared times ops.
- **#5985.** `docs/BUILD.md` manual retag path: `git verify-tag` is local only (confirm Verified on GitHub), and a draft Release from the failed run is to be deleted first if it exists. No claim that this release left one.

Decisions:
- **#5973 order on the phone grid:** left, with a comment. The phone draws Delete above the options but the DOM (and desktop's left-to-right row) has options first; CSS `order` does not change tab order, and reordering the DOM would put Delete first on desktop. No visual change, so no screenshot.
- **#5981 bulk labels:** dropped. `BlockContextMenu` filters the selection to blocks the page store holds on purpose (#5273); making page mode bypass that is not a few lines, and the action already deletes every root. The window is a selection spanning a block not yet in the store.
- **Same shape, not touched:** `GlobalDateControls` also hides on `max-md`, so Today / Agenda / calendar are absent on a narrow mouse window outside the journal; nobody reported it.

Falsified (each restored in one command): `hidden={false}` and the old `max-md:hidden` class on `HistoryNavButtons`; the search-view `return null` removed; `max-md:hidden` removed from `GlobalDateControls`; the touch gate removed from the header height; the modifier guard removed from `toggle-group.tsx`; `canSaveCurrentView` forced true.
