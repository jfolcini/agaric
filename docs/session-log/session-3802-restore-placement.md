# Session 3802 — templates, done dates and file placement survive a restore (#6277 G3)

Set out to build #6277 G3: a ZIP restore keeps a template page a template, a
task's done date, and each file on the block or page it hangs on.

What shipped:

- The export writes a page's `template` flag in front matter. Only the export
  read writes it (`load_page_export_data` drops it for the buffer, a copy
  and the mirror file), so Edit as Markdown and Duplicate are unchanged.
- A block's own files are an `attachments:: [name](attachment:<id>), …` line
  at its text column, and the page's own are `attachments: [...]` in front
  matter. Both used to be written as content (a `+` child, a paragraph) and
  came back as blocks.
- The ZIP writes each asset at `assets/<id>/<name>`. The old `<id>__<name>`
  gave every filename another prefix per restore cycle.
- A file import reads both keys back (`FILE_KEYS`, a `file` flag on the
  block scan and the front matter scan). It attaches each listed file to that
  block or page through the existing ingest, as a `scoped` pending list that
  rewrites no text. A file the import does not bring is left out with a
  warning. Every other reader keeps both keys reserved: a paste, an Edit as
  Markdown save and an MCP append keep an `attachments::` line as text, and a
  `template::` line too (maintainer decision, through the coordinator).
- `attachments` joins `INTERNAL_PROPERTY_KEYS` (TS and `op.rs`), the reserved
  reader lists (`FRONTMATTER_RESERVED_KEYS`, `INLINE_PROPERTY_RESERVED_KEYS`)
  and both export `NOT IN` lists, so an `attachments` row an earlier import
  stored is never written twice.
- The done date needed no code: D3 already writes it as the task's `✅`. The
  new restore test pins it.

Traps:

- Removing `template` from the shared reserved list made a paste store
  `template:: x` as a hidden property, and the buffer show it. That is why
  the `file` flag exists.
- The issue names `is_builtin_property_key` as the Rust twin of
  `INTERNAL_PROPERTY_KEYS`. The real twin is `op::INTERNAL_PROPERTY_KEYS`; a
  built-in would need a type and a definition row.
- The mock's export and import are approximations, not pinned against the
  backend (`DRIFT_SKIP`), so the mock is unchanged. Its editor-facing readers
  follow the TS reserved list.
- A falsify trap ran `cp` from a `cd`'d subshell and missed its relative
  path; the file was restored by hand. Use absolute paths in traps.
- The whole-workspace build filled the disk twice; `CARGO_INCREMENTAL=0`
  kept it in bounds.

Existing tests changed (maintainer-approved through the coordinator), each
because it pinned the format G3 replaces: the three `…attachment_link_29xx`
export tests, `export_page_markdown_frontmatter_filters_internal_and_renders_ref_num`,
`import_markdown_frontmatter_round_trips_typed_page_properties_1432`, the asset
paths in `export-graph.test.ts`, the exact lists in `block-utils.test.ts` and
`inline-property-parse.test.ts`, and the asset regex in
`e2e-tauri/export-roundtrip.e2e.ts`. `markdown_documents.export.txt` was
regenerated.

New tests, each shown red by breaking the code it covers:
`restore_placement_tests.rs` (the restore, a missing file, paste and Edit as
Markdown keeping the line as text), `append_markdown_keeps_an_attachments_line_as_text`,
and the `assets/<id>/<name>` case in `export-graph.test.ts`.
