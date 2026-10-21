# Session 2836 — Evernote import keeps note bodies, attachments, tables, tags and the source URL

Five of #6032's Evernote findings, frontend only (`src/lib/enex-import.ts`).

- **A note with a named entity imported empty.** ENML is re-parsed as XML, and `&nbsp;` or `&eacute;`, legal in ENML through its DTD, gave a `parsererror`. On that error the body became `''`. Checked in Chromium, with and without Evernote's DOCTYPE. `parseEnml` now reads the note as HTML when the XML parse fails, so a well-formed note takes the same path as before. Under the HTML parse a self-closing `<en-todo/>` or `<en-media/>` swallows the siblings after it, so `transformEnmlDom` puts them back in order.
- **Attachments with a space or `)` in their name were never ingested.** The backend's image regex stops at whitespace and `)`, so `![](Screenshot 2024.png)` shipped its bytes and was dropped. Resource names now have whitespace and parentheses replaced by `_` before the collision check, so a second `Screenshot_2024.png` gets a hash suffix.
- **Tables.** A table with no header row stayed raw HTML; its first row now becomes the header. An empty `<table>` threw inside turndown-plugin-gfm and failed the whole `.enex`; it is now unwrapped. Evernote wraps cell text in `<div>`s, so a cell rule joins a cell onto one line and escapes `|`. A merged cell stays one cell, so the cells after it shift left. A list in a cell is flattened onto one line.
- **Tags.** `C++` became `C`, `v1.2` `v1`, `Q&A` `Q`, and `2024` stayed text. A tag is now written bare only when the name tokenizer reads the bare form back whole; otherwise it is written as `#[[…]]`.
- **A web clip's URL** (`note-attributes/source-url`) is now the `source-url` page property.

Reviewed separately: the HTML fallback triggers only on a `parsererror`, and a bundle run in Chromium matched happy-dom on nine cases. WebKitGTK is checked by the updated `e2e-tauri/import-formats.e2e.ts` case in CI. The reviewer deleted one test that pinned Turndown's escaping rather than a fix.

Shown red, among others: the fallback returning an empty note (three tests), the header move disabled, the empty-table unwrap removed, the old tag rule, and the source-URL selector.

Suites run: vitest over the import, settings and lib tests (3771 passed), typecheck, `typecheck:e2e-tauri`, lint, `prek` on the changed files, and the 11 Playwright specs `just e2e-related` selects. The WebdriverIO specs run in CI.

Left for #6032: audio, Office and zip resources (the backend's MIME allow-list), reminders and `<task>`, links between notes, and styling.
