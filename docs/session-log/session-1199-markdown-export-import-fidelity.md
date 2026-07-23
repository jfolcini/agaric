# Session 1199 — Markdown export/import fidelity: page attachments + typed descendant properties

**Date:** 2026-07-23
**Branch:** `fix/markdown-export-import-fidelity`
**Closes:** #2991, #2982

Two grouped fidelity fixes in `src-tauri/src/commands/pages/markdown.rs` (follow-ups to the
#2961/#2962 export/import work), kept separable in the diff.

## #2991 — page block's own attachment dropped from export

`export_page_markdown_inner` batch-fetches attachments for the page block AND descendants
(the page id is in the id list, #2961), but only the DFS-descendant and orphan loops
emitted `- [filename](attachment:<id>)` lines — the page block (root) is iterated by
neither, so an attachment attached directly to the page/title block was fetched but never
emitted (dropped).

**Fix:** after the frontmatter fence and before the descendant bullets, emit the page
block's own non-inline attachment link lines from the already-fetched `attachments_by_block`
map (no new query), deduped with the exact same `content.contains("attachment:<id>")` check
the descendant/orphan loops use (an inline-referenced attachment isn't double-emitted),
unindented (depth 0 — the page has no owning bullet). `page.content` is cloned so the title
emission is unchanged.

## #2982 — typed descendant custom properties aborted the import

On import, descendant body `key:: value` lines went through the non-registry-aware
`typed_property_args_for_string_value` (always `value_text`), unlike the frontmatter path
(`typed_property_args_for_registry_value`). This was filed as a lossy-typing roundtrip, but
review confirmed it is **worse**: `set_property_in_tx` internally re-fetches the
`property_definitions` row and validates, so importing a descendant block with a
registry-declared **non-text-typed** custom property (e.g. `score` declared `number`)
**aborts the entire import** with `Validation { "Property 'score' expects type 'number',
got 'text'" }`.

**Fix:** route the descendant body-property loop through a `property_definitions` lookup
(global table, `key TEXT PRIMARY KEY` — no space plumbing needed) +
`typed_property_args_for_registry_value` + `set_property_in_tx_with_declaration`, so typed
custom properties import with their declared type. Zero extra queries — the same
`SELECT value_type, options FROM property_definitions WHERE key = ?` was already run
internally by `set_property_in_tx` (for validation, discarding the type); the fix hoists and
reuses it (`.sqlx` unchanged). Undeclared keys fall back to `value_text`; `ref`-typed keys
are unchanged (fall through to text). The frontmatter property path is untouched.

## Verification

4 new tests: page-own-attachment emitted top-level, page-own-inline-attachment deduped
(#2991); typed descendant property round-trips (`value_num == Some(42.0)`, `value_text ==
None`), undeclared descendant property still `value_text` (#2982). Both non-tautologies
reproduced (reverting #2991 drops the link; reverting #2982 aborts the import with the
Validation panic). Broad nextest **2032 passed, 0 failed**; clippy clean; `.sqlx` unchanged.
