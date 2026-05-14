# Agaric Design System — UX Review

> **Status:** Tier 1 + Tier 3 hygiene mostly shipped. **Tier 1 closed:**
> item 1 (Button `active:` states across all 6 variants + size-dependent
> scale), item 2 (iOS auto-zoom on `<Select>`), item 3
> (`useAutoScrollOnDrag` reduced-motion), item 6 (settings-tab heading
> style standardized on `Card`/`CardHeader`/`CardTitle` —
> AgentAccessSettingsTab + GoogleCalendarSettingsTab +
> KeyboardSettingsTab + settings/HelpTab migrated, DataSettingsTab
> already on the pattern), item 7 (filter-chip visual consistency —
> SearchPanel chip bar migrated to `FilterPill`; AgendaFilterBuilder
> chip adopts `Badge variant="secondary"` matching FilterPill's chrome
> while preserving click-to-edit popover; HistoryFilterBar and
> DuePanelFilters intentionally skipped — see item-7 entry below for
> rationale), item 9 (3 `return null` empty-state guards →
> `<EmptyState compact>` in DonePanel + LinkedReferences +
> UnlinkedReferences), item 10 (LoadingSkeleton accepts `loading` prop
> with `role="status" aria-busy`; StatusPanel + PageBrowser + TagList +
> JournalPage migrated), item 11 (`ConfirmDialog` +
> `ConfirmDestructiveAction` merged into a single i18n-key /
> async-aware `ConfirmDialog` with a `secondaryAction` escape hatch
> for the GoogleCalendar disconnect dual-action; PairingDialog +
> GoogleCalendarSettingsTab migrated; `ConfirmDestructiveAction.tsx`
>
> + its test file deleted), item 5 (`FeaturePageHeader` primitive
> with `{title, breadcrumb?, actions?, kebab?}` shipped in
> `ui/feature-page-header.tsx`; the six previously-unwrapped views
> — JournalPage, TrashView, SettingsView, StatusPanel, GraphView,
> TemplatesView — now render the shared `<h1>` landmark + slot
> chrome; `ViewHeader` portal mechanic kept separate by design,
> see resolution note under item 5).
> **Tier 2 (doc drift) closed:** D1 (`task-todo` token), D3 (ProseMirror
> padding), D5 (sync indicator tokens), D6 (single-RAF clarified), D8
> (ListViewState pattern label), D9 (priority badge touch table), D10
> (button h-11 vs h-10). **Tier 3 closed:** popover `outline-none` →
> `outline-hidden`; select.tsx `outline-none` → `outline-hidden`;
> `data-slot` added to 6 of 7 primitives (menu-popover-content
> deliberately preserves inherited `data-slot="popover-content"` —
> its tests assert that); sheet animation duration → `duration-moderate`;
> `SelectTrigger` consumes `SHARED_INPUT_CLASSES`; three inconsistent
> `ring-offset-*` removed from HistoryListItem + TagList +
> SpaceManageDialog; 4 dead tokens (`--leading-relaxed`,
> `--tracking-tight/normal/wide`) removed from index.css; toggle-group
> ad-hoc `focus-visible:ring-2 ring-ring` collapsed to the standard
> `focus-ring-visible` utility; `useTrashMultiSelect` thin wrapper +
> its test deleted (TrashView now calls `useListMultiSelect` directly);
> hardcoded English fallbacks `'(empty)'` / `'Projected'` / `'P${v}'`
> replaced with proper i18n keys (`common.empty`, `due.projected`,
> `graph.filter.priorityValue.*`); `@media (prefers-contrast: more)`
> block extended to cover `--ring`, every `--alert-*`, `--op-*`,
> `--date-*`, `--conflict-*`, `--task-*`, `--block-ref`, `--highlight`,
> and `--sync-*` family (both light and dark themes).
> **Still open:** Tier 1 items 4, 8 + every Tier 2 entry +
> component-decomposition backlog + list rendering primitive zoo.

