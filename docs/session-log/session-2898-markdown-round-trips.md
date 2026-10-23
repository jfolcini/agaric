# Session 2898 — quoted aliases round-trip, page names fold like tags, one attachment-ref vectors file

#6052, three round-trip slips in Markdown import and export.

**Quoted aliases and tags.** The exporter writes a front-matter alias or tag holding `"` or `\` as a double-quoted flow item with those two escaped. The importer's `flow_item` kept the escapes literally, so `C:\Users` came back as `C:\\Users`. It now decodes `\\` and `\"`. The exporter also escapes `\n`, `\t` and `\r`, which still come back as literal text; its doc comment says so.

**Page names fold like tags.**
- `[[über]]` did not find page `Über`: page-name resolution folded ASCII only, while tags fold with NFC plus Unicode lowercase (`normalize_tag_name`).
- `snapshot_page_link_matches` now reads every title and alias and keys them by that fold. Paste, import, source save, property refs and MCP `match_page_names` all resolve through it, so they agree.
- The mock (`findPage`, `findTitled`) and `PageSourcePreview` fold with `normalizeTagName`, now in `src/lib/name-tokens.ts`. Shared `pageNameFoldCases` rows in `conformance/reference-tokens.vectors.json` pin both sides, including the #6092 look-alike slashes, which must not fold to `/` or `\`.
- Review found that two aliases of one page that fold alike (`Ärger`, `ärger`; the `NOCASE` index keeps both) became a tie, so the link stayed text. `LinkMatches::push` now skips an id it already holds.
- Two pages whose names fold alike are a tie on every path: the link stays text with a warning, never the wrong page. An existing vault can hold such a pair, since the `NOCASE` indexes fold ASCII only.

**Attachment refs.** `conformance/attachment-refs.vectors.json` is read by both the Rust importer's tests and `import-attachments.ts`'s, replacing a "MUST stay in sync" comment. The rows #6032 still owes (refs with spaces, `)`, `%20`, `<…>`) carry a note and pin today's behaviour.

**Cost.** The snapshot now reads every page row and folds it in Rust, where it filtered in SQL before. No SLO probe or perf gate times these paths, so `bench-slo` was not run. The reviewer's release-mode estimate is well inside the interactive target; bulk import pays it per file. An ASCII fast path in `normalize_tag_name` is the follow-up.

**Shown red:**
- `flow_item`'s decode off: the quote/backslash round-trip test returns the escaped strings.
- The snapshot keyed by `to_ascii_lowercase`: `paste_blocks_folds_a_names_case_beyond_ascii` creates an `über` page. On the mock, dropping NFC from `findTitled` reddens the NFD vectors row.
- `MARKDOWN_IMAGE_RE` loosened: the attachment-ref vectors test matches a titled image ref.
- The `push` dedupe off: `paste_blocks_links_a_page_whose_aliases_fold_alike` leaves `[[ÄRGER]]` as text.

**Not here:**
- the `[[` picker's typed-link match (`matchBlockLinkItem`) lowercases without NFC, so typing an NFD name creates a new page;
- `resolvePageByAlias` (search and PageBrowser alias hits) still folds with `NOCASE`.

**Suites:**
- the whole workspace under nextest;
- clippy, fmt and `SQLX_OFFLINE` check; the four `sqlx prepare --check` lanes;
- conformance fixtures, backend-authored;
- vitest over `src/lib`, `src/editor` and `src/components/pages`;
- typecheck and lint.
