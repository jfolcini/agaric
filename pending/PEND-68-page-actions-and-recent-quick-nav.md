# PEND-68 — Dedicated star/delete page actions + quick-nav in the recent strip

> Two related "make the obvious thing one click away" gaps, both grounded in
> best-in-class navigation/triage patterns (Notion, Linear, Obsidian, Logseq):
>
> 1. **Per-page star + delete are not consistently a dedicated, visible button.**
>    In the **page editor** star is inline but **delete is buried in the kebab**;
>    in the **journal** day headers there is **neither** — only an "Open in editor"
>    link. You should be able to star or delete the day/page you're looking at
>    without hunting through an overflow menu.
> 2. **The "recently visited" strip below the header only lists recent pages.**
>    It should also expose first-class **destination links** (Pages, Tags, Graph,
>    Search, …) so the strip becomes a true quick-access bar — but segmented so
>    "where can I go" (nav chrome) and "where have I been" (history) stay
>    visually and mentally distinct, per best-practice (mixing them in one
>    undifferentiated row is a known anti-pattern).

## TL;DR

- **Part A — dedicated page actions (FE-only, no backend):** Extract a shared
  `PageQuickActions` (Star toggle + Delete) component and wire it into
  (a) `PageHeader` (surface a dedicated **delete** button next to the existing
  star; kebab keeps the long-tail actions) and (b) journal `DaySection` day
  headers (add **both** star + delete next to the existing "Open in editor"
  link, only when the day has a `pageId`). Star reuses `useStarredPages`; delete
  reuses `usePageDelete` + `ConfirmDialog`. Add an **Undo** affordance to the
  delete success toast (delete is a soft-delete/trash, so undo = restore).
- **Part B — quick-access bar:** Turn `RecentPagesStrip` into a two-zone bar:
  a **sticky-left destinations cluster** (`QuickNavChip` per destination →
  `useNavigationStore.setView`, with `aria-current` on the active view) + a
  divider + the existing **scrollable recents** cluster (`RecentPageChip`,
  unchanged behaviour). One combined roving-tabindex spans both zones.
- **Cost:** M (~10–14 h total: A ≈ 4–6 h, B ≈ 5–7 h, docs ≈ 1 h). No schema
  migrations, no new Tauri commands (verify a single-id restore command exists
  for the undo toast; otherwise undo is deferred to a follow-up — see Open Qs).
- **Risk:** Low–medium. The load-bearing behaviour change is the strip no longer
  auto-hiding when recents are empty (it now always shows destinations on
  desktop). That ripples into `RecentPagesStrip.test.tsx`. Destructive-action
  ergonomics (a dedicated delete button is one misclick away from content) are
  mitigated by the existing confirm dialog + the new undo toast.

## Current state (verified)

### Part A — page actions

- **Page editor header** — `src/components/PageHeader.tsx:365-423`. Title row
  renders: back button → `PageTitleEditor` → an inline **Star** `IconButton`
  (`:389-398`, `useStarredPages`, lucide `Star`, fills when starred) →
  `PageOutline` → `PageHeaderMenu` (kebab). **Delete is only in the kebab**:
  `onDeleteRequest` (`:414-417`) flips `setDeleteDialogOpen(true)`, which drives a
  `ConfirmDialog` (destructive) → `deleteBlock(pageId)`.
- **Journal day header** — `src/components/journal/DaySection.tsx:130-230`.
  Per-day header renders the date heading, count badges (weekly/monthly), and an
  "Open in editor" `ExternalLink` `Button` (`:204-213` weekly/monthly, `:217-230`
  daily). **No star, no delete.** Each day with `entry.pageId` *is* a page (the
  daily note), so both actions are applicable; `onNavigateToPage` is already
  threaded in.
- **Pages list rows** — `src/components/PageBrowser/DensityRow.tsx` already has
  the canonical inline pattern: a **Star** button (`:271-283`, hover-reveal on
  desktop / always-visible on touch) and a trailing **Trash2** delete button
  (`:345-358`, `disabled` while deleting). This is the visual/behavioural
  template Part A generalises.
