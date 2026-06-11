# Session 1014 — #215 remainder: /table NxM toolbar picker (#215b)

#215 was re-scoped (2026-06-11): ~80% already shipped (10 merged PRs). This ships the clean
remaining piece:

- **#215b — `/table NxM` toolbar grid picker.** New `components/editor-toolbar/TablePicker.tsx`
  (Notion/Docs-style 8×8 grid, pointer + full keyboard), wired via `RefsAndBlocksGroup`/`items.ts`,
  inserts through the SAME `insertTable({withHeaderRow:true})` path as the `/table` slash command.
  UI-only, no persistence. Tests incl. axe a11y.

**#215a (inline query syntax hints) was REVERTED** — the space-triggered suggestion popup opens
during normal query typing (a query is full of spaces) and consumes the Enter that saves the
block, breaking query-block creation (caught by the `query-blocks.spec.ts` e2e). Re-filed for a
proper redesign (Tab-to-accept, not Enter-consuming; or a non-suggestion inline hint).

**#215c (table column alignment/resize) NOT built** — mutates the persisted markdown format
(#532/#710/#711 zone); needs its own design pass. Closes #215 (#215a/#215c carved out).
