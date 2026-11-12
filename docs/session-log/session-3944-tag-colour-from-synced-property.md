# Session 3944 — Tag colour from the synced property; query `columns` survive a Rust round-trip

Two items from #6544.

**Tag colour.** A tag chip now paints the tag's `color` property and falls back to the
localStorage map only when the property is absent; the local map stays (deleting it is the
follow-up the issue names). The colours live in a new `tagColors` field on the existing resolve
store, refreshed on every preload with one `getBatchProperties` over the tag ids the preload's
`listAllTagsInSpace` already returned (chunked at `MAX_BATCH_BLOCK_IDS`, legacy hexes
migrated as the local map does). `useTagColors` records a colour as synced only once its
`setProperty` / `deleteProperty` commits. The three paint sites read synced-then-local: the static
chip (`marks/tagRef.tsx`), the editor node view (`tag-ref.ts`) and the Tags view (`useTagColors`).

Why this path: adding `color` to `TagCacheRow` would touch every `query_as!(TagCacheRow, …)` in
`tag_query`, the bindings, the mock, a conformance fixture and every frontend `TagCacheRow` fixture literal. The
batch read needs no Rust change. Trap: the strict invoke fallback (`src/test-setup.ts`) fails any
test whose preload lists tags without stubbing `get_batch_properties`; three suites needed the stub
(`resolve.test.ts`, `resolve-store-title-seed-parity.test.ts`, `useImportRunner.test.tsx`), and
`TagList.test.tsx` now resets `tagColors`, which otherwise leaks between its tests.

**Query `columns`.** `InlineQuerySpec` (`commands/pages/inline_query_md.rs`) gained
`columns: Option<Vec<String>>` (`serde(default, skip_serializing_if = "Option::is_none")`). serde
ignored the unknown field on decode and the re-encode dropped it, so Markdown export/import lost a
query table's chosen columns. A payload without `columns` re-encodes byte-identical. The test
builds that payload byte by byte: `serde_json::json!` sorts keys, so it cannot.

**Checks run.** Red first: the Rust round-trip test (`left: Null`), the resolve, hook, chip and
node-view vitests. Falsified: the `skip_serializing_if` (byte-identical test reds), the
localStorage fallback in both chips, and the static chip's synced read (the new `e2e/` test reds
on the static chip's colour). The new `e2e-tauri/tag-color-synced.e2e.ts` was not run here (no
built binary or `tauri-driver` in the container); `typecheck:e2e-tauri` and its vitest pass.