- **Star infra** — `src/hooks/useStarredPages.ts:45-69` →
  `{ starredIds, isStarred, toggle }`. localStorage key `'starred-pages'`
  (`src/lib/starred-pages.ts`), cross-tab `'starred-pages-changed'` window event.
  **Per-device, no backend.**
- **Delete infra** — `src/hooks/usePageDelete.ts` →
  `{ deleteTarget, deletingId, setDeleteTarget, handleConfirmDelete, handleDeletePage }`.
  `handleDeletePage` calls `deleteBlock(pageId)`, sets the resolve cache to
  `'(deleted)'`, and shows a success toast (`pageBrowser.deleteSuccess`) /
  an error toast with a retry action. **No undo on the success path today.**
- **Shared primitives** — `IconButton` (`src/components/ui/icon-button.tsx`,
  ghost icon button with `tooltip` + `ariaLabel`), `Button`
  (`src/components/ui/button.tsx`, `icon`/`icon-xs` sizes), `Tooltip`
  (`src/components/ui/tooltip.tsx`), `ConfirmDialog`, the Popover-based menu
  primitives (`menu-popover-content.tsx`, `popover-menu-item.tsx`).
- **i18n** — `react-i18next` `t('namespace.key')`; page/journal keys live in
  `src/lib/i18n/pages.ts` (e.g. `pageHeader.starPage` / `unstarPage` `:113-114`,
  `pageBrowser.deleteButton` `:131`, `pageBrowser.deleteSuccess` `:127`,
  `pageTree.delete` `:115`; journal `journal.openInEditor` / `openInEditorLabel`).

### Part B — recent strip

- **Component** — `src/components/RecentPagesStrip.tsx:61-255`, mounted in
  `src/App.tsx:509` between `<TabBar>` and `<ViewHeaderOutletSlot>` (a
  non-scrollable shell slot — load-bearing for the wheel-to-horizontal handler).
  Renders a `<nav aria-label={t('recent.ariaLabel')}>` → horizontal `ScrollArea`
  → flex row of `RecentPageChip`s.
- **Data** — `src/stores/recent-pages.ts`: per-space MRU (`MAX_RETAINED = 10`),
  `selectRecentPagesForSpace`. Visits recorded centrally via
  `useTabsStore.navigateToPage` → `recordVisit`. The **currently-open page is
  filtered out** (`visible = recentPages.filter(p => p.pageId !== activePageId)`).
- **Behaviour today** — `if (isMobile) return null` and
  `if (visible.length === 0) return null` (`:182-183`): the **whole strip
  disappears** with no recents and on mobile. Click → `navigateToPage`;
  Ctrl/Cmd/middle-click → `openInNewTab`. Roving tabindex via
  `useListKeyboardNavigation` (`horizontal`, `wrap`), imperative focus +
  `scrollIntoView`, wheel-to-horizontal (`handleWheel`), right-edge overflow
  mask (`hasOverflow`). Chip primitive: `src/components/ui/recent-page-chip.tsx`
  (h-7 desktop, h-11 coarse-pointer, `max-w-[160px]` truncate).
- **Destinations** — `src/components/nav-items.ts:31-42` `NAV_ITEMS`:
  `journal/search/pages/tags/settings/trash/status/history/templates/graph`,
  each `{ id, icon (lucide), labelKey: 'sidebar.*' }`. Navigation via
  `useNavigationStore.setView(view)` (`src/stores/navigation.ts:111-118`,
  per-space `currentView`). The sidebar (`AppSidebar`) already renders all ten.
- **Tests** — `src/components/__tests__/RecentPagesStrip.test.tsx` asserts
  render, current-page exclusion, **auto-hide when empty**, mobile auto-hide,
  click/aux-click nav, keyboard roving + wrap, wheel translation, overflow mask,
  axe-clean.

## Design

### Part A — dedicated, consistent, recoverable page actions

