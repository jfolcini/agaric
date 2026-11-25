# Session 4461 — the advanced query opens on its results, with a form that fits a phone

Part of the #7040 UI review: item P8 and the Query half of D6.

**What shipped**

- **Results first.** A one-line summary of the query (`tag: work · sorted by Created ↑`) with an *Edit query* button sits above the results. The builder, controls and saved views fold under it.
  - The form starts open only for an empty query. Loading a saved view folds it, and so does returning to a query that has run.
  - The folded form is `hidden`, not unmounted: unmounting would cancel the full-text box's debounce and drop the last keystrokes.
- **The form on a phone.** Add sort and Add summary sit under their rows at the column's left edge. NOT is a `Button size="sm"` with `aria-pressed`, at the same height as All/Any. A summary row's two pickers share one line.
- **Result rows** use `listRowVariants` inside `listCardVariants` cards, with a type icon: Calendar for journal pages, FileText for pages, Tag for tags, Pilcrow for blocks. A task keeps its checkbox. `FilterGroup`'s chips and the summary share `builderLeafLabel`. A `{{query}}` block in a page shares the row at its compact density, so its rows stay short among the page's blocks.

**False premises in the issue:** both ⓘ icons were already `InfoPopover`, which opens on tap. Saved views open only from this view, never from the sidebar or the palette.

**Tests**

- `advanced-query-layout` (new):
  - with a saved view open, the results are on screen and the form folded, on desktop and on a phone;
  - result rows carry a type icon;
  - on a phone, Add sort sits at the form's left edge with no horizontal overflow.
- `query-blocks`: a query block's row is 32 px, the compact density.
- vitest: `query-summary`, the fold on a run query and on a saved-view load (with `axe`; focus moves to *Edit query* as the Load button folds away), and the row type icon.
- Each was shown red on the old code or by a one-command mutation.
- `advanced-query-saved-views` and `advanced-query-happy-paths` open the folded form before editing it.
- The bridge `advanced-query-*` specs ran only as mock copies here. Eleven of their tests fail on the mock with or without this change (result order, template exclusion, the `[[` picker), so the real-backend lane in CI is the check.
