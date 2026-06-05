## Session 987 — per-block FTS index cap + trigram size doc correction (#435) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#435` |
| **Dimension** | performance / doc (P3 / verified low) |
| **Tests added** | +1 (cap truncates a pathological block, UTF-8-safe) |
| **Files touched** | 3 |
| **Schema / wire-format** | none |

**Summary:** `fts_blocks` is a STANDALONE trigram FTS5 table (migration `0006`):
it stores `stripped` in a shadow content table AND a trigram index (~3x), so
each block's indexed text is duplicated and expanded, with NO per-block size
bound — a pathological pasted multi-MB block was fully trigram-indexed. Two
parts (both the audit's recommended, actionable items; the `detail='column'`
suggestion was rejected as non-actionable — single searched column + append-only
migrations):

1. **Per-block cap:** `strip_for_fts_with_maps` now truncates the indexed text
   at `FTS_MAX_INDEXED_BYTES` (128 KiB) on a UTF-8 char boundary, so one giant
   block cannot dominate the index. Normal blocks (a few KB) are untouched;
   search over a capped block's first 128 KiB still works. Any reasonable cap
   bounds the worst case — it is headroom, not a measured optimum.
2. **Doc correction:** migration `0006`'s "~3x larger but still negligible
   (<100k blocks)" framing is superseded by the cap and is misleading as a
   mobile budget, but cannot be edited in place (append-only / checksummed).
   The authoritative note now lives in `fts/index.rs` (module doc) and
   `fts/strip.rs` (at the cap).

**Files touched:**
- `fts/strip.rs` — `FTS_MAX_INDEXED_BYTES` + `cap_indexed_text` (UTF-8-safe) applied at the strip output.
- `fts/index.rs` — module-doc "Per-block index-size cap (#435)" note.
- `fts/tests.rs` — `strip_caps_pathological_block_indexed_length`.

**Verification:**
- New test: a 1 MiB multibyte (`é`) block is capped to ≤128 KiB on a char
  boundary (all chars intact); a small block is unchanged. `cargo nextest run
  fts::` → **245 passed**. clippy + rustfmt clean.

**Commit plan:** single commit; branched off `main`; PR against `main`.