**Principle:** star is a safe, reversible toggle → always a visible inline
button. Delete is destructive → keep it confirmed **and** make it recoverable
(undo), so "easy to reach" doesn't mean "easy to regret". This is the
Gmail/Linear pattern: one-click delete + a persistent confirm/undo, rather than
hiding destructive actions so deep they're undiscoverable.

**1. Extract `src/components/PageQuickActions.tsx`** — the single source of truth
for the star+delete affordance, so the page header, journal day header, and
(optionally) the Pages-list row stop drifting apart.

```tsx
interface PageQuickActionsProps {
  pageId: string
  title: string
  // Layout/prominence: 'header' (page editor, h-4 icons),
  // 'journal' (day header, icon-xs, hover-reveal), 'row' (Pages list).
  variant: 'header' | 'journal' | 'row'
  // Optional: hide delete where it doesn't belong (e.g. a future read-only ctx).
  showDelete?: boolean
}
```

- Internally consumes `useStarredPages()` (`isStarred(pageId)`, `toggle`) and a
  delete callback. Renders a `Star` `IconButton` (aria-pressed + state-driven
  tooltip/label, fills when starred) and a `Trash2` delete `IconButton`
  (destructive-on-hover styling, `disabled` while a delete is in flight).
- Delete routes through the existing confirm flow. To avoid every call site
  re-implementing the dialog, lift the confirm + toast into a small
  `usePageDeleteAction()` wrapper around `usePageDelete` that exposes
  `requestDelete(pageId, title)` and renders/owns one `ConfirmDialog`
  (or render the dialog once at each host and pass `onDelete`). Pick the
  host-owns-dialog shape that matches how `PageBrowser` already does it to
  minimise churn.
- a11y: both buttons get `aria-label`s that reflect state; star uses
  `aria-pressed`; 44px touch targets on coarse pointers (reuse existing
  `[@media(pointer:coarse)]` sizing); focus-visible rings.

**2. Wire into `PageHeader.tsx`** — keep the existing inline star, add a
**dedicated delete** `IconButton` immediately after it (or render
`PageQuickActions variant="header"` in place of the standalone star).
`PageHeaderMenu` (kebab) **keeps** delete as a secondary path *plus* the
long-tail actions (export, alias, tag, property, move-to-space, undo/redo,
open-in-new-tab) — the kebab is not removed, only de-duplicated as the *primary*
destructive path.

