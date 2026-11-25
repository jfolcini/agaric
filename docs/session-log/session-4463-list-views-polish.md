# Session 4463 — list views: one add row, history rows that fit, a named trash origin, readable templates, and what a property op set

Part of the #7040 UI review: item S9's remaining part, P10 and D7.

**What shipped**

- **Add controls.**
  - Tags and Templates put the name input and its outline Add button on one row at every width; it used to wrap below `sm`.
  - The tag page's "Add notes" is the action of a compact `EmptyState`, like its empty Pages and Blocks panels. "Add property" is the one inline add.
  - The bug report's switches use `ToggleRow`, the Settings row: switch right of its label, hint as the description.
- **History on a phone.**
  - A row with no content is one line, the device name in Diff's place: a `:not(:has(...))` rule in `history-row-cell`.
  - On a coarse pointer the list's max height leaves room for the ↑/↓ pill, which used to sit pinned over a row by the scroller's bottom padding; never under 12rem, so a landscape phone keeps three rows.
- **Trash origin** reads "from: Old Page (deleted)" when the page is in the Trash too, "from: a deleted page" when it is gone, and "Untitled" for a live page with no title.
- **Templates.**
  - Two placeholder chips plus "+8 more"; the ⓘ lists all ten.
  - "Page template" is a muted ghost badge.
  - The preview renders through `renderRichContent` (inline), in the view and in the `/template` picker, instead of raw `## Attendees`.
  - The row's × removes template status, not the page, so it is an `IconButton` with `ListMinus` and a "Remove template status" name, not a trash icon.
- **"Set property → Space" says what was set.** `getPropertyPayload` read a `value` field the backend never writes; property values live in `value_text`, `value_num`, `value_date`, `value_bool` and `value_ref`. It now reads those, and a ref names its space or block ("Space → Work").
- **Tag page headings** (Notes, Pages, Blocks) share one style.
- **Tags** shows "Find blocks by tag" only while the space has a tag.

**False premises in the issue**

- The Add button was outline, not ghost, and looked disabled because it was disabled while the input was empty.
- The template × removes template status rather than deleting the page.
- "Set property → Space" was a payload-reader bug, not a label.

**Tests**

- e2e:
  - `tag-management`: no tags, no finder; the Add button on the input's row.
  - `templates-view` and `templates`: the preview with no `##`; Create on the input's row.
  - `tag-page-notes`: one heading style, Add notes in the empty state.
  - `bug-report-dialog`: the switch right of its label.
  - `list-rows-phone`: the pill covers no row; a content-less row is one line; a landscape phone keeps three rows.
- vitest: `history-utils` typed slots and refs; `HistoryItemCore` names; `useTrashBreadcrumbs`; `TagList` children; `TemplatesView` preview, badge and chips; `TagNotesSection`.
- Each was shown red before the fix, and the CSS, max-height and picker fixes again by mutation.
- The mock's space ops carry no value, so the history label is pinned in vitest only.
