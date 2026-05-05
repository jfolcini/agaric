# PEND-28 — UX responsiveness review (2026-05-04): mobile / tablet findings

## TL;DR

Two-pass UX responsiveness review of the frontend, scoped specifically to **phone (360–414 px) and tablet (768–1024 px) usability**. Pass 1: six parallel investigation subagents partitioned by zone (layout shell / journal+agenda / editor+block-tree / dialogs+popovers+settings / search+graph+history+trash+conflicts / UI primitives+shared). Pass 2: six parallel skeptical-validator subagents re-opened every cited file:line, quoted what was actually there, and verdicted each claim as **CONFIRMED / PARTIAL / FALSE / ALREADY HANDLED**.

The frontend has solid responsive foundations: every Radix primitive in `ui/` carries a sensible mobile baseline (`max-w-[calc(100vw-2rem)]` on popovers, `max-w-[calc(100%-2rem)] sm:max-w-lg` on dialogs, `[@media(pointer:coarse)]:h-11` baked into `button.tsx` size variants, body-level `safe-area-inset-*` padding, `--indent-width` responsive at `pointer: coarse`, 640 px typography breakpoint, dedicated `touch-target` utility). What survived validation is a focused list of **per-component overrides that defeat the baseline**, **missing `max-height` on the dialog/popover primitives**, and **a handful of editor-portal floating-UI surfaces that bypass Radix entirely** so the baseline doesn't apply.

