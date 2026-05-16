<!-- markdownlint-disable MD060 -->
# Import & Export

## Import (Settings → Data)

- **Markdown** files. Each file becomes a page; folder structure becomes the namespace hierarchy.
- **Logseq** vaults. Page links (`[[title]]`), tags (`#tag`), and properties survive the import.
- Imports land in the **active space**. To import into a specific space, switch first.
- Pre-existing pages with the same title are kept (the importer doesn't clobber).
- Attachments referenced by relative paths are scanned and brought in alongside their pages.

The Import button shows progress with a count of files processed and a final summary.

## Export

### Per-page export

In the **PageHeaderMenu** kebab → *Export as Markdown* (or `Ctrl+Shift+E`).

- Emits the page's content as Markdown.
- A YAML front-matter block carries the page's properties (todo state, dates, tags, custom properties).
- Inline `[[links]]` and `@tags` are preserved as their textual equivalents (the importer round-trips them).

### Export-all-as-ZIP (Settings → Data)

- One Markdown file per page in the active space, with the namespace hierarchy mirrored as folders.
- Each file carries the same YAML front-matter as per-page export.
- Inline attachments are bundled into the ZIP alongside their pages.
- Includes a small `agaric-export.json` manifest with the export timestamp, source space name, and file count.

## Pitfalls to know

- **Imports don't merge by ULID.** Two devices that each import the same Markdown set end up with two parallel pages. Sync converges them via CRDT, but the page titles will collide. Plan imports on one device, then sync.
- **YAML front-matter parsing is strict.** A malformed YAML key fails the file silently — re-run the import after fixing.
- **Export is per-space.** To get everything, switch space and export-all for each one.
- **No Notion / Obsidian importers ship today.** Markdown export from those tools usually works as input here, but tool-specific syntax (Notion callouts, Obsidian dataview queries) is treated as plain text.
- **Export does not include device-local state** (drafts, recent-pages, sidebar width, keyboard customisations).
