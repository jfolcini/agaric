## Session 924 — #215: query builder at insertion (/query opens the visual builder) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct + Playwright runtime verification |
| **Items closed** | — (partial: #215 query-builder-at-insertion) |
| **Items modified** | #215 |
| **Tests added** | +1 unit (/query → openQueryBuilder) + e2e (builder flow); updated /query e2e |
| **Files touched** | 8 |

**Summary:** #215 sub-issue 3 — `/query` dumped raw `{{query type:tag expr:}}` syntax; the visual `QueryBuilderModal` existed but was edit-only. Now `/query` **opens the builder** (mirroring the date-picker-at-insert / template-picker pattern), and on save writes the generated `{{query …}}` to the launched-from block.

Plumbing (mirrors `openTemplatePicker`): a new `openQueryBuilder: () => void` on `SlashCommandContext` + `UseBlockSlashCommandsParams`, threaded through `useBlockSlashCommands`'s `inputsRef`; the `/query` handler calls `ctx.openQueryBuilder()`; BlockTree owns `queryBuilderOpen`/`queryBuilderBlockId` state, mounts `<QueryBuilderModal>`, and `handleQuerySave` does `editBlock(blockId, \`{{query ${expr}}}\`)` + reload (same shape as `QueryResult.handleBuilderSave`).

**Runtime-caught issue + fix:** Playwright surfaced a `flushSync was called from inside a lifecycle method` console error — opening the focus-trapping Dialog synchronously inside the slash handler blurs the editor mid-render, and the editor's blur flush (`flushSync` in `useEditorBlur`) warns. Fixed by deferring the dialog open one tick (`setTimeout(…, 0)`) so the current commit + blur settle first. (`/template`'s picker is a non-focus-trapping floating element, so it never hit this.)

**Files touched:** `useBlockSlashCommands/types.ts`, `types-public.ts`, `useSlashCommandStructural.ts` (handler), `useBlockSlashCommands.ts` (thread param), `__tests__/test-utils.ts` (+openQueryBuilder), `components/BlockTree.tsx` (state + modal + save), `e2e/query-blocks.spec.ts` (updated /query test).

**Verification:** 79 slash-command unit tests green; tsc + oxlint + oxfmt clean. **Runtime (Playwright):** `/query` → builder opens → enter tag → "Insert Query" → the block renders a `query-result` after save; no console errors.

**Commit plan:** single commit / pushed.
