<!-- markdownlint-disable MD060 -->
# Import & Export

## Import (Settings → Data)

- **Markdown** files. Import is per file: each `.md` file becomes a page. Picking a folder imports every `.md` file inside it independently — each file's relative path is used to build a namespaced page title, so the folder structure is reflected in page titles. There is no vault-aware handling (no special treatment of Logseq `journals/`, `pages/`, or `assets/` folders, and no cross-file resolution beyond `[[Page Name]]` links).
- **What import resolves:**
  - `[[Page Name]]` wiki-links — resolved within the active space; a target page is created if it doesn't already exist.
  - Properties — inline `key:: value` lines and YAML front-matter `key: value` scalars.
- **Not yet implemented (kept as literal text):**
  - `#tag` hashtags are **not** parsed into tags or tag associations on import — a `#tag` is stored verbatim as block content. (Export writes `#tagname`, but import does not reverse-resolve it back into a tag.)
  - Attachments are **not** scanned or brought in on import.
- Imports land in the **active space**. To import into a specific space, switch first.
- Pre-existing pages with the same title are kept (the importer doesn't clobber).

The Import button shows a per-block progress count while a file imports, then a count-only summary (page title, blocks created, properties set, and a `N warning(s)` count). It does not show per-file detail or which file produced a given warning.

## Export

### Per-page export

In the **PageHeaderMenu** kebab → *Export as Markdown* (or `Ctrl+Shift+E`).

- Emits the page's content as Markdown.
- A YAML front-matter block carries the page's properties (todo state, dates, tags, custom properties).
- Inline `[[links]]` and `#tags` are written as their textual equivalents. `[[links]]` round-trip back into page references on import; `#tags` are written as text but are **not** re-imported as tags (they stay as literal text — see Import above).

### Export-all-as-ZIP (Settings → Data)

- One Markdown file per page in the active space, with the namespace hierarchy mirrored as folders.
- Each file carries the same YAML front-matter as per-page export.
- Inline attachments are bundled into the ZIP alongside their pages.
- Includes a small `agaric-export.json` manifest with the export timestamp, source space name, and file count.

## Pitfalls to know

- **Imports don't merge by ULID.** Two devices that each import the same Markdown set end up with two parallel pages. Sync converges them via CRDT, but the page titles will collide. Plan imports on one device, then sync.
- **Malformed YAML front-matter lines are skipped, not fatal.** A front-matter line that isn't a valid `key: value` scalar is ignored; the page and the rest of its front-matter still import. The skipped lines are surfaced (not silently swallowed) in the summary's warning count as `N frontmatter line(s) [...] ignored`, so there's no need to re-run the import. Array/collection front-matter syntax is likewise parsed-and-ignored with a warning.
- **Export is per-space.** To get everything, switch space and export-all for each one.
- **No Notion / Obsidian importers ship today.** Markdown export from those tools usually works as input here, but tool-specific syntax (Notion callouts, Obsidian dataview queries) is treated as plain text.
- **Export does not include device-local state** (drafts, recent-pages, sidebar width, keyboard customisations).
