# Block-history side panel — make it not look like crap

> Status: ready for review.
> Triggered by: the block-history Sheet (opened from the block gutter / context menu) is cramped, has a tall vertical filter stack stealing rows of body height, the inner ScrollArea doesn't actually constrain (so the LoadMoreButton can fall off the bottom), and at its 384 px max width the diff content wraps awkwardly. None of the bugs are individually huge; together they make a feature that's actually well-implemented underneath look amateur.

## What's actually broken

`src/components/BlockHistorySheet.tsx:21` (a thin wrapper) → `src/components/HistorySheet.tsx:20` (the Sheet) → `src/components/HistoryPanel.tsx:44` (the body).

Five distinct issues stacked:

1. **The Sheet is too narrow.** `SheetContent side="right"` is `w-3/4 ... sm:max-w-sm` (`src/components/ui/sheet.tsx:74`). That caps at `sm` = **24 rem ≈ 384 px** above the 640 px breakpoint — and history rows are dense (timestamp + op-icon + author + multi-line preview + diff toggle + restore button) plus an expanded panel containing a diff. 384 px guarantees aggressive wrapping.
2. **Inner ScrollArea sizing is broken.** `HistorySheet.tsx:33` does `<ScrollArea className="flex-1 overflow-hidden">`. `flex-1` in a `flex flex-col` parent (the Sheet base, `sheet.tsx:13`) only constrains height when there's a `min-h-0` somewhere upstream; the SheetContent has none. So the ScrollArea can grow past the viewport, pushing the LoadMoreButton at the bottom of `HistoryPanel.tsx:298` off-screen with no scrollbar to reach it. (Same root cause as the Dialog plan — `pending/dialog-responsiveness-primitive-2026-05-13.md`.) The trailing `overflow-hidden` is also redundant; the ScrollArea Root primitive (`scroll-area.tsx`) already does `relative overflow-hidden`.
3. **Padding model is ad-hoc.** `SHEET_CONTENT_BASE` (`sheet.tsx:11-13`) has no padding. `SheetHeader` adds its own padding; the body wrapper at `HistorySheet.tsx:34` adds `mt-4 space-y-3 px-4 pb-4`. Header padding ≠ body padding → visible misalignment between the title and the content's left edge.
4. **HistoryFilterBar wraps vertically inside the Sheet.** `HistoryFilterBar.tsx:89` is `flex flex-col sm:flex-row sm:items-center gap-3`. Tailwind's `sm:` breakpoint is **640 px viewport-wide**, not 640 px container-wide — and inside a 384 px Sheet, it still applies (the page is wider than 640 px), but the available space *isn't*. So you get the desktop horizontal layout shoved into ~360 px, where the label + 8-rem Select + help icon + clear-✕ + "All spaces" Switch with its label all jam together and overflow. **(Or, in the per-block path, the All-spaces toggle is hidden but the rest still cram.)** The chrome eats ~80 px of vertical Sheet height before a single history row appears.
5. **At 384 px the diff content cramps.** `whitespace-pre-wrap break-words` keeps it from clipping but the diff hunks become walls of single-word lines. Combined with the row-level `px-2 py-2` (`HistoryListItem.tsx:523`) and the diff container's own padding, the inner diff has maybe 320 px of usable width.

The structural fix at the primitive level is the same shape as `pending/dialog-responsiveness-primitive-2026-05-13.md` (header / scrollable body / footer with reserved `min-h-0`). The two should ship together; whichever lands first paves the road for the second. This plan covers what's HistorySheet-specific.

## The fix

Three independent changes that compose. Each is shippable on its own; recommend bundling.

### 1. Sheet primitive: scrollable-body slot + sane padding (mirrors the Dialog plan)

`src/components/ui/sheet.tsx`. Apply the same shape to `SheetContent` that `pending/dialog-responsiveness-primitive-2026-05-13.md` proposes for `DialogContent`:

- Bake `flex flex-col overflow-hidden p-6` into `SHEET_CONTENT_BASE` (today's base has neither padding nor overflow). The `gap-4` already there stays.
- Add a `SheetBody` slot:

```tsx
const SheetBody = ({ ref, className, children, ...props }: React.ComponentProps<'div'>) => (
  <ScrollArea
    ref={ref}
    className={cn('flex-1 min-h-0 -mx-6', className)}
    viewportClassName="px-6"
    {...props}
  >
    <div className="space-y-4 min-w-0">{children}</div>
  </ScrollArea>
)
```

Same negative-margin / inner-padding trick as the Dialog plan so the scrollbar sits in the gutter without eating the Sheet's content padding. `min-w-0` lets the filter bar's children shrink under tight widths.

If the Dialog primitive plan ships first, factor `DialogBody` and `SheetBody` to share the `<ScrollArea ... className="flex-1 min-h-0 -mx-6" viewportClassName="px-6">` wrapper. They are visually identical.

### 2. Widen the Block-history Sheet

`src/components/HistorySheet.tsx:28`:

```diff
-      <SheetContent side="right">
+      <SheetContent side="right" className="sm:max-w-lg">
```

`sm:max-w-lg` = **32 rem ≈ 512 px**. Big enough that the diff doesn't single-word-wrap and the filter bar stays one row. `sm:max-w-md` (28 rem ≈ 448 px) is the conservative alternative if 512 feels heavy on smaller laptop screens. Keep `w-3/4` from the base for narrow-viewport behaviour (mobile gets ~75% of viewport width, which is the right Sheet shape on phones).

The default Sheet size stays at `sm:max-w-sm` for other consumers; this is a per-call override.

### 3. Compact HistoryFilterBar at narrow widths

`src/components/HistoryFilterBar.tsx:88-189`. Three small edits:

- **Drop the standalone `<label>`** (line 90-92). The `Select` already has `aria-label={t('history.filterByTypeLabel')}` (line 100); a visible label that just repeats the placeholder isn't worth its row of vertical space at narrow widths.
- **Switch container layout from `flex flex-col sm:flex-row` to `flex flex-wrap items-center gap-2`.** Lets the bar fill horizontally and wrap row-by-row only when it actually runs out of width — works for both the wide HistoryView and the narrow Sheet without a media query.
- **Move the help-popover (`?` icon) and clear-`✕` next to the Select trigger** in the same flex row, so they read as part of the filter control rather than separate widgets.

After the changes, in the Sheet at 512 px the bar is one row: `[Select] [?] [✕] [All spaces toggle]` (the toggle stays hidden in the per-block path, so it's three controls). Plenty of room.

### 4. Move the non-reversible lock chip onto its own line below the metadata

`src/components/HistoryListItem.tsx:547-573`. Today the non-restorable branch is:

```tsx
<div data-testid={`block-history-row-${index}`} className="flex items-center gap-2 w-full">
  <HistoryItemCore entry={entry} />
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('history.nonReversibleLabel')}</span>
        </span>
      </TooltipTrigger>
      ...
```

So the row reads as one horizontal stripe: `[create_block badge] 2h ago · dev:a1b2c3d4 [🔒 Non-reversible action]`. That's ~390 px of content competing for ~370 px of usable width inside the Sheet (even after the width bump in #2 — at 512 px Sheet width minus padding minus row `px-2` it's still the tightest spot in the panel). It's the single visual contributor to "this looks like crap" that the user called out by name: `create_block` rows in particular are 100% non-restorable, so every create-block row in the history hits this layout.

Fix: switch the wrapper to a column for the non-restorable branch only:

```diff
-        <div data-testid={`block-history-row-${index}`} className="flex items-center gap-2 w-full">
+        <div data-testid={`block-history-row-${index}`} className="flex flex-col items-start gap-1 w-full">
           <HistoryItemCore entry={entry} />
           <TooltipProvider>
             <Tooltip>
               <TooltipTrigger asChild>
                 <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                   <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                   <span>{t('history.nonReversibleLabel')}</span>
                 </span>
               </TooltipTrigger>
               <TooltipContent>
                 <p>{t('history.nonReversibleTooltip')}</p>
               </TooltipContent>
             </Tooltip>
           </TooltipProvider>
         </div>
```

`HistoryItemCore` returns a fragment whose first child is already a column (`flex flex-col gap-0.5 min-w-0 flex-1`, line 117). With the wrapper as `flex-col`, that column takes the full row width, then the lock chip flows naturally onto a new line below it. Result:

```text
[create_block]  2h ago · dev:a1b2c3d4
🔒 Non-reversible action
```

Quiet, two-line, never wraps. Restorable rows (line 535-546) stay `flex items-center` — they don't render the lock chip; their layout is fine.

**Apply the same pattern to any future "row-level secondary status"** (e.g., a "conflict-resolved" tag, a "from device X" indicator) — the convention is: primary metadata stripe on row 1, secondary status chips below. This generalises the user's "same for other ops" instruction without speculating on what those future ops are.

### 5. (Optional) Tighten HistoryListItem padding inside narrow contexts

`src/components/HistoryListItem.tsx:523`. The row is `flex flex-col gap-1.5 px-2 py-2 border-b border-border/20`. Even at 512 px Sheet width that's fine; if the diff still feels cramped after (1)–(4), drop the row's `px-2` and let the SheetBody's `px-6` (from #1) be the only horizontal padding. **Don't pre-emptively change this** — sequence after the others land and only if visual sweep flags it.

## Verification

- `npm run typecheck`
- `npm run test -- HistorySheet HistoryPanel HistoryFilterBar BlockHistoryItem`:
  - Existing tests query by `data-testid` / `role="button"` / accessible labels — unaffected by the layout changes.
  - Add: `HistoryFilterBar` renders all controls in one row at typical widths (snapshot or `getAllByRole` sanity check).
  - Add: `HistorySheet` `SheetContent` carries `sm:max-w-lg` (regression guard so a future cleanup doesn't revert it).
  - Add: `BlockHistoryItem` non-restorable rows render the lock chip *outside* the metadata flex-row — query by accessible name (`getByText(t('history.nonReversibleLabel'))`) and assert its parent is a `flex-col` wrapper, not the metadata row.
- Manual sweep across viewport sizes:
  - **375 × 667** (iPhone SE) — Sheet is `w-3/4` of 375 = ~280 px, narrower than the desktop variant, but the filter bar (now `flex-wrap`) and SheetBody (now `flex-1 min-h-0`) handle it gracefully.
  - **768 × 1024** (iPad) — Sheet hits `sm:max-w-lg` cap at 512 px. Filter bar one row. Diff readable.
  - **1280 × 800** (laptop) — same Sheet width; main content beside it has plenty of room.
  - **1920 × 1080** (desktop) — same.
- Confirm the LoadMoreButton at the bottom of the Sheet is reachable (test today: it isn't on shorter windows because of #2).
- Confirm Esc closes, the close-button-X is reachable, focus traps work — none of these change but worth a glance after the layout refactor.

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | S. Sheet primitive (`SheetBody` + base padding/overflow): ~30 min. HistorySheet width override: 1 line. HistoryFilterBar compaction: ~30 min. Lock-chip layout fix (#4): ~15 min. Test updates: ~30 min. Manual sweep: ~30 min. Total: ~2.5 hours. **Plus an extra ~1 h if Dialog primitive plan hasn't landed and we're factoring the shared body wrapper into a util.** |
| **Impact** | Closes the visible "this looks bad" gestalt with one Sheet width bump + one filter-bar layout change + one primitive fix. Same primitive fix cleans up every other Sheet consumer in the app for free (pairing dialogs, mobile sheet variants of ConfirmDialog, etc.). The diff is small and the visual win is large. |
| **Risk** | Low. (1) is structural but matches the Dialog plan precedent — same shape, same gotchas, same fix. (2) is a className override at one call site. (3) drops a redundant label and reorders controls inside one component; tests query by accessible name not visual order. The main risk is (3)'s `flex-wrap` behaving worse than the `flex-col sm:flex-row` in some edge case (very long translated label) — mitigated by the `min-w-0` on inner controls and the fact that wrap is the worst case, not overflow. |
| **Reversibility** | High. Each numbered change is a self-contained diff. |

## Why bundle vs ship piecemeal

(2) alone (just widening the Sheet) covers ~40% of the visible ugliness. (4) alone (lock-chip on its own line) covers ~25% — the create-block-row crowding the user explicitly called out. (3) alone (just compacting the filter bar) covers ~20%. (1) alone fixes the LoadMoreButton-falls-off-the-bottom bug. They compound: a wider Sheet without the filter bar fix wastes the new width on the same vertical chrome stack; the primitive fix without the width bump leaves the diff cramped; the lock-chip stays awkward at any Sheet width if the row layout isn't fixed. Ship together for one user-visible "now it looks intentional" moment.

## Out of scope

- Redesigning HistoryPanel itself — entries, expansion behaviour, restore confirmation pattern. The information architecture is fine; only the container is broken.
- Replacing the per-block Sheet with a different surface (popover, inline drawer, separate route). The Sheet is the right shape; it just needs to fit.
- Cross-cutting refactor of every Sheet consumer in the app to use the new `SheetBody`. Migrate opportunistically when each is touched next; the primitive change is backwards-compatible (consumers that don't render `<SheetBody>` keep working with their current ad-hoc body wrappers).
- The shared `Dialog`-vs-`Sheet` body-wrapper extraction. Worth doing only after both primitives are settled; until then, accept the duplication of the `<ScrollArea ... flex-1 min-h-0 -mx-6 / viewportClassName="px-6">` line.