After validation, **~22 raw findings were dropped as false positives** (full list in [§ Hallucinations dropped](#hallucinations-dropped)). The most common Round-1 failure modes:

- **Missing the primitive baseline** — flagging "fixed-width popover `w-56`" / "no `max-w` constraint" without checking that `ui/popover.tsx` already adds `max-w-[calc(100vw-2rem)]` to every `PopoverContent`.
- **Missing the touch-coarse baseline in `button.tsx`** — flagging `size="sm"` / `size="xs"` consumers as "no touch override" when the variant itself includes `[@media(pointer:coarse)]:h-11`.
- **Misreading `max-w-md` etc. as fixed widths** — `max-w` is a cap; content reflows below it.
- **Confusing flex-positioned siblings as overlapping** — graph filter bar (top-left) vs truncation badge (bottom-left).
- **Speculation on truncated reads** — claims about files the reviewer didn't fully read.
- **Reversing convention** — calling MonthlyDayCell's larger desktop / smaller-cell + larger-circle touch design "backwards".

What remains: **6 HIGH, 7 MEDIUM, 1 LOW** confirmed findings across **14 files**. None are critical bugs; the app is usable on phones today. They're per-site fixes with no API shape changes, no schema migrations, no architectural shifts.

Cost: **S–M** if cherry-picked individually (most are 1-line className changes); **L** if all done in one sweep + the two primitive-level fixes. Risk: **low** across the board. Impact: **medium** for phone usability and design-system consistency.

> **These are findings, not commitments.** Each item is independently approve-able. The single highest-leverage win is **H1+H2** (add `max-h` to the dialog/popover primitives) — two lines that propagate through every dialog and popover in the app.
>
> **Status (sessions 667 + 668):** all 6 HIGH closed (H1-H6) + 11 MEDIUM closed (M1-M5, M7-M8, M10-M13). **Remaining: 2 MEDIUM (M6 narrow-desktop indent breakpoint, M9 HistoryFilterBar mobile stack), 1 LOW (L1 AlertSection truncate).** PEND-28b is nearly done.

## Methodology

For each surviving finding the validator subagent did the following:

1. Re-opened the cited file(s) at the cited lines with surrounding context.
2. Quoted the actual className / classes observed (with the actual line number, since Round-1 line numbers were sometimes ±5).
3. Cross-checked against the relevant primitive (`ui/button.tsx`, `ui/popover.tsx`, `ui/dialog.tsx`, `ui/sheet.tsx`, `ui/select.tsx`) to verify the baseline already in effect.
4. Verdicted as `CONFIRMED` / `PARTIAL` / `FALSE` / `ALREADY HANDLED`.
5. For `PARTIAL`: flagged what mitigated it (so severity could be downgraded honestly).

Severity floor for inclusion in this file:

- **HIGH**: real responsiveness bug visible on a 360–414 px phone today, with a small mechanical fix.
- **MEDIUM**: real but mitigated, niche viewport, or moderate fix; worth doing in a sweep.
- **LOW**: real overflow / misalignment risk that's worth noting but not a nit. Pure nits (e.g. `right-1` could be `right-2`) are tracked in [§ Out of scope](#out-of-scope), not here.

## Summary

| ID  | Severity | Category        | Location                                                                                                    | Cost     | Risk |
|-----|----------|-----------------|-------------------------------------------------------------------------------------------------------------|----------|------|
| H1  | HIGH     | primitive       | `src/components/ui/dialog.tsx:60` + `ui/alert-dialog.tsx:55` (no `max-h` on Content)                        | trivial  | low  |
| H2  | HIGH     | primitive       | `src/components/ui/popover.tsx:36` (no `max-h` on PopoverContent)                                           | trivial  | low  |
| H3  | HIGH     | drawer          | `src/components/BlockPropertyDrawer.tsx:245` (`w-80` overrides Sheet baseline)                              | trivial  | low  |
| H4  | HIGH     | editor portal   | `src/components/BlockPropertyEditor.tsx:213-249` (custom floating-UI portal, no viewport cap)               | trivial  | low  |
| H5  | HIGH     | editor portal   | `src/components/FormattingToolbar.tsx:288–360` (3 `data-editor-portal` surfaces)                            | trivial  | low  |
| H6  | HIGH     | touch target    | `src/components/backlink-filter/AddFilterRow.tsx:273,284` (custom `h-7` defeats `size="xs"` touch override) | trivial  | low  |
| M1  | MEDIUM   | dialog body     | `src/components/BugReportDialog.tsx:328,519` (long form + nested log preview, no body scroll)               | S (1h)   | low  |
| M2  | MEDIUM   | touch target    | `src/components/DuePanelFilters.tsx:102` (toggle has `min-h-[44px]` but missing `min-w-[44px]`)             | trivial  | low  |
| M3  | MEDIUM   | touch typography| `src/components/AgendaResults.tsx:269` (priority badge keeps `text-xs` on touch while date chip scales)     | trivial  | low  |
| M4  | MEDIUM   | touch typography| `src/components/AgendaSortGroupControls.tsx:52-54` (44 px buttons keep `text-xs`)                           | trivial  | low  |
| M5  | MEDIUM   | input width     | `src/components/PageAliasSection.tsx:60` (`w-24` on narrow desktop)                                         | trivial  | low  |
| M6  | MEDIUM   | indent          | `src/index.css:798-806` + `src/components/SortableBlock.tsx:311` (no viewport-width breakpoint)             | trivial  | low  |
| M7  | MEDIUM   | wrap            | `src/components/DiffDisplay.tsx:148-166` (hunk-nav row missing `flex-wrap`)                                 | trivial  | low  |
| M8  | MEDIUM   | wrap            | `src/components/journal/DaySection.tsx:66-131` (heading row no `flex-wrap`)                                 | trivial  | low  |
| M9  | MEDIUM   | wrap            | `src/components/HistoryFilterBar.tsx:88-186` (full row no `flex-col` on mobile)                             | S (1h)   | low  |
| M10 | MEDIUM   | viewport unit   | `src/components/KeyboardSettingsTab.tsx:143` (`60vh` not `60dvh`)                                           | trivial  | low  |
| M11 | MEDIUM   | input width     | `src/components/JournalControls.tsx:162` (`min-w-[100px]` reserves 28 % of phone width)                     | trivial  | low  |
| M12 | MEDIUM   | drawer          | `src/components/HistorySheet.tsx:28` (`w-3/4 sm:w-80` is 270 px on phones)                                  | trivial  | low  |
| M13 | MEDIUM   | touch target    | `src/components/QueryResultTable.tsx:60-79` (header sort buttons ~28 px tall, no `touch-target`)            | trivial  | low  |
| L1  | LOW      | overflow        | `src/components/AlertSection.tsx:108-118` (date span has `shrink-0` but no `truncate`)                      | trivial  | low  |

---

## HIGH — fix soon

### ~~H1 — `dialog.tsx` and `alert-dialog.tsx` primitives have no `max-height`~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/ui/dialog.tsx" lines="60-60" />
<ref_snippet file="/home/javier/dev/agaric/src/components/ui/alert-dialog.tsx" lines="55-55" />

Both base components apply `max-w-[calc(100%-2rem)] sm:max-w-lg` (correct horizontal) but **no vertical constraint**. Every dialog in the app inherits this gap. Tall forms (BugReport, SpaceManage, settings sub-dialogs, Pairing) can exceed the viewport with no scrolling on phones in landscape and on short laptop screens. Several individual dialogs (`SpaceManageDialog`, `PairingDialog`, `BugReportDialog`'s log preview) work around this by adding their own `<ScrollArea max-h-[…]>` inside; everything else doesn't.

**Fix:** add `max-h-[calc(100dvh-2rem)] overflow-y-auto` to the base content classNames in both files. One-liner, propagates everywhere. Risk is essentially zero — content that already fit unconstrained will still fit; content that overflowed now scrolls.

Cost: trivial (~2 LOC across two files). Risk: low.

### ~~H2 — `popover.tsx` primitive has no `max-height`~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/ui/popover.tsx" lines="36-36" />

`w-72 max-w-[calc(100vw-2rem)]` correctly handles horizontal overflow but doesn't cap vertical height. `SearchablePopover` (`max-h-48`) and a couple of editor portals add their own caps; everything else can grow off-screen on phones with long content (e.g. a long property-key list, a long tag list).

**Fix:** add `max-h-[calc(100dvh-4rem)]` to the base. Long popover bodies should be wrapped in `<ScrollArea>` at the call site (as `SearchablePopover` already does); the primitive cap is the safety net.

Cost: trivial (~1 LOC). Risk: low.

### ~~H3 — `BlockPropertyDrawer` overrides the responsive Sheet baseline~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/BlockPropertyDrawer.tsx" lines="245-245" />

`SheetContent side="right" className="w-80"` overrides `ui/sheet.tsx`'s baseline `w-3/4 sm:max-w-sm`. On a 360 px phone the drawer is 320 px wide and pushes the content area to 40 px — effectively unusable. Other sheets in the app (`BlockGutterControls`, `HistorySheet`) already use the correct `w-3/4 sm:w-80` pattern that was clearly intended here.

**Fix:** `className="w-3/4 sm:w-80"`. Aligns with sibling sheets.

Cost: trivial (~1 LOC). Risk: low.

### ~~H4 — `BlockPropertyEditor` ref-picker portal lacks viewport constraint~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/BlockPropertyEditor.tsx" lines="213-249" />

This is **not** a Radix `PopoverContent` — it's a custom floating-UI portal (`data-editor-portal`) rendered with `position: fixed`. The Radix primitive's `max-w-[calc(100vw-2rem)]` baseline does **not** apply. The fieldset is hard-coded `w-56` (224 px) and can clip near the right edge on a 360 px phone.

**Fix:** add `max-w-[calc(100vw-2rem)]` to the portal element's className (the outer `<div>` at `~L213`, not the inner fieldset). Mirrors how the Radix-based popovers in `PropertyRowEditor`, `AddPropertyPopover`, `PageTagSection`, and `PageHeaderMenu` already declare it explicitly.

Cost: trivial (~1 LOC). Risk: low.

### ~~H5 — `FormattingToolbar` editor portals lack viewport constraint (3 sites)~~ ✅ done session 667 (subagent verified plan's "not Radix popovers" premise was wrong — they ARE Radix and inherit the baseline; explicit declaration kept as defense-in-depth)

<ref_snippet file="/home/javier/dev/agaric/src/components/FormattingToolbar.tsx" lines="280-365" />

Same root cause as H4. `~L288` (link popover, `w-72`), `~L329` (code-block popover, `w-auto`), `~L360` (heading popover, `w-auto`) are all `data-editor-portal` floating-UI surfaces, not Radix popovers. The 288 px link popover sits awkwardly near edges on phones.

**Fix:** add `max-w-[calc(100vw-2rem)]` to each. Three near-identical edits in one file.

Cost: trivial (~3 LOC). Risk: low.

### ~~H6 — `BacklinkFilterBuilder`/`AddFilterRow` Apply / Cancel buttons are 28 px on touch~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/backlink-filter/AddFilterRow.tsx" lines="265-290" />

`size="xs"` already provides `[@media(pointer:coarse)]:h-11` from `button.tsx`, but the row's custom `h-7` className **overrides** the touch-coarse height. The custom `[@media(pointer:coarse)]:w-full` only sets width, not height. So on phones the buttons stay 28 px tall — well below the 44 px AGENTS.md floor — even though they look like they should expand.

**Fix:** add `[@media(pointer:coarse)]:h-11` to both buttons' classNames so the touch-coarse height re-asserts.

```diff
- className="h-7 text-xs [@media(pointer:coarse)]:w-full"
+ className="h-7 text-xs [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-full"
```

Cost: trivial (~2 LOC). Risk: low.

---

## MEDIUM — fix in a sweep

### ~~M1 — `BugReportDialog` form body and log preview escape the dialog frame~~ ✅ done session 668

<ref_snippet file="/home/javier/dev/agaric/src/components/BugReportDialog.tsx" lines="320-340" />
<ref_snippet file="/home/javier/dev/agaric/src/components/BugReportDialog.tsx" lines="515-560" />

Outer dialog (`L328`) and nested log-preview dialog (`~L519`) both use `max-w-2xl` with no `max-h`. The inner log-preview has its own `<ScrollArea max-h-96>` at `~L552`, but the dialog frame still escapes; and the outer form body is unscrolled. H1 fixes most of this by inheritance, but the file should also wrap its form fields + log list in a `<ScrollArea>` (or a `flex flex-col` + scroll body pattern) so the title and submit buttons stay visible while the body scrolls. PairingDialog L452 has the canonical example of this pattern.

Cost: S (~1 h, ~10–15 LOC). Risk: low. Already covered partially by H1.

### ~~M2 — `DuePanelFilters` "Hide before scheduled" toggle missing `min-w` on touch~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/DuePanelFilters.tsx" lines="75-110" />

The filter pills at `~L80` correctly carry both `[@media(pointer:coarse)]:min-h-[44px]` and `[@media(pointer:coarse)]:min-w-[44px]`. The toggle button at `~L102` only has `min-h-[44px]`. They sit on the same row; the asymmetry is visible.

**Fix:** add `[@media(pointer:coarse)]:min-w-[44px]` to the toggle.

Cost: trivial (~1 LOC). Risk: low.

### ~~M3 — `AgendaResults` priority badge text doesn't scale on touch~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/AgendaResults.tsx" lines="90-100" />
<ref_snippet file="/home/javier/dev/agaric/src/components/AgendaResults.tsx" lines="265-275" />

The due-date chip (`~L96`) has `[@media(pointer:coarse)]:text-sm`. The priority badge sitting next to it (`~L269`) keeps `text-xs` even though its padding grows. Visible inconsistency on every agenda row.

**Fix:** add `[@media(pointer:coarse)]:text-sm` to the priority badge className.

Cost: trivial (~1 LOC). Risk: low.

### ~~M4 — `AgendaSortGroupControls` 44 px buttons keep tiny text~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/AgendaSortGroupControls.tsx" lines="48-58" />

Buttons grow to 44 × 44 px on touch (correct), but the label stays `text-xs`. Visually unbalanced and harder to read at the new size.

**Fix:** add `[@media(pointer:coarse)]:text-sm` to the button className.

Cost: trivial (~1 LOC). Risk: low.

### ~~M5 — `PageAliasSection` input is 96 px on narrow desktop~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/PageAliasSection.tsx" lines="55-65" />

`w-24 [@media(pointer:coarse)]:w-full`. On a 360–500 px desktop browser (mouse pointer = `pointer: fine`) the alias input is stuck at 96 px while the row has hundreds of pixels free. Reasonable on a 1920 px desktop, cramped at viewports between phone-touch and desktop-spacious.

**Fix:** add a viewport-width breakpoint:

```diff
- className="w-24 [@media(pointer:coarse)]:w-full h-7 text-xs"
+ className="w-24 sm:w-32 [@media(pointer:coarse)]:w-full h-7 text-xs"
```

Optionally also add `flex-wrap` to the parent form so the row stacks under pressure.

Cost: trivial (~1 LOC). Risk: low.

### M6 — Block indent doesn't shrink on narrow desktop windows

<ref_snippet file="/home/javier/dev/agaric/src/index.css" lines="798-806" />
<ref_snippet file="/home/javier/dev/agaric/src/components/SortableBlock.tsx" lines="305-320" />

`--indent-width: 24 px` on desktop, `16 px` on `pointer: coarse`. A 360 px desktop responsive-mode window keeps 24 px indent, so a depth-5 block consumes 120 px before any content begins — leaving 240 px for text + inline controls + gutter. The pointer-coarse breakpoint catches phones but not narrow-desktop windows or split-screen tablets in fine-pointer mode.

**Fix:** add a viewport-width sibling rule:

```diff
  :root {
    --indent-width: 24px;
  }
  @media (pointer: coarse) {
    :root {
      --indent-width: 16px;
    }
  }
+ @media (max-width: 640px) {
+   :root {
+     --indent-width: 12px;
+   }
+ }
```

(Pointer-coarse and viewport-width queries are independent; both can apply, last-declared wins for narrow phones.)

Cost: trivial (~5 LOC). Risk: low.

### ~~M7 — `DiffDisplay` hunk-nav row doesn't wrap~~ ✅ done session 667

<ref_snippet file="/home/javier/dev/agaric/src/components/DiffDisplay.tsx" lines="145-170" />

`flex items-center gap-2` with no `flex-wrap`; the buttons themselves correctly hit 44 px on touch (`size="sm"` baseline), but on phones with long file paths or many hunks the row runs off the right edge.

**Fix:** add `flex-wrap` to the hunk-nav container.

Cost: trivial (~1 LOC). Risk: low.

### ~~M8 — `journal/DaySection` heading row has no `flex-wrap`~~ ✅ done session 668

<ref_snippet file="/home/javier/dev/agaric/src/components/journal/DaySection.tsx" lines="60-135" />

The day heading row at `~L66` uses `flex items-center gap-2` and contains the date heading, multiple count badges (Due / Scheduled / Refs), and an open-in-editor button. On a 360 px phone the row overflows. No wrap, so badges push the open button off-screen.

**Fix:** add `flex-wrap` to the heading row container.

Cost: trivial (~1 LOC). Risk: low.

### M9 — `HistoryFilterBar` row doesn't stack on phones

<ref_snippet file="/home/javier/dev/agaric/src/components/HistoryFilterBar.tsx" lines="85-190" />

`flex items-center gap-3` row with label + Select + help icon + clear + `ml-auto` "All spaces" toggle. On 360 px the toggle is pushed off-screen. The help popover (`w-80`) is mitigated by H2/`max-w-[calc(100vw-2rem)]` baseline, so that part is safe.

**Fix:** stack on phones — `flex flex-col sm:flex-row sm:items-center gap-3`. Move the `ml-auto` toggle below the row on mobile.

Cost: S (~1 h, ~5–10 LOC + a screenshot or two to confirm spacing). Risk: low.

### ~~M10 — `KeyboardSettingsTab` uses `vh` instead of `dvh`~~ ✅ done session 668

<ref_snippet file="/home/javier/dev/agaric/src/components/KeyboardSettingsTab.tsx" lines="140-150" />

`max-h-[60vh]` flickers when the mobile address bar collapses (because `vh` includes the hidden bar's height while `dvh` follows the visible viewport).

**Fix:** swap to `60dvh`.

Cost: trivial (~1 LOC). Risk: low.

### ~~M11 — `JournalControls` reserves 100 px on phones for the date readout~~ ✅ done session 668

<ref_snippet file="/home/javier/dev/agaric/src/components/JournalControls.tsx" lines="155-170" />

`min-w-[100px] sm:min-w-[140px]` is ~28 % of a 360 px viewport before the prev/next/mode controls are placed. Real-world dates are usually shorter than 100 px, so the reservation is wasted screen.

**Fix:** `min-w-[80px] sm:min-w-[140px]`, or drop the min-width on mobile entirely and let the date determine its own width.

Cost: trivial (~1 LOC). Risk: low.

### ~~M12 — `HistorySheet` is 270 px on a 360 px phone~~ ✅ done session 668

<ref_snippet file="/home/javier/dev/agaric/src/components/HistorySheet.tsx" lines="25-35" />

`w-3/4 sm:w-80` → 270 px on phones. Cramped for a list of timestamped entries with diff toggles + restore buttons. (The `ui/sheet.tsx` baseline is `w-3/4`, so this matches the primitive — but for *this* content type, full-width is more usable.)

**Fix:** `w-[85%] sm:w-80` or `w-full sm:w-80` on phones.

Cost: trivial (~1 LOC). Risk: low.

### ~~M13 — `QueryResultTable` header sort buttons are ~28 px tall~~ ✅ done session 668

<ref_snippet file="/home/javier/dev/agaric/src/components/QueryResultTable.tsx" lines="55-85" />

The custom sort header buttons use `py-1.5` (6 px vertical padding) with no explicit height class. They render at ~28 px on touch — below the 44 px floor — and they're not using `<Button size="sm">` (which would inherit the touch-coarse baseline).

**Fix:** add the `touch-target` utility class (or replace the bare `<button>` with the `<Button size="sm">` primitive).

Cost: trivial (~1 LOC). Risk: low.

---

## LOW — note for a polish pass

### L1 — `AlertSection` date span can overflow

<ref_snippet file="/home/javier/dev/agaric/src/components/AlertSection.tsx" lines="105-120" />

The content span at `~L108` correctly has `min-w-0 flex-1 truncate`. The date span at `~L111` has `shrink-0 text-xs` but no `truncate` / `max-w` cap. With long relative-date strings ("5 days overdue", localized) and a long content title, the date can still push past the right edge of a 360 px phone before the truncate on content kicks in.

**Fix:** add `truncate max-w-[6rem]` (or similar) to the date span, or wrap it in its own `min-w-0`-protected container.

Cost: trivial (~1 LOC). Risk: low.

---

## Out of scope

These were flagged by Round-1 reviewers but verified as either nits, intentional, or already correctly handled. Listed so they don't quietly resurface in a later pass.

### Pure nits (technically true, no measurable impact)

- **`ui/calendar.tsx` ~L103 week-number cell** — missing `[@media(pointer:coarse)]:size-11` like sibling cells. Week numbers are read-only annotations, rarely tapped.
- **`AgendaResults` group headers ~L333** — missing `truncate`. Labels are short ("Today", "Priority 1"); overflow not observed in practice.
- **`ui/search-input.tsx` ~L93** — clear button at `right-1` could be `right-2` on touch. Cosmetic spacing.
- **`ui/sidebar.tsx` `lg` size variant** — 48 px instead of 44 px. Above the floor, intentional for a "large" variant.
- **`PageMetadataBar.tsx` ~L61** — no explicit wrap behavior; wraps acceptably with default flex behavior.
- **`PageOutline.tsx` ~L99** — inline-style `paddingLeft: ${(level-1)*12}px` plus `truncate` works; no explicit max-w but the panel scrolls.
- **`BatchActionToolbar.tsx`** — `flex items-center gap-2` no flex-wrap; current call sites pass short labels; out-of-range labels would be a consumer bug, not a primitive bug.
- **`PageBrowser.tsx`** — fixed virtualizer row heights (36/44 px) don't accommodate text wrapping. Acceptable trade-off for a fixed-height virtualizer; documented limitation.
- **`ui/popover.tsx` `w-72`** — 288 px is 80 % of a 360 px viewport. The `max-w-[calc(100vw-2rem)]` baseline already constrains it; "looks tight" isn't a bug.
- **`MonthlyView` `grid-cols-7`** — calendar grid intentionally keeps 7 columns; the cell content (date number + dots + count badge) fits at 50 px. A real "list view at <sm" redesign is a separate UX track, not a defect.
- **`BlockZoomBar` breadcrumb caps** (`max-w-[160px]` intermediate, `max-w-[280px]` active) — the breadcrumb primitive already collapses ≥ 5 crumbs to a `…` overflow popover, which catches the typical phone case.

### Intentional design (flagged as bugs but verified as the fix)

- **`BlockInlineControls` `max-sm:flex-wrap`** — wrapping IS the responsive solution, not the problem.
- **`BlockZoomBar` exit-zoom button hidden on desktop** — intentional; desktop users have keyboard Escape and breadcrumb navigation, touch users get the explicit button.
- **`PropertyChip` `touch-target` utility** — the larger touch hit area is the WCAG goal, not a bug.
- **`MonthlyDayCell` desktop `min-h-[80px]` / touch `min-h-[44px]`** — round-1 called this "backwards"; it isn't. Cells are passive surfaces; the interactive element is the date-number circle inside, which itself grows from `w-7` to `w-10` on touch. Cell chrome shrinks because the circle grows.
- **`ImageLightbox` 90vw / 90vh** — body-level `safe-area-inset-*` padding already applies; no additional `env()` needed.

### Hallucinations dropped

These claims didn't survive opening the actual file. Documented so a future reviewer doesn't re-flag them:

- **`PropertyDefinitionsList` "table layout, no responsive fallback"** — admitted speculation on a truncated read; actual implementation is a `<ul>` of `<ListItem>`s. Naturally responsive.
- **`PdfViewerDialog` "zoom buttons missing touch targets"** — admitted speculation; actual buttons use `size="icon-sm"` which already includes the coarse-pointer baseline.
- **`FilterPill` "44 px button with 4 px padding = empty hit area is a bug"** — large hit area on touch is the intended outcome.
- **`TrashRowItem` / `ConflictListItem` / `ConflictBatchToolbar` / `HistorySelectionToolbar` Restore/Purge/Keep/Discard/Revert buttons "no touch override"** — all carry either `touch-target` utility or `[@media(pointer:coarse)]:h-10/11`, or inherit from `size="sm"` which already includes `[@media(pointer:coarse)]:h-11`.
- **`GraphFilterBar` "w-80 popover"** — actually `w-72`, and inherits `max-w-[calc(100vw-2rem)]` from `ui/popover.tsx`.
- **`SearchPanel` filter-row clear button "absolutely positioned, may overlap"** — the button is inline inside a Badge, not absolute.
- **`AppearanceTab` "`max-w-md` exceeds 360 px phone width"** — `max-w` is a cap, not a fixed width; content reflows below 448 px naturally.
- **`select.tsx` "max-h might be too tall on short screens"** — `--radix-select-content-available-height` is set by Radix from the actual viewport, so the dropdown is always viewport-aware.
- **`KeyboardShortcuts` inner ScrollArea "uses `max-h-[calc(100dvh-12rem)]`"** — actually has no `max-h` at all; the original claim quoted the wrong line.
- **`SpaceManageDialog` ScrollArea "lacks max-h"** — actually has `max-h-[85vh]` at `~L784`.
- **`PairingEntryForm` "4 word inputs don't stack on phones"** — already `grid-cols-2 sm:grid-cols-4`.
- **`SidebarTrigger` "icon overflows the button"** — icon defaults to `1em`, well within the explicit `size-7` / coarse-pointer `size-11` button.
- **`PropertyRowEditor`, `AddPropertyPopover`, `PageTagSection`, `PageHeaderMenu` popovers "need `max-w-[calc(100vw-2rem)]`"** — all already declare it explicitly at the call site (in addition to the primitive baseline).
- **`GraphView` "truncation badge overlaps filter bar"** — they're at opposite vertical corners (top-left vs bottom-left).
- **`App.tsx` "header label inherits `text-sm`"** — no text-size class on the span; inherits the body default.
- **`App.tsx` "header missing `safe-area-inset-top`"** — body-level safe-area padding in `index.css:827-831` propagates correctly to the header inside it.
- **`App.tsx` `ViewHeaderOutletSlot` "`py-3` not responsive"** — `py-3` is a static padding; misframed as unresponsive.
- **`SearchPanel` filter button "44 px target overlaps content"** — uses `min-h` / `min-w` (button grows from inline content), not absolute positioning.
- **`PairingQrDisplay` "fixed `w-[200px]` cramped"** — also has `max-w-full`; on 360 px the QR is 200 px (55 % of width), comfortable.
- **`PairingDialog` "ScrollArea inside unconstrained DialogContent is meaningless"** — the inner `max-h-[calc(100dvh-4rem)]` does work; the parent doesn't need to be bounded for the child to scroll.
- **`HistoryListItem` "header row wraps awkwardly"** — row is `flex flex-col`, wraps naturally; no awkward layout was demonstrated.

---

## Recommended order

If approving piecemeal, the highest leverage and the cheapest items group naturally:

1. **The two primitive fixes (H1 + H2)** — three lines across two files. These propagate through ~30+ dialogs and ~20+ popovers and remove the largest source of phone-overflow risk in the codebase.
2. **The editor-portal sweep (H4 + H5)** — four lines across two files. Brings the four custom floating-UI portals up to parity with Radix popovers.
3. **The override fixes (H3, H6, M2, M3, M4, M10, M11, M12, M13)** — each is a one-line className change; bundle them together.
4. **The wrap fixes (M7, M8, M9)** — `flex-wrap` / `flex-col sm:flex-row` per row.
5. **The viewport-width / input-width fixes (M5, M6)** — small but worth a screenshot pass to confirm they don't regress wider screens.
6. **M1 (BugReportDialog body scroll)** — partially covered by H1, but the file still benefits from an explicit ScrollArea body.
7. **L1** — when convenient.

Suggested sweep cost if all bundled: **L** (~30–50 LOC of className changes + 2 primitive edits + a screenshot pass on phone widths). No tests should regress; touch-target tests already in `__tests__` will catch any new sub-44 px violations.

## Methodology notes

Round-1 reviewer accuracy was about **50 %** for this scope, in line with the pattern in PEND-23, PEND-25, PEND-27. The dominant failure mode was missing the primitive baselines: `button.tsx` size variants already carry `[@media(pointer:coarse)]:h-11`, `popover.tsx` already carries `max-w-[calc(100vw-2rem)]`, `body` already carries `safe-area-inset-*`. Reviewers grepping for those classes per-component without first reading the primitive flag legitimate consumers as bugs. Round-2 validation, with explicit instructions to read each primitive first, dropped roughly half of Round-1 claims.

The remaining list is short, mechanical, and concentrated in the **two files that *should* hold the baselines but don't yet** (`ui/dialog.tsx`, `ui/popover.tsx`'s missing `max-h`) plus a **handful of consumer-side overrides that defeat the existing baselines** (`BlockPropertyDrawer`'s `w-80`, `AddFilterRow`'s `h-7`, custom editor portals that bypass Radix entirely). Fix those and the responsiveness story is in good shape.
