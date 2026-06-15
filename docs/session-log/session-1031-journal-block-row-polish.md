# Session 1031 — journal/editor block-row polish (#1243)

2026-06-15. User report (Journal view, repeated 4×): the per-block gutter
controls (drag handle, history, delete) show on **every** block at once, not
just the active/hovered one — plus a red box around the whole journal, a red
left-line + background "leak" on the editor, and a collapse caret "floating way
to the left" of the block text. Mandate: fix it for real, guarantee with an
e2e test, "negative space management top-notch", look polished at rest **and**
when active. Issue filed: **#1243**.

## Root causes (all confirmed in code, then fixed)

1. **Gutter controls reveal on ALL blocks** — `DaySection.tsx` wrapped the whole
   `BlockTree` in a bare `<section className="group …">`. Tailwind `group-hover:`
   matches **any** ancestor with the `group` class, and each block row is itself
   `.sortable-block.group` revealing its gutter via `group-hover` — so the
   section-level `group` (an ancestor of every row) made hovering anywhere in the
   day reveal every row's controls. The `group` was also **unused**
   (`PageQuickActions variant="journal"` is `hoverReveal: false`). → removed it.
   The existing #370 reveal test only opened the **page editor** (no such
   wrapper), which is why it stayed green while the journal stayed broken.

2. **Red box around the whole journal** — `JournalPage.tsx` put
   `focus-ring-visible` on the `tabIndex={-1}` journal container. `--ring` is red
   in-theme, so when primary focus (usePrimaryFocus / Ctrl+F host) landed on the
   container it painted a 3px red ring around the **entire** journal. → removed
   the class; the container is a programmatic focus/scroll target, not an
   interactive control, so it shows no ring.

3. **Red left-line + bg leak on the editor** — `SortableBlock.tsx` editor body had
   `isFocused && 'border-l-primary bg-sidebar-accent'` (a #1232 addition) layered
   **on top of** EditableBlock's own focused `block-editor` box
   (`ring-1 ring-border bg-accent/[0.06] shadow-sm`). Two highlights; the tint bled
   to the left edge behind the red bar. → removed the SortableBlock-level
   highlight (incl. the `border-l-[3px] … pl-2` reservation). The grey
   `block-editor` box is now the single, calm active indicator.

4. **Caret floating far left** — an **expanded** parent's collapse chevron rendered
   persistently, sitting after the empty 68px gutter and before the hidden
   bullet/checkbox slots — a lone `v` ~75px left of its text. → the expanded
   chevron now hover-reveals on the same per-block contract as the gutter + zoom
   bullet (`opacity-0` at rest → `group-hover` / `group-focus-within` /
   `.block-active`). A **collapsed** block keeps its chevron at rest (the
   expand affordance + collapsed cue). Touch unaffected (no hover).

## Files

- `src/components/journal/DaySection.tsx` — drop bare `group`.
- `src/components/JournalPage.tsx` — drop `focus-ring-visible` on the container.
- `src/components/editor/SortableBlock.tsx` — drop the red accent/tint editor-body highlight.
- `src/components/editor/BlockInlineControls.tsx` — expanded chevron hover-reveal; collapsed stays visible.
- `e2e/journal-block-controls.spec.ts` (new) — **Journal-view** regression test:
  hovering one block reveals only its own drag handle (opacity), siblings stay 0.
- `src/components/editor/__tests__/SortableBlock.test.tsx` — updated to the new
  contract (no red accent/tint; expanded chevron hover-reveal; collapsed visible).

## Verification

Visually verified each state via Playwright screenshots (rest / hover / focused):
clean rows at rest, single grey focused box (no red), chevron no longer floats.
`tsc` clean; updated unit suites green (`SortableBlock`, `BlockInlineControls`,
`EditableBlock`, `DaySection`, `JournalPage`); new journal e2e green; existing
#370 page-editor reveal test still green. Complexity warnings on the two large
components are pre-existing (main already warns) and non-failing.
