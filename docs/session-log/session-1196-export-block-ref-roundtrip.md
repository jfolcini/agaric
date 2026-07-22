# Session 1196 — Human-readable, roundtrip-safe export of `((ULID))` block refs

**Date:** 2026-07-23
**Branch:** `fix/export-block-ref-roundtrip`
**Closes:** #2963

## Summary

The editor serializes block references as `((ULID))` and the backend treats
`[[ULID]]`/`((ULID))` as first-class links (`ULID_LINK_RE`), but
`resolve_ulids_for_export` only handled `#[ULID]` (tags) and `[[ULID]]` (page links) — so
exported markdown carried opaque `((01H…))` tokens that render nowhere, and on re-import
`strip_block_refs_counted` stripped every `((…))` token (only an aggregate lossy warning),
losing the reference entirely. This makes block refs export human-readable and
roundtrip-safe.

## The change

- **`agaric-store/src/cache/mod.rs`** — new `BLOCK_REF_RE` (`\(\(([0-9A-Z]{26})\)\)`), a
  block-ref-only sibling of `PAGE_LINK_RE`.
- **`commands/pages/markdown.rs`** — a third export-resolution pass (after tags → page
  links) rewrites `((ULID))`:
  - **Same-page** target → emit `[[#^<ULID>]]` (intra-note anchor link) AND stamp a
    ` ^<ULID>` marker on the target block's own exported line (anchor id = the target's own
    ULID; satisfies the importer's `^[A-Za-z0-9-]+` grammar). On re-import,
    `strip_block_anchor_marker` → `block_anchor`, `[[#^<ULID>]]` → empty-base
    `pending_block_anchor_links` → `anchor_to_block_index` → rewritten to a real
    `((<new ULID>))` — a genuine block-ref roundtrip.
  - **Cross-page** target → emit `[[<Target Page Title>#^<ULID>]]` (renders in Obsidian;
    re-imports as a page link with the #1282 dropped-anchor **warning** — loud, not
    silent).
  - **Dangling/missing** target → `(unresolved block reference)` (never a raw ULID).
  - A batched `SELECT … LEFT JOIN blocks p ON p.id=b.page_id` resolves each target's page +
    title in one query (mirrors the tag/page batching). The editor's internal `((ULID))`
    form is unchanged (transformation is export-only).

## Scope

`Closes #2963`: no export path emits a raw `((ULID))` anymore, and there is no silent data
loss. Same-page refs fully roundtrip to a block ref; cross-page refs are human-readable +
warned. Cross-page block-ref *restoration* (resolving `[[Other#^id]]` to an existing block
on an already-present page) is a documented follow-up — it needs a persistent cross-note
anchor index (the #2510 open design question). A minor cosmetic follow-up was noted in
review: a same-page ref whose target is a fenced code block leaves a stray ` ^<ULID>` on
the closing fence (the importer skips `is_code` blocks in the strip pass); it degrades
loudly to a warned page link, no data loss — a symmetric `is_code` skip on the stamp side
is the fix.

## Verification

3 new tests in `page_cmd_tests.rs`: same-page roundtrip (asserts `[[#^TARGET]]` +
`… ^TARGET`, `!contains("((TARGET))")`, then re-imports and asserts the ref is restored to
`((<new id>))` with no warning), cross-page human-readable, dangling marked unresolved.
Non-tautological (the pre-fix raw-`((ULID))` output fails the same-page assertion).
`.sqlx` regenerated cleanly (1 new query, no warm-wipe). Rebased onto current origin/main
(post the #2928 import decompose + #2988 export-attachment changes to the same file) and
re-verified: `cargo check` clean, targeted export/import/roundtrip nextest **193 passed**,
`cargo clippy --lib` clean.
