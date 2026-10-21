# Session 2838 — Joplin import keeps tags, to-dos, HTML notes, spaced names and link labels

Six of #6032's Joplin findings, frontend only (`src/lib/jex-import.ts`).

- **Tags.** A note's tags were never read; types 5 and 6 fell through as known but not imported. They now become a front-matter `tags:` list, one quoted item per tag, which the importer turns into page tags. `C++`, `2024` and `Multi Word` survive whole.
- **To-dos.** `is_todo`, `todo_completed` and `todo_due` were never read. A to-do now opens with a task block, `- [ ] <title>` or `- [x]`, carrying `due_date::` as a local date.
  - An unset or invalid due date is dropped; otherwise `formatDate` throws and the whole archive fails.
  - The task goes on a block, not on the page, because a page-level `todo_state` shows in the agenda but nowhere on the page itself. The cost is a repeated title. A `#word` in a to-do title becomes a tag.
- **HTML notes** were pasted as raw HTML. They now go through the ENEX importer's Turndown setup, now exported as `createHtmlTurndown`, and its table pass, now exported as `prepareTablesForGfm`.
  - Joplin stores a web clip as a `<style>` tag followed by a whole document, which Turndown reads as an empty string. So only the parsed `<body>` is converted, and `<style>` is dropped.
- **Resource names with a space or `)`** were never ingested. They now go through the ENEX importer's `sanitizeResourceName`.
- **Note-link labels.** `[label](:/id)` was cut to `[[Title]]`; it is now `[[Folder/Title|label]]`.
- **Other ref forms:** `joplin://id`, `:/id#anchor`, `:/id "title"`, and `<img src=":/id">` in Markdown notes.

Non-image attachments (PDF, audio) stay `[label](file)` links. Their bytes are not shipped, and the import result now warns about them and counts them. Only `GatedImage` resolves an inline `attachment:` ref, so a PDF ingested as `![…](…)` would draw a broken-image chip. The root fix is in the backend: `detect_attachment_refs` and `ingest_block_attachments` must keep such a file as a block attachment. The same gap drops a non-inline attachment on Agaric's own export → re-import; it is on #6032.

Reviewed separately; the reviewer was killed by a container restart and continued by a second one. The two `mutation-accepted.tsv` entries for jex's copy of `sanitizeResourceName` are deleted with the copy. The tag-to-`block_tags`, quoting and `due_date` paths were traced through `scan_frontmatter`, `apply_frontmatter_tags` and `import_markdown_due_date_stores_as_date`.

Shown red, among others:
- the `tags:` key dropped;
- the invalid-date guard removed (`RangeError: Invalid time value`);
- the string handed to Turndown instead of the body;
- `fileLinks++` dropped;
- the table pass dropped;
- the due date taken in UTC.

Suites run: vitest over `src/lib` and `src/components/settings`, typecheck, `typecheck:e2e-tauri`, lint, `prek` (manual stage too), and the import and settings Playwright specs. CI runs the extended `e2e-tauri/import-formats.e2e.ts` JEX case.

Left for #6032: reference-style `[x]: :/id` and `<a href=":/id">` in Markdown notes, `<img width>`, a link label with a line break, and refs inside code fences.
