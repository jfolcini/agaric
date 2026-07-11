## Session 1151 — extend fuzz + property coverage to importers & codec (#2590) (2026-07-11)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-11 |
| **Items closed** | `#2590` |
| **Dimension** | robustness / raw-input parsers |
| **Tests added** | +6 (2 Rust proptests strengthened/added, 1 Rust fuzz target, 2 TS property suites = 4 property tests) |
| **Files touched** | 8 |
| **Schema / wire-format** | none |

**Prompt:** Bun's Rust-rewrite writeup (https://bun.com/blog/bun-in-rust) reports
that their most durable safety net was coverage-guided fuzzing over **every**
parser. Agaric fuzzed only two byte-level parsers (`snapshot_decode`,
`deeplink_parse`) and the importers landed since (#1282: Obsidian/ENEX/JEX)
had example-based tests only. This closes the gap.

### Part A — snapshot codec round-trip proptest (strengthened)
The `snapshot_cbor_roundtrip` / `snapshot_encode_deterministic` proptests already
existed, but `arb_snapshot_data` hard-coded `property_definitions` and
`page_aliases` to empty and `block.space_id` / `attachment.deleted_at` to `None` —
so a dropped column in any of those four fields round-tripped clean and went
uncaught. Fixed by:
- new `arb_property_definition` + `arb_page_alias` strategies, wired into
  `arb_snapshot_data` (both tables now populated 0..3 rows);
- `arb_block_snapshot` now varies `space_id` (nested 2-tuple to stay within
  proptest's 10-arity tuple limit);
- `arb_attachment` now varies `deleted_at`.
Also re-exported `PropertyDefinitionSnapshot` / `PageAliasSnapshot` from
`snapshot/mod.rs` so the strategies resolve via `super::*`.

### Part B — import parser fuzz target + proptest
- New libFuzzer target `src-tauri/fuzz/fuzz_targets/import_parse.rs` over
  `parse_logseq_markdown` (the arbitrary-text boundary for Obsidian/vault/ENEX/JEX
  → Markdown import). Registered as a `[[bin]]` in `fuzz/Cargo.toml` and added to
  the scheduled `fuzz` lane's target loop.
- New `import::parse_proptest` module: generates plausible Logseq/Obsidian
  Markdown (indented bullets, `key:: value`, trailing `^block-id` anchors, fences)
  and asserts the structural contract — never panics, `depth <= MAX_IMPORT_DEPTH`,
  and a block anchor is non-empty and caret-free when present — plus a
  fully-arbitrary-`.*` no-panic property.

### Part C — ENEX / JEX frontend property tests (fast-check)
libFuzzer can't reach the TypeScript parsers, so:
- `src/lib/__tests__/enex-import.property.test.ts` — arbitrary strings either
  return an array or throw a clean `Error` (never a non-array / hang); well-formed
  ENEX round-trips note count, titles, and tags.
- `src/lib/__tests__/jex-import.property.test.ts` — arbitrary `Uint8Array` never
  throws and always returns `{ notes: [], skipped }` (the hand-rolled USTAR tar
  reader + classifier degrade gracefully); a well-formed archive round-trips note
  count and titles.

**Verification:**
- `cargo test --lib snapshot_cbor_roundtrip snapshot_encode_deterministic` → ok.
- `cargo test --lib parse_proptest::` → 2 ok.
- `vitest run enex-import.property jex-import.property` → 4 ok.
- Fuzz target mirrors the two existing targets (same `agaric_lib::…` pub entry,
  same no-panic contract); it runs in the weekly nightly `fuzz` lane, not per-PR.

**Files touched:**
- `src-tauri/src/snapshot/mod.rs` — re-export two row types.
- `src-tauri/src/snapshot/tests.rs` — strengthen codec round-trip strategies.
- `src-tauri/src/import.rs` — `parse_proptest` module.
- `src-tauri/fuzz/fuzz_targets/import_parse.rs` — new fuzz target.
- `src-tauri/fuzz/Cargo.toml` — `[[bin]]` + machete comment.
- `.github/workflows/scheduled-deep-checks.yml` — fuzz lane target + comments.
- `src/lib/__tests__/enex-import.property.test.ts`, `jex-import.property.test.ts` — new.
