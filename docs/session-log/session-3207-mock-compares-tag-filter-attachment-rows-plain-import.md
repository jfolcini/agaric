# Session 3207 — the mock compares the page-link tag filter, added attachment rows and plain import

#6054 closed with three things the conformance harness did not compare between the backend and the mock. The maintainer asked for them to be compared.

**`list_page_links` `tagIds` filter.** The new fixture `page_links_tag_filter` tags targets four ways: through a `#[tag]` ref in a page title, directly, by inheritance from a parent page, and not at all.
- The mock read direct tags only and returned 1 of the backend's 3 edges.
- It now reads `refInclusiveTags` plus `inheritedTagIds`, the union `search.ts` already uses. This matches `fetch_page_link_edges`.
- The nested page is seeded rather than created, because the harness space has no `is_space` row, so `require_live_space_in_tx` refuses every page create there. `create_page_in_space_inner` produces the same shape.

**Added attachment rows.** An op-added row now projects as its `An` label plus block, filename, mime type and size, on both runners (`attachment_added_rows`). There was no divergence; a mutated mime type turns it red.
- `content_hash` (blake3 on the backend; the mock stores none and no frontend code reads it) stays uncompared.
- So do the minted id, path and clock, and the bytes on disk.

**Plain import.** `import_markdown_plain` imports plain paragraphs and a link to a trashed page. The mock diverged in three ways:
- it logged no ops;
- it numbered blocks from 0;
- it wrote the link to the trashed target, where the backend owes it.

The mock now appends the backend's op sequence in order, ranks the page, and indexes links. The grammar stays Rust-only (#5071), so no grammar was ported.

**Review.** A separate reviewer confirmed:
- the tag union matches the backend SQL;
- the attachment twins are symmetric;
- the import op order matches the backend digest, not just the count.

It flagged two wording nits, both fixed here.

**Suites:** conformance nextest; vitest over `src/lib/tauri-mock` and the import tests; typecheck, knip, clippy and fmt; Playwright `import-export`, `graph-view` and `graph-happy-paths`.
