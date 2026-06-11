# Session 1014 — #215 remainder: query inline hints (#215a) + table NxM picker (#215b)

#215 was re-scoped (2026-06-11): ~80% already shipped (10 merged PRs — table ops #270,
header opt-out #256, callout picker #262, query builder #263, code-lang #255, code label
#261, templates #320/#267). The remaining low-risk pieces, built here:

- **#215a — inline `{{query …}}` syntax-hint picker.** New `editor/extensions/query-hint-picker.ts`
  mirrors the established `createPickerPlugin` mechanism; triggers only inside an open
  `{{query …}}` token (gated `allow` callback); surfaces the canonical operators/keys from
  `query-utils.ts` (sourced from what `parseQueryExpression` accepts — not invented) and inserts
  the literal token text. Registered in `use-roving-editor.ts` + `suggestionPluginKeys`. **Zero
  serializer change** — the `{{query …}}` text + round-trip are unchanged.
- **#215b — `/table NxM` toolbar grid picker.** New `components/editor-toolbar/TablePicker.tsx`
  (Notion/Docs-style 8×8 grid, pointer + full keyboard), wired via `RefsAndBlocksGroup`/`items.ts`,
  inserts through the SAME `insertTable({withHeaderRow:true})` path as the `/table` slash command.
  UI-only, no persistence.

Tests: query-hint-picker (11) + query-utils consistency + TablePicker (5, incl. axe a11y). 1367
tests pass, tsc clean, import-cycles 0.

**#215c (table column alignment + resize) NOT built** — it mutates the persisted markdown format
(#532/#710/#711 zone) and needs its own design pass + tracked issue. Closes #215 (remaining
actionable scope; #215c carved out).