**Date:** 2026-05-09
**Method.** Round 1: four parallel subagents reviewed (a) tokens / theming / a11y, (b) UI primitives in `src/components/ui/`, (c) shared compositions in `src/components/` + `src/hooks/`, (d) feature-screen consistency across top-level views. Round 2: four independent verifiers fact-checked every claim against actual code (file/line/grep). 56 raw findings → **50 fully verified, 6 partial (line-numbers or counts off), 0 hallucinated**. Five claims that softened or reversed on verification are flagged at the end.

The verified state of the system is **strong on tokens and primitives, weaker on cross-screen composition and doc-vs-code drift**. The fixes below are ordered by leverage, not by reviewer slice.

---

## Tier 1 — Real consistency gaps worth fixing

**1. `Button` has no `active:` states (the project's most-used primitive).**
`ui/button.tsx:8-31` — only `hover:` and `focus-visible:` rules. UX.md:683/698/1499 mandates `active:scale-95` plus active background shifts, but only `filter-pill.tsx:48` actually implements it. App-wide press feedback is missing.
**Fix:** add `active:scale-[0.98]` (or `:scale-95` for icon sizes) + per-variant `active:bg-*` to the CVA base. ~10-line change, propagates to ~84 importers.

**2. iOS auto-zoom on `<Select>` triggers.**
`ui/select.tsx:38-39` is `text-sm` with no `[@media(pointer:coarse)]:text-base`. `Input` and `Textarea` both promote to 16 px on coarse pointer to defeat iOS zoom — `Select` doesn't, so tapping a select on iPhone zooms the viewport.
**Fix:** append `[@media(pointer:coarse)]:text-base` to both size strings.

**3. `useAutoScrollOnDrag` ignores `prefers-reduced-motion`.**
`src/hooks/useAutoScrollOnDrag.ts:42-69` — RAF-driven scroll loop with no `matchMedia` check. AGENTS.md/UX.md explicitly require JS-driven animations to honor reduced motion (other hooks like `useGraphSimulation`, `useScrollToFocus` do).
**Fix:** check `window.matchMedia('(prefers-reduced-motion: reduce)')` once on effect entry; skip the RAF loop or jump in one frame.

**4. Six badge-shaped primitives with fuzzy boundaries.** *(closed —
`Badge` now carries the `tone`/`size`/`shape` axes; `StatusBadge` +
`PriorityBadge` deleted; `alert-list-item` renamed; see resolution
below)*
`badge.tsx`, `status-badge.tsx`, `priority-badge.tsx`, `filter-pill.tsx`, `recent-page-chip.tsx`, `alert-list-item.tsx`. Only `Badge` is in the AGENTS.md inventory; `StatusBadge` uses `rounded` instead of `rounded-full` and lacks `data-slot`. The family fragments without clear ownership.
**Fix:** promote `Badge` to a base with `tone`/`size`/`interactive` variants; collapse `StatusBadge` and `PriorityBadge` into it. Keep `FilterPill` and `RecentPageChip` (they're buttons-shaped-as-badges, different a11y contract). Rename `alert-list-item.tsx` → `alert-list-row.tsx` to break the badge-naming collision.

**Resolution.** `src/components/ui/badge.tsx` rewritten with three
orthogonal axes — `tone` (`default | secondary | destructive |
outline | ghost | link | priority | status`), `size` (`xs | sm |
compact | default | lg`), `shape` (`pill | rounded`) — plus
`statusState` / `priorityLevel` props that feed colour into the
`status` and `priority` tones. The `priority` tone delegates to the
existing `priorityColor()` utility (UX-201b index-based) instead of
duplicating the level→token map. The legacy `variant` prop is kept
as a 1:1 alias for `tone` so unrelated callers do not need to be
touched. `compact` size matches the legacy `StatusBadge` chrome
(`px-1 py-0.5`, no fixed height); `sm` matches the legacy
`PriorityBadge` md cell (`h-4 min-w-4 px-1`); `lg` matches the
legacy `PriorityBadge` lg cell (header chip).

+ `src/components/ui/status-badge.tsx` — **deleted** (5 states
  collapsed into `tone="status"` + `statusState`).
+ `src/components/ui/priority-badge.tsx` — **deleted** (3 sizes +
  `P{n}` label moved to caller; `tone="priority"` + `priorityLevel`
  drives the colour through `priorityColor()`).
+ `src/components/ui/alert-list-item.tsx` → **renamed**
  `alert-list-row.tsx`. Exported `AlertListRow`; `data-slot` updated
  to `alert-list-row`. Renamed to break the badge-naming collision
  (it is a list `<li>` row, not a badge-shaped item).
+ Four consumer files migrated: `AlertSection`, `BlockListItem`,
  `DuePanel`, `QueryResultList`. `FilterPill` and `RecentPageChip`
  left in place — different a11y contracts (button-shaped
  primitives), out of scope.

**Verification.** Full `npx vitest run` clean (9 746 tests, two
removed primitive tests had 33 cases between them, all behaviour
recovered by the extended Badge suite — 21 cases including 5 new
`tone="status"`, 5 `tone="priority"`, and 4 size/shape cases). `npx
tsc -b --noEmit` clean. `npx --no biome check src/components/...`
on every touched file clean. ARCHITECTURE.md inventory dropped from
41 → 39; AGENTS.md mandatory-patterns row notes the new axes.

**5. Page-header chrome is non-existent — every top-level view rolls its own.** *(closed —
`FeaturePageHeader` shipped + six unwrapped views migrated; see
resolution below)*
`ViewHeader` is used by 5 views (`PageBrowser`, `HistoryView`, `SearchPanel`, `journal/AgendaView`, `PageHeader`). Six others ignore it: `JournalPage`, `TrashView`, `SettingsView`, `StatusPanel`, `GraphView`, `TemplatesView`. No shared title/breadcrumb/actions abstraction. (ConflictList was deleted by PEND-09 Phase 5.)
**Fix:** introduce a `FeaturePageHeader` primitive `{title, breadcrumb?, actions?, kebab?}` and wrap every top-level view; codify in AGENTS.md.

**Resolution.** Investigation found `ViewHeader` is not a styled header
at all — it is a `createPortal` wrapper that lifts content above the
shared `<ScrollArea>` (so filter bars / batch toolbars stay visible
during scroll). The audit's premise that the five wrapped views shared
title/actions chrome was off: `ViewHeader`'s children are freeform and
none of the five views currently render a `<h1>` or a title-bearing
element. Renaming or extending `ViewHeader` would have either lost the
portal behaviour or forced every consumer to thread title/actions
through the outlet layer. Picked **option (b)** from the migration
plan: introduce `FeaturePageHeader` as a new sibling primitive,
orthogonal to the portal mechanic, with the audit's exact slot
contract.

+ `src/components/ui/feature-page-header.tsx` — new primitive. Renders
  a `<header data-slot="feature-page-header">` containing an optional
  `breadcrumb` slot, an `<h1 data-slot="feature-page-header-title">`,
  an optional right-aligned `actions` slot, and an optional `kebab`
  slot. 14 tests in `ui/__tests__/primitives.test.tsx` cover render,
  every slot (present + absent), ref forwarding, className merging,
  and `axe()`.
+ **JournalPage** — adds `<h1>Journal</h1>`; the existing
  configure-journal-template button (UX-371) moves into the
  `actions` slot, preserving its agenda-mode visibility guard.
+ **TrashView** — adds `<h1>Trash</h1>`; the existing Restore-All /
  Empty-Trash button row migrates into `actions` (still gated on
  `blocks.length > 0` so the buttons disappear on an empty bin).
+ **SettingsView** — adds `<h1>Settings</h1>`; the existing UX-381
  breadcrumb `<nav>` (preserved verbatim so the SettingsView tests'
  `getByRole('navigation', { name: t('sidebar.settings') })`
  resolves unchanged) moves into the `breadcrumb` slot.
+ **StatusPanel** — adds a top-level `<h1>Status</h1>` above the two
  pre-existing materializer / sync `Card`s (their CardTitle remain
  as sub-section headings beneath).
+ **GraphView** — adds `<h1>Graph</h1>`. Required wrapping the four
  render states (loading / error / empty / populated) in a single
  flex column so the header stays present across every state, not
  just the populated graph. The absolute-positioned filter bar and
  zoom controls retain their existing positions.
+ **TemplatesView** — adds `<h1>Templates</h1>` above the existing
  create-template form. The form stays a standalone block (it spans
  the row at `sm+` breakpoints and would not fit comfortably inside
  the right-aligned `actions` slot).

**`ViewHeader` left in place.** It remains the portal mechanism
consumed by PageBrowser / HistoryView / SearchPanel / AgendaView /
PageHeader for the shared `<ViewHeaderOutletSlot>` (filter bars,
batch toolbars, search forms) — orthogonal to the visual chrome
contract that `FeaturePageHeader` now owns. Views that need both
(in-view title + portaled filter bar) can compose them; the
existing five already deliver portaled content without a title,
which the App-shell `headerLabel` covers.

**Verification.** 483 tests pass across the six migrated views and
the primitives test file (`TrashView` 83, `SettingsView` 54,
`StatusPanel` 35, `TemplatesView` 26, `GraphView` 49, `JournalPage`
133, primitives 103); `npx tsc -b --noEmit` clean. The three
PageHeader UX-282 failures observed in `npx vitest run` are
pre-existing on this branch (lucide-react mock missing `Loader2`
after the local `ConfirmDialog`/`Spinner` refactor) — unrelated to
this migration.

**AGENTS.md.** `FeaturePageHeader` appended to the UI-primitives
example list in the component-hierarchy table.

**6. Settings tabs each invent their own heading style.**
`AgentAccessSettingsTab.tsx:264` and `GoogleCalendarSettingsTab.tsx:404` use `<h2 text-base font-medium>`; `KeyboardSettingsTab.tsx:139` uses `<h3 text-lg font-semibold>`; `DataSettingsTab.tsx:166-296` uses `Card`/`CardHeader`/`CardTitle`; `settings/HelpTab.tsx:23` uses `<h3 text-sm font-medium>`. Five tabs, four styles, two heading levels.
**Fix:** standardize on the `Card` pattern (DataSettingsTab) and rewrite the four others.

**7. Filter UI fragmented across multiple surfaces.** *(closed —
filter-chip visual contract aligned across the four surfaces; see
status of each below)*
Only `BacklinkFilterBuilder` and `GraphFilterBar` use the shared `FilterPill` / `FilterPillRow`. `HistoryFilterBar`, `DuePanelFilters`, `SearchPanel` chip bar, `AgendaFilterBuilder` all roll their own. Users moving between Search / Agenda / History see different filter UX every time. (ConflictList was deleted by PEND-09 Phase 5.)
**Fix:** standardize on `FilterPill` + `FilterPillRow` + a shared `AddFilterPopover`; migrate the divergent ones in priority order.

**Resolution.** Two surfaces migrated, two surfaces audited and
intentionally left in place because they don't carry a removable-chip
contract — collapsing them onto `FilterPill` would have been a
misfit, not a consolidation:

+ **`SearchPanel` chip bar** — migrated. The two ad-hoc
  `<Badge variant="secondary">` + X-button chips (page filter, tag
  filters) are now `FilterPill` instances; `Badge` and the `X` import
  were dropped from the file. Behaviour identical (label text, aria
  labels, remove handler all preserved), visual chrome now matches
  `BacklinkFilterBuilder` / `GraphFilterBar` / `FilterPillRow`. The
  73-test SearchPanel suite passes without touching assertions because
  `FilterPill` renders the label as plain Badge text and exposes the
  remove button via the same `aria-label` the tests already match on.
+ **`AgendaFilterBuilder` chip** — visual chrome migrated, edit
  affordance preserved. The chip carries a *two-action* contract
  (click body → edit popover; click X → remove) that `FilterPill`
  can't express because the primitive's body isn't interactive and
  the task brief forbids modifying `ui/filter-pill.tsx`. Instead the
  bespoke `<div className="… rounded-full bg-muted">` wrapper was
  replaced with the `Badge variant="secondary"` shell (with
  `data-slot="filter-pill"` and `role="group"`) that `FilterPill`
  itself uses, so the visual chrome (background, padding, X target
  sizing, coarse-pointer 44 px hit area, `active:scale-95`) is now
  identical. The 51-test `AgendaFilterBuilder` suite passes unchanged.
+ **`HistoryFilterBar`** — intentionally skipped. The "active filter"
  here *is* a `<Select>` dropdown value, not a removable chip;
  Session 712's compact migration deliberately collapsed the
  filter list into the Select trigger + an inline `✕` icon-button
  that clears it. Forcing a `FilterPill` next to the Select would
  duplicate the Select's state in two visual places; replacing the
  Select with a button-that-opens-a-popover-then-renders-a-chip is
  a regression to the pre-Session-712 multi-row layout. No chip
  contract to align here — the current dropdown IS the filter UI.
+ **`DuePanelFilters`** — intentionally skipped. The four buttons
  (All / Due / Scheduled / Properties) are a mutually-exclusive
  *segmented toggle group* (`aria-pressed`, not `onRemove`); users
  switch between them, they don't add/remove them. `FilterPill`
  encodes a remove-affordance the toggles don't have. (A future
  cleanup might extract a shared `SegmentedToggle` primitive; that
  is a separate ticket, not a `FilterPill` migration.)

**`AddFilterPopover` decision: not extracted.** The three existing
"add filter" flows (`BacklinkFilterBuilder` via inline
`AddFilterRow`, `GraphFilterBar`'s single-step `<Select>` popover,
`AgendaFilterBuilder`'s two-step pick-dimension → pick-values
popover with `DIMENSION_GROUPS` headings + `EditFilterPopover`
re-use) differ enough that a shared primitive collapses to either
`<Popover>{trigger}{content}</Popover>` (which is what Radix
`Popover` already is — no value-add) or a leaky generic that
constrains each surface. The audit's "shared `AddFilterPopover`"
call is satisfied by every surface already composing the same
Radix `Popover` + `Button` primitives. No new component created.

**8. Icon-only buttons without `Tooltip` on three high-traffic surfaces.**
`GraphView.tsx:249-272` (zoom controls), `PageHeader.tsx:498-507` (star), `HistoryFilterBar.tsx:118-160` (legend/clear) — all icon-only `<Button size="icon">` with `aria-label` but **zero** `Tooltip` wraps. UX.md:765 lists tooltips as mandatory on icon-only buttons.
**Fix:** build an `IconButton` primitive in `ui/` that requires a `tooltip` prop; refactor the three call sites. `BlockGutterControls.GutterButton:59-80` shows the right pattern.

**9. `DonePanel` returns `null` for empty state.**
`DonePanel.tsx:188`: `if (!loading && blocks.length === 0) return null` — direct violation of the "never `return null` for empty" rule in AGENTS.md. Same anti-pattern in `LinkedReferences.tsx:288` and `UnlinkedReferences.tsx:337`.
**Fix:** render `<EmptyState compact icon={CheckCircle2} message={t('donePanel.noneYet')} />`, or hoist the visibility decision to the parent.

**10. Loading-state wrapper inconsistent.**
6 / 9 list views set `aria-busy` only; 3 / 9 also set `role="status"`. `StatusPanel.tsx:179-186` skips both AND uses 4 raw `<Skeleton>` divs instead of the shared `LoadingSkeleton`.
**Fix:** push the wrapper into `LoadingSkeleton` itself — accept `loading?: boolean` and emit `<div aria-busy role="status">…</div>`. Migrate `StatusPanel` and the three other inconsistent sites.

**11. `ConfirmDialog` and `ConfirmDestructiveAction` are non-overlapping cousins.** *(closed —
2026-05-14)*
The two cousins were merged into a single `ConfirmDialog` API that accepts
either i18n keys (`titleKey` / `descriptionKey` / `confirmKey` / `cancelKey`

+ optional `values`) or pre-resolved strings (`title` / `description` /
`actionLabel` / `cancelLabel`), with explicit-string overrides taking
precedence. `onConfirm` is async-aware — Promise rejections keep the
dialog open + swallow the error so the caller's toast path runs without
a closed-then-reopen flicker; sync handlers close immediately as before.
`variant` ('default' | 'destructive') styles the confirm button and (when
destructive) flips initial focus to Cancel for UX-259 reflex-Enter safety;
the legacy `actionVariant` and `onAction` aliases remain for backwards
compat. A new `secondaryAction` prop renders a third button between
Cancel and Confirm — the Google Calendar disconnect dialog
(`GoogleCalendarSettingsTab.tsx`) migrated to this shape (Cancel + Keep
Calendar [outline] + Delete Calendar [destructive]). `PairingDialog`'s
close-guard migrated from `ConfirmDestructiveAction` to the unified
`ConfirmDialog` with `variant="destructive"` + i18n keys.
`ConfirmDestructiveAction.tsx` + its test file deleted.

---

## Tier 2 — Doc/code drift (cheap, high-leverage)

These cost almost nothing to fix and reduce future agent confusion.

| ID | Where | Drift |
| --- | --- | --- |
| **D1** | UX.md:110 vs `index.css:206-210` | Doc lists `task-todo` token; CSS only has `task-done/doing/cancelled/custom`. Newcomer reaching for `bg-task-todo` will silently fail. |
| **D2** | UX.md:148 vs `index.css:847-853` | Doc says "md breakpoint" for responsive headings; CSS uses `max-width:640px` (sm). |
| **D3** | UX.md:211 vs `index.css:881` | Doc says ProseMirror `px-3 py-1.5`; actual is `px-3 py-1`. |
| **D4** | UX.md:194-195 vs `index.css:841-845` | UX.md documents 24 px desktop / 16 px touch indent; CSS has a third tier — `12px` at `≤640px viewport`. |
| **D5** | UX.md:1485 vs `AppSidebar.tsx:52-67` | Doc cites `emerald-500/amber-500/slate-400` for sync states; code already uses semantic tokens (`bg-sync-idle`, `bg-status-pending`, `bg-destructive`, etc.). Doc misleads new contributors into thinking hardcoded Tailwind is the rule. |
| **D6** | UX.md:554 vs `announcer.ts:50-55` | Doc says "double-RAF pattern"; implementation is single RAF. Older NVDA / iOS VoiceOver may miss the announcement. Pick one and align. |
| **D7** | AGENTS.md:135/142 vs `ui/` listing | Inventory names ~14 primitives; directory has 37. Undocumented primitives get reinvented. Same for `src/components/` — UX.md shared inventory lists 16 of 144 files. |
| **D8** | UX.md:821 | `ListViewState` is labeled "(pattern)" but is a real exported component (`ListViewState.tsx:35`). |
| **D9** | UX.md:264 | Touch table claims `Priority badge: min-h-[44px]/min-w-[44px]`; `priority-badge.tsx`, `status-badge.tsx`, `badge.tsx` have no `[@media(pointer:coarse)]` rules. |
| **D10** | UX.md:248-252 vs `button.tsx:23-29` | Touch table says `xs/sm/icon-xs/icon-sm` reach `h-10`/`size-10`; code reaches `h-11`/`size-11` (more accessible — fix the doc). |

**Fix:** one PR per doc, one paragraph per drift item. The `task-todo`, sync-indicators, and inventory drifts are the highest-impact misleading rows.

---

## Tier 3 — Smaller hygiene items

+ **Toggle group ad-hoc focus ring.** `ui/toggle-group.tsx:53` uses `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`; standard `focus-ring-visible` utility exists at `index.css:1228`. Replace.
+ **Legacy `outline-none` (Tailwind v3 spelling).** `select.tsx:163`, `popover.tsx:36`. Should be `outline-hidden` (used everywhere else).
+ **Sheet animation duration drift.** `sheet.tsx:67` uses `duration-slow`/`duration-slower`; `dialog.tsx:60` and `alert-dialog.tsx:55` use `duration-moderate`. Sheet feels visibly draggier than Dialog.
+ **`data-slot` missing on 7 / 37 primitives** (`alert-list-item`, `chevron-toggle`, `close-button`, `filter-pill`, `menu-popover-content`, `status-badge`, `status-icon`). One-line additions.
+ **`SHARED_INPUT_CLASSES` not reused** by `SelectTrigger` (`select.tsx:36`) or `search-input` clear button (`search-input.tsx:95`) — quiet drift risk.
+ **Three inconsistent `ring-offset` values** (`HistoryListItem:271` `ring-offset-1`, `TagList:277` and `SpaceManageDialog:174-177` `ring-offset-2`). The canonical `focus-ring-visible` uses none. `--color-ring-offset` isn't a defined token, so dark mode gets a white halo.
+ **Hardcoded `#fff` and 8 raw hex tag presets in TagList/tag-colors.** `TagList.tsx:234` forces white text on user-picked tag colors; light tag colors fail contrast.
+ **Dead tokens in `index.css:260-266`.** `--leading-relaxed`, `--tracking-tight/normal/wide` defined, never referenced, not bridged in `@theme inline`. New code uses `tracking-wider` (which has no token at all). Either bridge them or delete them.
+ **`prefers-contrast: more` block (`index.css:1119-1203`) skips many token families** — `--ring`, `--alert-*`, `--op-*`, `--date-*`, `--conflict-*`, `--task-*`, `--block-ref`, `--highlight`, `--sync-*`. Extend the high-contrast overrides to cover them.
+ **Hardcoded English fallbacks** `(empty)` in `ResultCard.tsx:74` and `BlockListItem.tsx:34,69`; `defaultValue: 'Projected'` in `DuePanel.tsx:336`; `defaultValue: 'P${v}'` in `GraphFilterBar.tsx:300,302`. Add the missing i18n keys, drop the fallbacks.
+ ~~**Three thin renaming wrappers** around `useListMultiSelect`~~ — closed. `useConflictSelection.ts` was already gone (PEND-09 Phase 5 deleted the entire conflict feature); `useTrashMultiSelect.ts` deleted Session 712 (TrashView now calls `useListMultiSelect` directly). `useHistorySelection.ts` kept as it has real logic.
+ **Component decomposition backlog.** ~13 files exceed AGENTS.md's 500-LOC threshold; worst: `BlockTree.tsx` (790), ~~`RichContentRenderer.tsx` (659)~~ — RichContentRenderer split Session 716 (per-mark renderers extracted to `src/components/RichContentRenderer/marks/*.tsx`; main file now 53 LOC dispatcher; public API unchanged). ~~`sidebar.tsx` (1078, 22 sub-components) is fat-but-cohesive — splitting `useSidebarState` and edge-swipe/keyboard handlers out is the cheapest win.~~ — sidebar split Session 717: dropped 1078 → 865 LOC after extracting `useSidebarState`, `useSidebarKeyboard`, `useSidebarEdgeSwipe`, and `useSidebarRailDrag` into `src/components/ui/sidebar/*.ts`; public API (22 sub-components + `useSidebar` context) unchanged; hooks each have a sibling test file. (ConflictList.tsx no longer applicable — deleted by PEND-09 Phase 5.)
+ ~~**`FeatureErrorBoundary` only wraps top-level views** (`ViewDispatcher.tsx`, `AppSidebar.tsx`). Heavy in-view sections — `CompactionCard`, `LinkedReferences`, `UnlinkedReferences`, `PagePropertyTable`, `GraphFilterBar` — would benefit from their own boundary so a section crash doesn't blank the page.~~ — closed. Each of the five sections is now wrapped in its own `FeatureErrorBoundary` at the call site: `LinkedReferences` + `UnlinkedReferences` in `PageEditor.tsx`, `GraphFilterBar` in `GraphView.tsx`, `PagePropertyTable` in `PageHeader.tsx`, `CompactionCard` in `HistoryView.tsx`. Per-section fallback i18n keys added (`linkedReferences.errorBoundary`, `unlinkedReferences.errorBoundary`, `graph.filterBar.errorBoundary` in `references.ts`; `pageProperty.tableErrorBoundary` in `pages.ts`; `compactionCard.errorBoundary` in `history.ts`). The boundary primitive itself was left untouched — its existing `name` prop drives the visible "{{section}} encountered an error" message and the retry / report-bug actions.
+ **List rendering primitive zoo.** 7 distinct row primitives across list views; `TemplatesView.tsx:186-239` and `DuePanel.tsx:343-389` (projected entries) write raw `<li>` and bypass the design system entirely.

---

## Verified-clean (positive findings — keep doing this)

+ **`forwardRef`-free `ui/`.** Zero `forwardRef` in `src/components/ui/` — full React 19 ref-as-prop adoption.
+ **`Loader2` consolidation.** Only one `Loader2.*animate-spin` hit in the entire repo, in a test comment. `Spinner` is the only path.
+ **`overflow-*` discipline.** 26 grep hits in `src/components`; only two production sites (`dialog.tsx:60`, `alert-dialog.tsx:55`), both intentional dialog-body scroll.
+ **Token system is broad and themed.** Five fully themed palettes (light, dark, solarized-light, solarized-dark, dracula, one-dark-pro). No raw color literals leaking outside theme blocks except two decorative `drop-shadow` calls in space accent pickers.

---

## Hallucinations / inflated claims (caught in round 2)

These were softened or reversed by the verifiers — be skeptical if you see them resurface:

1. **"AgendaResults returns `null` for empty state"** (round 1, slice 4). False. `AgendaResults.tsx:195` is `return null` inside a `useMemo`. Empty state is rendered via `<EmptyState>` at lines 250-269.
2. **"`KeyboardSettingsTab` has 3 component-level `return null` exits"** (round 1, slice 4). Misleading. All three are inside helper functions / memos (`validateShortcutBinding`, `validationError` memo, `getConflictsForId` helper) — `null` is a valid signal value, not an empty-state bail.
3. **"30 `return null` callsites"** (round 1, slice 3). Actual count is 54; most are legitimate guard clauses. The anti-pattern only meaningfully applies to `DonePanel:188`, `RecentPagesStrip:183-184`, `LinkedReferences:288`, `UnlinkedReferences:337`.
4. **"25 inline `style={{...}}`"** (round 1, slice 3). Actual is 27. Substance holds — most are dynamic values (depth padding, virtualizer height) and legitimate; only ~5 in `BlockPropertyEditor` and `FormattingToolbar` are literal-only and convertible.
5. **"TemplatesView remove button hover-only opacity is risky"** (round 1, slice 4). Verifier found the classes only force `opacity-100` on coarse pointer / focus-visible — there's no `opacity-0` group-hover trigger to begin with. Discoverability claim isn't evidenced by the code.
6. **"`priority-badge.tsx:25-29`"** (round 1, slice 2). Substance correct (no coarse-pointer rule), but the cited line range is the size-variant block (21-29). Cite the file, not the range.

---

## Recommended sequencing

1. **Doc PR** (1 commit, ~50 lines). Fix D1-D10 above. Cheap, eliminates the recurring "agent reads UX.md, code disagrees" loop.
2. **Button `active:` states + Select iOS-zoom guard + autoscroll reduced-motion.** One PR, three primitives. Ships measurable UX wins.
3. **Badge family consolidation + IconButton primitive.** Two PRs. Pays off for years.
4. **Page-header + settings-tab + filter UI standardization.** Three PRs over a few sessions; biggest cross-screen consistency win.
5. **`ConfirmDialog` merge** + `LoadingSkeleton` wrapper-baking + empty-state cleanups (DonePanel, LinkedRefs).
6. Hygiene items individually as touched.
