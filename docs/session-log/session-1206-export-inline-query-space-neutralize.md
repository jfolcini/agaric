# Session 1206 — Export inline-query descriptions: resolve Space ids & neutralize adversarial ref names

**Date:** 2026-07-23
**Branch:** `fix/export-inline-query-space-id`
**Closes:** #3027

## Summary

The human-readable `<desc>` an inline-query block emits on export could (1) surface a raw
`space:<ulid>` string when a filter used the `Space` primitive, and (2) re-emit a page/tag
title verbatim, so a page literally titled `[[Injected]]` or `#cmd` round-tripped back into a
live `[[…]]` link / `#tag` on the next import. Only the machine `v2n:` base64url payload is
authoritative on re-import; the human description is meant to be inert prose. This hardens it.

## The change (`commands/pages/inline_query_md.rs`)

- **`Space` primitive now resolves to a title.** It looks the space ULID up in the existing
  `page_titles` map (a space block is stored `block_type = 'page'`, so its title is already in
  that batch-resolved map) and renders the name — or `(unresolved)` when absent — never the raw
  `space:<id>`. New `collect_space_ulids` folds space ULIDs into `collect_export_ref_ulids` so
  the batch SQL resolve covers them; it recurses through `And`/`Or`/`Not` and the one nesting
  primitive (`HasParentMatching`), mirroring `describe`'s recursion.
- **`neutralize_ref_name(name: &str) -> String`.** Every resolved name routed into the human
  description now passes through this: it inserts a single space inside any adjacent `[[` / `]]`
  pair and after a `#` immediately followed by a word char. Because it only ever *inserts*
  spaces (which separate, never join), and the three importer regexes in `markdown.rs`
  (`HUMAN_PAGE_LINK_RE`, `HUMAN_TAG_RE`, `HUMAN_MULTIWORD_TAG_RE`) each require one of exactly
  those three adjacencies, no page/tag token can survive and none can be forged. `readable_ref`
  changed `&str` → `String` to carry the neutralized result across all resolved arms
  (Tag/TagOrRef/ChildOf/LinksTo/LinkedFrom + `PropertyValue::Ref`).
- **Machine payload untouched.** `walk_primitive`'s catch-all arm still excludes `Space`, so
  `space_id` is never rewritten; `encode_spec_b64(&spec)` is byte-identical to before. The
  neutralized text only ever feeds `sanitize_desc` → the human `<desc>`, and `sanitize_desc`
  collapses whitespace *runs* but preserves single spaces, so it does not undo the inserted
  spaces.

## Tests

Five non-tautological tests: adversarial `[[Injected]]` / `#cmd` / `#[[multi]]` titles come back
inert; a `Space` filter renders the space name (and `(unresolved)` when the id is missing); the
`v2n:` payload still decodes to the raw `space_id`. Verified non-tautological by neutering
`neutralize_ref_name` to a no-op — both adversarial assertions fail, the plain-name control still
passes.

## Verification

Independent adversarial review traced `neutralize_ref_name` against every importer regex with
inputs `[[[[Injected]]]]`, `[[A]] [[B]]`, `#[[Injected]]`, `##foo`, `#foo#bar`, and Unicode tags
(`#café`, `#Ω`, `#日本語` — `char::is_alphanumeric()||'_'` is a superset of the regex first-char
class, so coverage direction is correct); no adversarial title survived, only benign
over-neutralization (`C#foo` → `C# foo`). Roundtrip payload confirmed byte-identical; recursion
in `collect_space_ulids` confirmed to reach every nested `Space`. `cargo nextest`
(inline_query/export/markdown/describe/readable_ref): **100 passed, 0 failed** (5 new);
`cargo clippy --workspace --lib --tests -- -D warnings` clean; `cargo fmt --check` clean.
