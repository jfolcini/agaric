<!-- markdownlint-disable MD060 -->
# Import & Export

## Import (Settings → Data)

Settings → Data offers separate buttons for `.md` files, a folder, an **Obsidian vault**, **Evernote** (`.enex`), **Joplin** (`.jex`), and a bibliography file.

- **Markdown** files. Import is per file: each `.md` file becomes a page. Picking a folder imports every `.md` file inside it independently — each file's relative path builds a namespaced page title, so the folder structure is reflected in page titles.
- **What import resolves:**
  - `[[Page Name]]` wiki-links — resolved within the active space; a target page is created if it doesn't already exist.
  - `#tag` and `#[[Multi Word Tag]]` hashtags — resolved to an existing tag or created, then rewritten to canonical tag references, the same as typing them in the editor.
  - Properties — inline `key:: value` lines and YAML front-matter `key: value` scalars.
  - **Attachments**, but only on a *folder* import: the referenced files are matched against the picked folder's other files (by relative path first, then by filename) and brought in, with the links rewritten. A single-file `.md` pick has no siblings to match against, so its attachment references stay as-is.
- There's no vault-layout awareness beyond that — Logseq's `journals/` / `pages/` folders get no special treatment, and tool-specific syntax is not interpreted.
- Imports land in the **active space**. To import into a specific space, switch first.
- Pre-existing pages with the same title are kept (the importer doesn't clobber).

The Import button shows a per-block progress count while a file imports, then a count-only summary (page title, blocks created, properties set, and a `N warning(s)` count). It does not show per-file detail or which file produced a given warning.

### Bibliography import (BibTeX / CSL-JSON)

*Import Bibliography* in Settings → Data accepts `.bib` (BibTeX) and `.json` (CSL-JSON) files. Each entry becomes a **reference page** in the active space:

- **Page title** is the citation display name — `{first-author family name} {year}` (e.g. "Smith 2024"), falling back to the citation key; title collisions get the citation key appended.
- **Typed properties** per entry: `citation-key`, `authors` ("; "-joined), `year` (number), `doi`, `url`, `journal`, `abstract`, `reference-type`. Those types are a *preference*, not a guarantee — **the vault's existing shape for a key always wins, declared or not**, and the import coerces its own values to that shape instead:
  - A key you have already **declared** (Settings → Properties) keeps your declaration; the imported values coerce to it.
  - A key you have **values under but never declared** stays undeclared — declaring it would constrain that key on every block in the vault, not just the imported pages, and there is no clean way back once values exist. The imported values are stored as text, like any undeclared key's.
  - Only a key that is both undeclared and unused anywhere in the vault gets the type above.
  - Every skipped declaration is reported in the import summary's `warnings` (counted as `N warning(s)`), naming the key and why.
- **Re-import is idempotent:** entries whose `citation-key` (or, as a fallback, non-empty `doi`) already exists in the space are skipped and counted.
- **BibTeX is a documented subset** (`src-tauri/agaric-engine/src/bibliography.rs`): brace-bodied entries with `{…}` / `"…"` / bare-integer values; `@comment` / `@preamble` / `@string` are skipped with a warning (no macro expansion, no `#` concatenation); LaTeX decoding covers only the common escapes, dashes, and pure-ASCII accent forms — anything else stays literal with a per-entry warning. Unbalanced braces or an unterminated quote fail the import with the entry's line number.
- Authors and journals land as text, not linkable `ref` pages; a live citation picker is a possible follow-up.

## Export

### Per-page export

In the **PageHeaderMenu** kebab → *Export as Markdown* (or `Ctrl+Shift+E`).

- Emits the page's content as Markdown.
- A YAML front-matter block carries the page's properties (todo state, dates, tags, custom properties).
- Inline `[[links]]` and `#tags` are written as their textual equivalents, and both round-trip: re-importing the file resolves them back into page references and tags.

### Export-as-ZIP (Settings → Data)

Two buttons: **Export All** (the active space) and **Export all spaces** (the whole vault, one top-level folder per space, with same-named spaces disambiguated).

- One Markdown file per page, with the namespace hierarchy mirrored as folders.
- Each file carries the same YAML front-matter as per-page export.
- Attachments — inline images and block-scoped files alike — are written into an `assets/` folder and the Markdown links are rewritten to relative paths, so they resolve in other tools.
- If any page or attachment couldn't be exported, the ZIP gains an `export-report.txt` listing exactly what was skipped, and the toast says so rather than reporting a clean success.

## Pitfalls to know

- **Imports don't merge by ULID.** Two devices that each import the same Markdown set end up with two parallel pages. Sync converges them via CRDT, but the page titles will collide. Plan imports on one device, then sync.
- **Malformed YAML front-matter lines are skipped, not fatal.** A front-matter line that isn't a valid `key: value` scalar is ignored; the page and the rest of its front-matter still import. The skipped lines are surfaced (not silently swallowed) in the summary's warning count as `N frontmatter line(s) [...] ignored`, so there's no need to re-run the import. Array/collection front-matter syntax is likewise parsed-and-ignored with a warning.
- **Import is per-space; export doesn't have to be.** Imports always land in the active space, but *Export all spaces* covers the whole vault in one ZIP — no need to switch spaces and export repeatedly.
- **No Notion importer ships today.** Its Markdown export usually works as plain folder input, but Notion-specific syntax (callouts, databases) is treated as plain text.
- **Export does not include device-local state** (drafts, recent-pages, sidebar width, keyboard customisations).
