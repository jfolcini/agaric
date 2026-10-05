# Session 1867 — Back / Forward on every header

The maintainer: away from a page there were no previous / next buttons, so
moving around was harder than it should be. The only back control was the
page editor's arrow, which popped the open tab's page stack and then took a
single hop out to the view the stack was opened from (`Tab.enteredFrom`, by
design one slot, not a history). They chose browser-style Back / Forward on
every view over the journal's day arrows. That decision is theirs as
maintainer, since it adds navigation state.

**What a step is.** `NavLocation` is a journal mode plus its period (day;
week start; month), a page in a given tab, or any other view. The history is
kept per space, because a page id means nothing in another space. It is in
memory only, as `useNavigationStore.navHistoryBySpace`, outside
`partialize`. No new store.

**Recording.** `src/stores/navigation-history.ts` subscribes to the
navigation, tabs, journal and space stores and records on a microtask, so
one action that writes several stores lands as one entry, read once they
have settled. Opening a page writes tabs then navigation; a space switch
rewrites every per-space store. Back / Forward move the index, then replay.
A replay that lands somewhere slightly different, for example a page whose
tab was closed and so opens in the active tab, replaces the current entry
instead of pushing, so Forward survives. Deleted pages are stepped over.
Replayed pages take their current title from the resolve cache.

**Where it shows.** `HistoryNavButtons` sits in the App header after the
mobile hamburger. The page editor's own arrow is gone (`onBack` stays: it
leaves a page after delete or a space move). Android's back gesture walks
the same history, and with none left (a fresh launch) it falls back to the
old page-stack rules. No keyboard shortcut: Alt+←/→ is already the journal's
previous / next day.

**Fitting the phone row.** At 360px the journal header was already full.
Per the maintainer's pick, the five mode tabs become one menu button below
`lg` (`JournalModeMenu`). Below `md` the arrows are 24px like the row's
other icons. Measured: the date chip keeps 38px at 360px in daily mode
("Oct 5"), 61px in weekly ("Oct 5–11", which used to truncate), and 151px
on 700–1024px touch screens. There is no overflow at any width.

## Verified

- `src/stores/__tests__/navigation-history.test.ts` (11 cases),
  `HistoryNavButtons.test.tsx`, the mode-menu case in
  `JournalControls.test.tsx`, and the history-first Android back case. Nine
  mutations (replay-replaces, deleted skip, week key, tab switch, per-space,
  microtask deferral, Android order, disabled state, menu select) each went
  red on a copy, which was then restored and `cmp`-checked.
- e2e: `navigation-history.spec.ts` (views + page round trip, a journal day
  as a step); `mobile-overflow.spec.ts` at 360px and 390px (Today and the
  arrows in every mode via the menu, chip ≥ 32px, no overflow);
  `inner-links.spec.ts` multi-hop Back. Both new e2e checks went red with
  Back disabled or the menu hidden. 118 related e2e tests pass.
