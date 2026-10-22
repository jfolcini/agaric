# Session 2876 — Notion exports, plain-folder text formats and a basic `.org` import

#6032's frontend import items. Before this, a picked folder kept only its `.md` files and dropped everything else without notice, and a Notion export imported with its page ids in every title and link.

**Where it converts.** The Rust parser `parse_logseq_markdown` (`agaric-engine/src/import.rs`) already reads Org task keywords, `[#A]`, `SCHEDULED:`/`DEADLINE:` lines and `key:: value` lines under a bullet. So `.org` and Notion are converted in TypeScript into the Markdown it reads, with no Rust change and no new dependency. The backend strips only `.md` from a title, so every note path is sent ending in `.md`.

**What changed.**
- **Plain folders:** `.markdown`, `.mdx` and `.txt` import as Markdown, and `.org` goes through `src/lib/org-import.ts`. Hidden files, images and PDFs are not counted; any other skipped file is counted in a warning through the existing `initialWarnings` path.
- **Notion (`src/lib/notion-import.ts`):**
  - Detected when most `.md` names end in a 32-hex id.
  - The id comes off every path segment and every `.md` link destination.
  - `<aside>` and `<details>` become `> [!note]` callouts; there is no toggle form (#6033).
  - The leading `Key: value` paragraph becomes `key:: value` page properties.
  - Database CSVs are counted in their own warning; each row is also a page of the export and imports with its properties.
- **Org,** per the maintainer's decision of 2026-10-22:
  - headlines become blocks nested by their stars;
  - TODO/DONE, priority and SCHEDULED/DEADLINE pass through for the backend to read;
  - `:PROPERTIES:` drawers become properties, and `#+TITLE` names the page;
  - links become Markdown or wiki links;
  - SRC and EXAMPLE blocks become code fences; tables and other text stay as text.
- **Found in review and fixed:**
  - HTML in a Notion code block was rewritten into a callout, and link ids inside code were stripped. Both passes now skip fenced lines.
  - A Notion property whose key folds to a reserved key (`Space:`, `Template:`) became a page property the backend drops without a warning. Such a paragraph now stays text.
- **Review also asked:** `e2e-tauri/import-formats.e2e.ts`, `import-obsidian-vault.e2e.ts` and the new spec carried copies of the same helpers. `openDataTab`, `waitForImportResult`, `importFolder` and `openPageTitled` now live in `e2e-tauri/helpers.ts` (`e2e-tauri/AGENTS.md`: a second copy moves there).

**Shown red,** each with a one-command mutation that restored the file:
- `.txt` dropped from the note extensions;
- the source extension kept in the path;
- hidden files, images or PDFs counted;
- Notion ids kept in paths, then in link destinations;
- property lines never read;
- `<details>` left as HTML;
- the detection threshold changed to `named > 0`;
- CSVs not counted;
- the accent strip removed;
- Org depth, drawers, `#+TITLE`, links and fences each left unconverted;
- the warnings dropped in `ImportSection`;
- the review fixes undone one at a time;
- Playwright: Notion ids kept, asides left as HTML.

**Suites:**
- vitest `src/lib`, `src/components/settings`, `src/__tests__`: 250 files, 5996 passed;
- `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npm run lint` and the import-cycle check;
- Playwright `e2e/import*`: 17 passed.

`e2e-tauri/import-notion-org.e2e.ts` and the specs moved onto the shared helpers were not run here, because the Tauri debug build did not fit the box. CI's real-backend lane is their first run.

**Left for the maintainer.** In a typical Notion task database, three of the four common properties collide with built-in definitions that refuse Notion's values:
- `Status: In progress` against the seeded `status` select;
- `Priority: High` against `priority` 1–3;
- `Due date: November 1, 2026` against `due_date`.

Each is skipped with a warning, so the value is lost. Mapping a colliding key to `notion-<key>`, or parsing Notion's date format, would keep it.
