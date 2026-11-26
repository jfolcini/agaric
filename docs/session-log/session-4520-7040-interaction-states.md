# Session 4520 — one focus ring, a selection around the whole row

Part of the #7040 UI review, coverage item C5: focus, selection and the list cursor across the app (maintainer decisions 31 and 32).

**What shipped**

- **One opaque focus ring.**
  - A destructive button, a destructive badge and an invalid field tinted the ring to the red at 20–40% alpha, under 3:1. They now keep the one blue `--ring`, and an invalid field's red border still says invalid (decision 32).
  - The Tags list's tag button, the Templates list's open button and the linked-references rows drew only the browser's own outline. They take `focus-ring-visible`, inset on the references rows inside their scroller.
  - A task row's breadcrumb link lost most of its ring to the `truncate` box around it. The box pads 3 px and takes it back with a negative margin.
- **The multi-select highlight covers the whole block row.** `block-selected` moves from the text line to the row's frame in `SortableBlock`, around the checkbox, the text and the chips, where the editing box and the cursor ring already sit. `StaticBlock` and `EditableBlock` lose their unused `isSelected` prop.
- **Search results take the list cursor (decision 31).** The focused result row, and Replace's preview row in the same list box, draw `list-cursor` instead of a flat `bg-accent`, and the list box draws no browser outline.
- `docs/UX.md` gains the one-ring rule and says where the selection highlight sits.

**Reviewed, not defects**

- Contrast of the selection, measured in the browser with three rows selected and the cursor on one: the ring against the page and the tint, and the text on the tint, hold 3:1 and 4.5:1 in light, dark and both high-contrast themes. Selected and focused draws only the 3 px ring; selected alone draws 2 px.
- The breadcrumb's padding leaves the row's size and the link's position unchanged at desktop, tablet and phone widths. A title long enough to hit its width cap truncates about one character earlier, with no victim.

**Tests**

- **e2e (mock lane):** new `interaction-states` pins the destructive and invalid rings, the Tags button's ring, the breadcrumb's unclipped ring, the highlight around the checkbox, and the search results' list cursor. Each was red on the old code with the predicted assertion.
- `block-select-cursor`'s `expectCursorOn` reads the row the cursor leaves: no box-shadow when it is unselected, the selection's 2 px ring and no 3 px ring when it is selected.
- Specs that read `block-selected` on `block-static` read it on `block-frame`.
- `SearchPanel.test` pins `list-cursor` on the focused result instead of `bg-accent`.
- A separate session reviewed it. It tightened the cursor-leaves check, which had passed for two reasons, and built decisions 31 and 32.
