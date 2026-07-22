# Session 1193 — List button no longer splits marker onto its own line

**Date:** 2026-07-22
**Branch:** `fix/list-button-marker-split`
**Closes:** #2999

## Summary

Turning a block into a bullet/ordered list (Turn-into menu or `/numbered-list` /
`/bullet-list`) rendered the marker (`1.` / `•`) on its own line with the content on
the line below, and backspace then had to collapse that phantom split before merging.
The defect was purely CSS, not in the command/data layer.

## Root cause

The command paths (`useSlashCommandStructural.ts` `handleNumberedList`/`handleBulletList`,
`block-type-convert.ts` `convertBlockContent`) emit single-line markdown, and
`markdown-parse/parser.ts` `buildListItem` parses it into exactly one `listItem`
containing one `paragraph` — the document structure was never split.

The split came from `.ProseMirror ul` / `.ProseMirror ol` using
`list-style-position: inside` (Tailwind `list-inside`). TipTap's `ListItem` schema is
`paragraph block*`, so the editable DOM is always `<li><p>text</p></li>` — a block-level
first child. Per the CSS list spec, `list-style-position: inside` with a block-level
first child forces the `::marker` onto its own line above the block. The read-only
`RichContentRenderer` was unaffected because it flattens inline content directly into
`<li>` with no `<p>` wrapper.

## The fix

`.ProseMirror ul` / `.ProseMirror ol`: `list-inside` → `list-outside pl-5` (Tailwind
preflight zeroes `ul/ol` padding, so an explicit `pl-5` keeps the marker legible in the
outside margin box). `list-outside` places the marker in the item's margin box
regardless of whether the `<li>`'s child is block or inline. Read-only renderer left
untouched. An explanatory comment documents the mechanism in `src/index.css`.

## Tests

- `block-type-convert.test.ts` — asserts the list buttons yield one-line markdown that
  parses back to exactly one `listItem` / one `paragraph` (populated + empty-block cases).
- `editor-list-marker-css.test.ts` (new) — reads `src/index.css` and guards that
  `.ProseMirror ul`/`ol` no longer use `list-inside` and do use `list-outside`.

Non-tautological: reverting the CSS makes the guard fail. Verified in a real browser via
a throwaway Playwright spec — marker/text y-delta was **1px** with the fix and **25px**
(a full line-height split) when reverted, reproducing #2999 exactly. 133 vitest pass;
tsc + oxlint clean.
