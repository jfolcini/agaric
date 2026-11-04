# Session 3313 — the palette's page copy resolves attachments

#6277 A4. The command palette's "Export page as Markdown" put `exportPageMarkdown`'s text on the clipboard as it came, so a page with an image or a file link copied raw `attachment:<id>` links that open nothing outside Agaric, while the page header's copy (kebab item and Ctrl+Shift+E) resolved them through `resolveAttachmentRefsForCopy` (#2967). The palette also skipped the header's `flushActiveDraft` (#2969), so it could miss a just-typed draft.

Both now copy through one function, `pageMarkdownForCopy(pageId)` in `src/lib/export-graph.ts`: flush the draft, export, resolve. `palette-export-copy.test.ts` pins the palette's clipboard text against the resolved form; it went red with the palette's old call restored (`attachment:…` instead of `shot.png`).

Ran: vitest over `src/hooks`, `src/components/pages`, `CommandPalette.test.tsx` and `export-graph.test.ts`; `npm run typecheck`; oxlint and oxfmt on the touched files.
