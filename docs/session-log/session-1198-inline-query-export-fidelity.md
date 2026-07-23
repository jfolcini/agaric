# Session 1198 — Inline query blocks export human-readable & roundtrip-safe

**Date:** 2026-07-23
**Branch:** `fix/inline-query-export-fidelity`
**Closes:** #2968

## Summary

A structured inline query block's content is `{{query v2:<base64url(JSON FilterExpr)>}}`.
Export emitted it verbatim — unreadable in any external tool — and any tag/page ULIDs
embedded in the encoded FilterExpr dangled after re-import (export ULID resolution only
touched plaintext `#[ULID]`/`[[ULID]]`/`((ULID))` tokens, never the base64 blob). This
makes inline queries export human-readable AND roundtrip-safe, symmetric with the existing
ULID handling and #2963's block-ref export.

## Approach (roundtrip-preserving)

The exported form is `{{query v2n:<base64url(spec-with-NAMES)> <plaintext description>}}`:

- The **base64url machine payload** carries the `FilterExpr` with each embedded ULID
  replaced by its resolved **name**. base64url's `A–Za–z0–9-_` alphabet contains none of
  the markdown serializer's escapable chars nor any `#[`/`[[`/`((` token, so it survives
  the export pass losslessly.
- The **plaintext description** renders the query readably for humans/external tools;
  unresolvable refs show `(unresolved)`, never a raw opaque id.

The exported JSON deserializes into the real `agaric_store::filters::FilterExpr` (the TS
`InlineQuerySpec` is specta-generated from it), so no schema was re-implemented. A ref-walk
covers every ULID-bearing field — `Tag.tag`/`TagOrRef.tag` (tag map), `ChildOf.parent`,
`LinksTo.target`, `LinkedFrom.source`, `HasProperty`→`PropertyValue::Ref` (page map),
recursing through `HasParentMatching`/`And`/`Or`/`Not`. Field position encodes the ref
kind, so import needs no in-payload tag-vs-page marker.

## Live-editor representation unchanged

`v2n:` exists ONLY in exported markdown. On import, `rewrite_inline_queries_for_import`
runs FIRST in the block loop (before the `[[Page]]`/`#tag` rewrites), converting `v2n:`
back to canonical `{{query v2:<base64url(ULIDs)>}}` by mapping names → the new vault's
ULIDs (feeding query tag/page names into the existing `resolve_inbound_tags` /
`resolve_inbound_page_links` create-if-missing pre-passes). The DB/editor never store
`v2n`. No TS changed.

## Files

- **new** `src-tauri/src/commands/pages/inline_query_md.rs` — codec (`decode_v2`/`encode_v2`/`v2n`),
  `FilterExpr` ref-walk, export/import rewrites, name harvesters, description renderer + 8
  unit tests.
- `markdown.rs` — export harvest into the existing batched `json_each` title query + query-token
  rewrite in both emit branches; import rewrite (first) + name feed into the inbound
  resolve passes. `mod.rs` — module registration. `page_cmd_tests.rs` — integration roundtrip test.

## Verification

`export_page_markdown_inline_query_tag_roundtrips_2968` (seed tag → export asserts
`tag:rust` + `v2n:` present, original `v2:` payload + raw ULID absent → delete → re-import
into fresh vault → decodes to `Tag { tag: <new id> }`, not dangling) + 8 unit tests.
Non-tautological (neutering the export rewrite leaves the `v2:` payload, failing the
"absent" assertions). Full `cargo nextest` **3297 passed**, clippy clean, `.sqlx` untouched.

## Bounded limitations (documented follow-ups)

`Space.space_id` and non-page block-ref targets have no name↔id map; they keep their id
(best-effort, shown `(unresolved)`) and degrade to an empty-matching leaf on import rather
than crashing — the headline tag/page refs fully roundtrip. Review also noted the plaintext
description repeats a ref's raw name, so an adversarial page/tag title containing literal
`[[…]]`/`#` could read as a link in the description (bounded, consistent with existing
`[[Page]]` behavior; the first-running import rewrite overwrites the query token, so the
stored query is never corrupted) — tracked as a follow-up.
