# Agaric Design System — UX Review

> **Status:** Tier 1 + Tier 3 hygiene mostly shipped. **Tier 1 closed:**
> item 1 (Button `active:` states across all 6 variants + size-dependent
> scale), item 2 (iOS auto-zoom on `<Select>`), item 3
> (`useAutoScrollOnDrag` reduced-motion), item 9 (3 `return null`
> empty-state guards → `<EmptyState compact>` in DonePanel +
> LinkedReferences + UnlinkedReferences), item 10 (LoadingSkeleton
> accepts `loading` prop with `role="status" aria-busy`; StatusPanel +
> PageBrowser + TagList + JournalPage migrated).
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
> **Still open:** Tier 1 items 1, 4–11 + every Tier 2 entry +
> component-decomposition backlog + FeatureErrorBoundary in-view
> sections + list rendering primitive zoo.

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

**4. Six badge-shaped primitives with fuzzy boundaries.**
`badge.tsx`, `status-badge.tsx`, `priority-badge.tsx`, `filter-pill.tsx`, `recent-page-chip.tsx`, `alert-list-item.tsx`. Only `Badge` is in the AGENTS.md inventory; `StatusBadge` uses `rounded` instead of `rounded-full` and lacks `data-slot`. The family fragments without clear ownership.
**Fix:** promote `Badge` to a base with `tone`/`size`/`interactive` variants; collapse `StatusBadge` and `PriorityBadge` into it. Keep `FilterPill` and `RecentPageChip` (they're buttons-shaped-as-badges, different a11y contract). Rename `alert-list-item.tsx` → `alert-list-row.tsx` to break the badge-naming collision.

**5. Page-header chrome is non-existent — every top-level view rolls its own.**
`ViewHeader` is used by 5 views (`PageBrowser`, `HistoryView`, `SearchPanel`, `journal/AgendaView`, `PageHeader`). Six others ignore it: `JournalPage`, `TrashView`, `SettingsView`, `StatusPanel`, `GraphView`, `TemplatesView`. No shared title/breadcrumb/actions abstraction. (ConflictList was deleted by PEND-09 Phase 5.)
**Fix:** introduce a `FeaturePageHeader` primitive `{title, breadcrumb?, actions?, kebab?}` and wrap every top-level view; codify in AGENTS.md.

**6. Settings tabs each invent their own heading style.**
`AgentAccessSettingsTab.tsx:264` and `GoogleCalendarSettingsTab.tsx:404` use `<h2 text-base font-medium>`; `KeyboardSettingsTab.tsx:139` uses `<h3 text-lg font-semibold>`; `DataSettingsTab.tsx:166-296` uses `Card`/`CardHeader`/`CardTitle`; `settings/HelpTab.tsx:23` uses `<h3 text-sm font-medium>`. Five tabs, four styles, two heading levels.
**Fix:** standardize on the `Card` pattern (DataSettingsTab) and rewrite the four others.

**7. Filter UI fragmented across multiple surfaces.**
Only `BacklinkFilterBuilder` and `GraphFilterBar` use the shared `FilterPill` / `FilterPillRow`. `HistoryFilterBar`, `DuePanelFilters`, `SearchPanel` chip bar, `AgendaFilterBuilder` all roll their own. Users moving between Search / Agenda / History see different filter UX every time. (ConflictList was deleted by PEND-09 Phase 5.)
**Fix:** standardize on `FilterPill` + `FilterPillRow` + a shared `AddFilterPopover`; migrate the divergent ones in priority order.

**8. Icon-only buttons without `Tooltip` on three high-traffic surfaces.**
`GraphView.tsx:249-272` (zoom controls), `PageHeader.tsx:498-507` (star), `HistoryFilterBar.tsx:118-160` (legend/clear) — all icon-only `<Button size="icon">` with `aria-label` but **zero** `Tooltip` wraps. UX.md:765 lists tooltips as mandatory on icon-only buttons.
**Fix:** build an `IconButton` primitive in `ui/` that requires a `tooltip` prop; refactor the three call sites. `BlockGutterControls.GutterButton:59-80` shows the right pattern.

**9. `DonePanel` returns `null` for empty state.**
`DonePanel.tsx:188`: `if (!loading && blocks.length === 0) return null` — direct violation of the "never `return null` for empty" rule in AGENTS.md. Same anti-pattern in `LinkedReferences.tsx:288` and `UnlinkedReferences.tsx:337`.
**Fix:** render `<EmptyState compact icon={CheckCircle2} message={t('donePanel.noneYet')} />`, or hoist the visibility decision to the parent.

**10. Loading-state wrapper inconsistent.**
6 / 9 list views set `aria-busy` only; 3 / 9 also set `role="status"`. `StatusPanel.tsx:179-186` skips both AND uses 4 raw `<Skeleton>` divs instead of the shared `LoadingSkeleton`.
**Fix:** push the wrapper into `LoadingSkeleton` itself — accept `loading?: boolean` and emit `<div aria-busy role="status">…</div>`. Migrate `StatusPanel` and the three other inconsistent sites.

**11. `ConfirmDialog` and `ConfirmDestructiveAction` are non-overlapping cousins.**
`ConfirmDialog.tsx` takes pre-resolved strings, supports a mobile Sheet, sync `onAction`, optional `actionVariant`. `ConfirmDestructiveAction.tsx` takes i18n keys, is always-destructive, async-aware, no Sheet. Neither is a superset; `GoogleCalendarSettingsTab.tsx:563-589` already escapes both with raw `AlertDialog` primitives (and an unsupported dual-`AlertDialogAction` footer).
**Fix:** merge into one `ConfirmDialog` API: `{titleKey, descriptionKey, confirmKey, variant, onConfirm: () => Promise<void>}` with Sheet-on-mobile rendering. Add a multi-action variant to absorb the GoogleCal case.

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

- **Toggle group ad-hoc focus ring.** `ui/toggle-group.tsx:53` uses `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`; standard `focus-ring-visible` utility exists at `index.css:1228`. Replace.
- **Legacy `outline-none` (Tailwind v3 spelling).** `select.tsx:163`, `popover.tsx:36`. Should be `outline-hidden` (used everywhere else).
- **Sheet animation duration drift.** `sheet.tsx:67` uses `duration-slow`/`duration-slower`; `dialog.tsx:60` and `alert-dialog.tsx:55` use `duration-moderate`. Sheet feels visibly draggier than Dialog.
- **`data-slot` missing on 7 / 37 primitives** (`alert-list-item`, `chevron-toggle`, `close-button`, `filter-pill`, `menu-popover-content`, `status-badge`, `status-icon`). One-line additions.
- **`SHARED_INPUT_CLASSES` not reused** by `SelectTrigger` (`select.tsx:36`) or `search-input` clear button (`search-input.tsx:95`) — quiet drift risk.
- **Three inconsistent `ring-offset` values** (`HistoryListItem:271` `ring-offset-1`, `TagList:277` and `SpaceManageDialog:174-177` `ring-offset-2`). The canonical `focus-ring-visible` uses none. `--color-ring-offset` isn't a defined token, so dark mode gets a white halo.
- **Hardcoded `#fff` and 8 raw hex tag presets in TagList/tag-colors.** `TagList.tsx:234` forces white text on user-picked tag colors; light tag colors fail contrast.
- **Dead tokens in `index.css:260-266`.** `--leading-relaxed`, `--tracking-tight/normal/wide` defined, never referenced, not bridged in `@theme inline`. New code uses `tracking-wider` (which has no token at all). Either bridge them or delete them.
- **`prefers-contrast: more` block (`index.css:1119-1203`) skips many token families** — `--ring`, `--alert-*`, `--op-*`, `--date-*`, `--conflict-*`, `--task-*`, `--block-ref`, `--highlight`, `--sync-*`. Extend the high-contrast overrides to cover them.
- **Hardcoded English fallbacks** `(empty)` in `ResultCard.tsx:74` and `BlockListItem.tsx:34,69`; `defaultValue: 'Projected'` in `DuePanel.tsx:336`; `defaultValue: 'P${v}'` in `GraphFilterBar.tsx:300,302`. Add the missing i18n keys, drop the fallbacks.
- ~~**Three thin renaming wrappers** around `useListMultiSelect`~~ — closed. `useConflictSelection.ts` was already gone (PEND-09 Phase 5 deleted the entire conflict feature); `useTrashMultiSelect.ts` deleted Session 712 (TrashView now calls `useListMultiSelect` directly). `useHistorySelection.ts` kept as it has real logic.
- **Component decomposition backlog.** ~13 files exceed AGENTS.md's 500-LOC threshold; worst: `BlockTree.tsx` (790), `RichContentRenderer.tsx` (659). `sidebar.tsx` (1078, 22 sub-components) is fat-but-cohesive — splitting `useSidebarState` and edge-swipe/keyboard handlers out is the cheapest win. (ConflictList.tsx no longer applicable — deleted by PEND-09 Phase 5.)
- **`FeatureErrorBoundary` only wraps top-level views** (`ViewDispatcher.tsx`, `AppSidebar.tsx`). Heavy in-view sections — `CompactionCard`, `LinkedReferences`, `UnlinkedReferences`, `PagePropertyTable`, `GraphFilterBar` — would benefit from their own boundary so a section crash doesn't blank the page.
- **List rendering primitive zoo.** 7 distinct row primitives across list views; `TemplatesView.tsx:186-239` and `DuePanel.tsx:343-389` (projected entries) write raw `<li>` and bypass the design system entirely.

---

## Verified-clean (positive findings — keep doing this)

- **`forwardRef`-free `ui/`.** Zero `forwardRef` in `src/components/ui/` — full React 19 ref-as-prop adoption.
- **`Loader2` consolidation.** Only one `Loader2.*animate-spin` hit in the entire repo, in a test comment. `Spinner` is the only path.
- **`overflow-*` discipline.** 26 grep hits in `src/components`; only two production sites (`dialog.tsx:60`, `alert-dialog.tsx:55`), both intentional dialog-body scroll.
- **Token system is broad and themed.** Five fully themed palettes (light, dark, solarized-light, solarized-dark, dracula, one-dark-pro). No raw color literals leaking outside theme blocks except two decorative `drop-shadow` calls in space accent pickers.

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