**3. Wire into journal `DaySection.tsx`** — render
`PageQuickActions variant="journal"` next to the "Open in editor" button in both
the weekly/monthly header (`:204-213`) and the daily-mode header (`:217-230`),
guarded by `entry.pageId`. Hover-reveal on desktop / always-visible on touch,
matching `DensityRow`. Journal-specific confirm copy ("Delete the note for
{date}?") since deleting a daily note is higher-stakes than a normal page.

**4. Undo on delete** — extend the delete success toast with an **Undo** action
that restores the just-trashed page (delete is a soft-delete → Trash, already
restorable from `TrashView`). Wire the toast action to the single-id restore
command. **Verify** a single-id restore exists (`restore_blocks_by_ids` takes a
list, so a one-element call works); if the FE wrapper isn't already exposed,
adding it is trivial. If restore wiring proves non-trivial, ship A without undo
and track undo as a fast-follow (Open Q1).

**5. (Optional, deferred) refactor `DensityRow`** to consume `PageQuickActions`
so all three surfaces share one implementation. Low-risk but not required for
the user-visible win; do it only if it lands cleanly.

### Part B — quick-access bar (recent strip + destinations)

**Principle:** don't dump destinations into the recents row undifferentiated.
Segment the bar into a **pinned destinations zone** (nav chrome) and a
**scrollable recents zone** (history), the way Notion/Linear/Obsidian separate
"go to" from "recently opened". Two visual languages: destination chips are
**icon + label** with an **active state**; recent chips stay **text-only**
(unchanged).

**Layout** (left → right, inside the existing `<nav>`):

```
[ 📄 Pages ][ # Tags ][ ◯ Graph ][ 🔍 Search ]  │  Recent A   Recent B   Recent C …
└──── sticky, non-scrolling destinations ────┘  div  └──── scrollable recents (mask) ──┘
```

- **`src/components/ui/quick-nav-chip.tsx`** — new primitive mirroring
  `recent-page-chip.tsx` chrome (h-7 / h-11 coarse), but icon-led and with an
  **active** style + `aria-current="page"` when its view is the current view.
- **Destination set** — a small `QUICK_NAV_DESTINATIONS` allowlist (subset of
  `NAV_ITEMS`, reusing the same `icon` + `sidebar.*` labels). Default:
  **Pages, Tags, Graph, Search** (+ optionally Journal as "home"). Deliberately
  **not** all ten — Settings/Status/History/Templates/Trash are chrome/rare and
  stay in the sidebar; duplicating the whole sidebar here is noise. Keep the set
  to ~3–5 high-frequency content destinations (Open Q2 covers
  configurability).
- **Structure** — destinations cluster is `sticky left-0` (or simply rendered
  before the scroller and excluded from horizontal scroll) so it's always
  reachable; a thin `border-l border-border/40` divider separates it from the
  recents `ScrollArea`. Recents keep the existing scroller, wheel handler, and
  overflow mask verbatim.
- **Keyboard** — extend the single roving tabindex to span
  `[...destinations, ...recents]` as one ordered list. Build a tagged-union
  `items` array (`{kind:'destination', view, icon, labelKey}` |
  `{kind:'recent', pageId, title}`); `useListKeyboardNavigation.onSelect(i)`
  dispatches `setView` or `navigateToPage` by `kind`. Left/Right traverse both
  zones with wrap (unchanged hook).
- **Click semantics** — destination chip → `setView(view)`; recent chip →
  existing `navigateToPage` / Ctrl-Cmd-middle `openInNewTab`. Destinations have
  no "open in new tab" (views aren't tabs).
- **Render gate change (load-bearing)** — today the strip returns `null` when
  `visible.length === 0`. With persistent destinations the strip should render
  whenever **either** destinations **or** recents are non-empty:
  `if (isMobile) return null; if (destinations.length === 0 && visible.length === 0) return null`.
  Net effect: on desktop the bar is now (almost) always present. This is the
  intended "quick-access bar" behaviour but it changes existing tests and the
  app's vertical rhythm — call it out in review. **Mobile stays hidden** (the
  mobile bottom-nav already covers destinations); revisit only if requested
  (Open Q3).
- **Naming** — rename the component to `QuickAccessBar` (keep
  `RecentPagesStrip` as a thin re-export or update the single `App.tsx` import +
  `data-testid`). Keep the change mechanical to avoid a churny rename.

## Phase split

### Part A

- **A0 — `PageQuickActions` + `usePageDeleteAction`** (S, ~1.5 h). New component +
  the confirm/toast wrapper; unit-tested in isolation.
- **A1 — PageHeader** (S, ~1 h). Add the dedicated delete button next to star;
  keep kebab. Verify no double-confirm dialogs.
- **A2 — Journal DaySection** (S–M, ~1.5 h). Star + delete in both header
  branches, `entry.pageId`-guarded, journal-specific confirm copy.
- **A3 — Undo toast** (S, ~1 h, gated on restore-command verification). Add Undo
  to the success toast → single-id restore.
- **A4 — (optional) DensityRow refactor** (S, ~1 h). Only if it lands cleanly.

### Part B

- **B0 — `QuickNavChip` primitive** (S, ~1 h).
- **B1 — `QUICK_NAV_DESTINATIONS` constant** (XS). Subset of `NAV_ITEMS`.
- **B2 — `QuickAccessBar` refactor** (M, ~2.5–3 h). Sticky destinations cluster +
  divider + existing recents; combined roving keyboard model; `setView` +
  `aria-current`; render-gate change.
- **B3 — Tests** (M, ~2 h). Update `RecentPagesStrip.test.tsx` for the new
  render gate + destinations; add destination-click/active-state/keyboard tests;
  keep axe clean.

### Cross-cutting

- **i18n** — reuse `sidebar.*` for destination labels; add an aria-label for the
  bar if the semantics shift (`recent.quickNavAriaLabel`), journal delete-confirm
  copy, and any new toast strings. Keys go in `src/lib/i18n/pages.ts` /
  `common.ts`.
- **Docs** — update the relevant UI/architecture doc (and `AGENTS.md` if it
  documents the strip) to describe the two-zone bar and the shared
  `PageQuickActions` invariant ("star is localStorage/per-device; delete is a
  confirmed soft-delete with undo").

## Robustness / edge cases

- **Deleting the current page** from the page header → after delete, navigate
  back / close the tab as the existing kebab-delete path already does (reuse that
  post-delete navigation; don't leave the editor pointed at a trashed block).
- **Deleting a journal day note** with children → soft-delete trashes the subtree
  as `deleteBlock` already does; the journal re-renders without that day's note
  (an auto-created empty daily note may simply re-create on next visit — confirm
  the journal's daily-note creation path so undo vs. re-create don't fight; Open
  Q1).
- **Undo race** — if the user navigates or the toast auto-dismisses, undo is a
  no-op-safe restore-by-id (idempotent; restoring an already-present id is a
  tolerated skip per the bulk-restore policy).
- **Star cross-tab** — already handled by `useStarredPages` broadcast; multiple
  surfaces showing the same page stay in sync.
- **Quick-nav active state across spaces** — `currentView` is per-space
  (`navigation.ts`); `aria-current` reflects the active space's view.
- **Strip wheel/overflow invariant** — keep the destinations cluster outside the
  scroller (or sticky) so the wheel-to-horizontal handler and the overflow mask
  still apply only to the recents zone; don't nest the bar in a scrollable
  parent (the existing `App.tsx` shell slot stays).
- **Empty recents, present destinations** — bar renders; recents zone collapses
  to zero width (no divider dangling — only render the divider when both zones
  are non-empty).

## Performance

- Part A is pure render wiring; no new IPC except the (one-element) restore call
  on explicit undo. Star toggle stays synchronous localStorage + event.
- Part B adds ≤5 static destination chips; no new data subscriptions beyond
  `currentView` (already a cheap store read). Roving-tabindex list grows by ≤5 —
  negligible. No new ResizeObserver beyond the existing overflow check.

## Tests

### Part A (`src/components/__tests__/` + `src/hooks/__tests__/`)

- `PageQuickActions`: star toggles + reflects `isStarred`; delete opens confirm;
  confirm calls delete; `aria-pressed`/labels flip with state; axe-clean for each
  `variant`.
- PageHeader: dedicated delete button present, opens the same confirm as the
  kebab path; no duplicate dialogs.
- DaySection: star + delete render only when `entry.pageId`; journal confirm copy;
  hidden affordances appear on hover/touch.
- Undo toast (if A3 ships): success toast exposes Undo; clicking it calls restore
  with the deleted id.

### Part B (`src/components/__tests__/RecentPagesStrip.test.tsx` → renamed)

- Destinations render with icons + `sidebar.*` labels; active destination has
  `aria-current="page"`.
- Destination click → `setView(view)`; recent click unchanged.
- **Render gate**: bar shows with destinations even when recents empty; still
  hidden on mobile; divider only when both zones present.
- Combined roving tabindex spans destinations + recents; Left/Right wrap;
  Enter/Space activate the right handler per `kind`.
- Existing recents behaviours (exclusion of current page, wheel translation,
  overflow mask) still pass.

### E2E (`e2e/`)

- From the journal, star today's note → it appears starred in the Pages
  "Starred" group.
- From a page, click the dedicated delete → confirm → page is trashed → Undo
  restores it.
- Click the "Pages" quick-nav chip in the bar → Pages view opens and its chip
  shows the active state.

## Open questions

1. **Undo scope.** Ship the Undo toast in this plan (A3), or land A without it
   and fast-follow? Depends on whether a single-id restore FE wrapper already
   exists and whether journal daily-note auto-recreation conflicts with restore.
   Recommendation: include it; it's the difference between "easy" and "safe".
2. **Quick-nav destination set — fixed vs. configurable.** v1 ships a fixed
   allowlist (Pages, Tags, Graph, Search [+ Journal]). User-pinnable destinations
   (drag-to-pin, à la a bookmarks bar) is a tempting follow-up but its own design
   + storage question — defer.
3. **Mobile.** Keep the bar desktop-only (mobile bottom-nav covers destinations),
   or surface a compact destinations row on mobile too? Default: desktop-only.
4. **Component rename.** `RecentPagesStrip` → `QuickAccessBar` (cleaner) vs. keep
   the name to minimise diff. Default: rename with a mechanical import/testid
   update.
5. **Page-header layout pressure.** Adding a dedicated delete button next to
   star, outline, and the kebab tightens the title row. Confirm it doesn't crowd
   narrow widths; if it does, the delete button can collapse into the row's
   hover-reveal group rather than always-visible.

## Acceptance criteria

- From a journal day header (when the day has a note) the user can **star** and
  **delete** that day's note with one dedicated button each, without opening any
  menu; delete is confirmed and (if A3) undoable.
- From the page editor the user can **delete** the current page with a dedicated
  button (not only via the kebab); star remains one click; both are confirmed /
  recoverable as applicable.
- Star toggled from any surface is reflected everywhere (cross-tab event) and in
  the Pages "Starred" group.
- The bar below the header shows **destination chips** (Pages, Tags, Graph,
  Search [+ Journal]) on the left and **recent pages** on the right, visually
  segmented; the active view's chip carries `aria-current="page"`.
- Clicking a destination chip switches the view via `setView`; clicking a recent
  chip navigates as before (Ctrl/Cmd/middle-click still opens in a new tab).
- Keyboard: one Left/Right roving traversal covers destinations + recents;
  Enter/Space activates the right action per chip kind.
- The bar renders on desktop even with no recent pages (persistent quick-nav);
  stays hidden on mobile; axe-clean.
- No new schema migrations; no new always-on Tauri commands (only the existing
  restore command, called with a one-element list, on explicit undo).

## Related

- `src/components/PageHeader.tsx:365-423` — page-editor title row (star inline,
  delete in kebab today).
- `src/components/PageHeaderMenu.tsx` — kebab; keeps long-tail + secondary delete.
- `src/components/journal/DaySection.tsx:130-230` — journal day header
  (open-in-editor only today).
- `src/components/PageBrowser/DensityRow.tsx:271-283, :345-358` — canonical inline
  star + delete pattern Part A generalises.
- `src/hooks/useStarredPages.ts` + `src/lib/starred-pages.ts` — star infra
  (localStorage + cross-tab event, per-device).
- `src/hooks/usePageDelete.ts` — delete infra (`deleteBlock`, confirm, toast).
- `src/components/ui/icon-button.tsx`, `ui/tooltip.tsx`, `ConfirmDialog` — shared
  primitives `PageQuickActions` composes.
- `src/components/RecentPagesStrip.tsx:61-255` — strip → `QuickAccessBar`.
- `src/components/ui/recent-page-chip.tsx` — chip chrome `QuickNavChip` mirrors.
- `src/components/nav-items.ts:31-42` — `NAV_ITEMS` (destination icons + labels).
- `src/stores/navigation.ts:111-118` — `setView` (per-space `currentView`).
- `src/stores/recent-pages.ts` — recents MRU (unchanged).
- `src/App.tsx:509` — strip mount point (non-scrollable shell slot).
- `src/components/__tests__/RecentPagesStrip.test.tsx` — test target to update.
- `src/lib/i18n/pages.ts` — i18n keys home.
