# Session 1856 — Edit as Markdown saves by line ids only (#5160 phase 5-5c)

Phase 5-5a's buffer saves by per-line ids, so the anchored save path is gone. This is mostly a deletion.

**What changed.**
- **`apply_page_source` takes `line_ids`, always.**
  - The command is `(page_id, source, base_source, merge, line_ids)`. `line_ids` is a plain list, and `force` is gone.
  - No `^ID` in the text is read. Deleted: `read_anchored`, `heal_moved_anchors` (with `moved_anchors`, `MOVED_ANCHOR_RE` and `without_token`), and the anchored branches of `read_buffer` and `read_own_source`.
  - `pair_blocks` lost its two refusals, an id written twice and an id that is not the page's, and the `force` fork. `read_by_line` already turns both into a new block with a `line N:` warning (D15).
  - The merge's own "written twice" refusal is gone too, so `merge_outlines` cannot fail. `Side::new` no longer calls `restore_text_anchor`, since an id beside a line is already a block id.
  - `source`, the anchored render, stays as the staleness fingerprint and as `anchor_free`'s input. `restore_text_anchor`, `parse_source_outline` and `render_page_source_ids` stay: paste, copy, Duplicate and import still read `^ULID` anchors.
- **Overwrite** sends the page's current source as the base and no flag. A line whose block was deleted on the page is saved as a new block, with a `line N: not a block of this page` warning.
- **The conflict dialog lists blocks without ids.**
  - `page-source-diff.ts` diffs `text` and `line_ids`: a block runs from its id line to the next id line, and the lines above the first are the front matter.
  - So the editor keeps the whole `get_page_buffer` it started from, and a draft stores that buffer as its `base`. A draft in 5a's never-released `{ base: string, text, lineIds }` shape is ignored. The pre-5a shape still shows read-only (D-f).
- **Mock.** The anchored apply path, its heal and the foreign-anchor fork are deleted, so `apply_page_source` reads by line only.
- **Fixtures.** The four `apply_page_source*.json` fixtures send `lineIds` and `merge`, and `conformance_command.rs` requires both.
  - Removed steps: the lowercase-anchor, two-moved-anchors, duplicate-anchor and foreign-anchor steps (with their S7/S8 seed), the by-line front matter refusal (now the same as the plain one), and the merge's text-after-a-moved-anchor step (with its delete).
  - The moved-anchor steps that still describe behaviour were rewritten by line: text typed on a line, a line typed under a block, and the merge's line under a moved block.
- `useDebouncedCallback`'s `schedule` takes an optional value, so the draft saver calls `schedule()` without the text it ignores (#5221 review).

**Worth knowing:**
- The command tests write edited buffers in the anchored notation and save them through `anchor_free`, now `pub` for that, so most of them ported by dropping the `force` argument. An input that only the heal read as its block (`- weekly ^ID` above a reserved `repeat-seq::` line) was rewritten by line.
- `pair_blocks` returns an error, not a panic, if an id it sees is not the page's: release builds abort on a panic. `read_by_line` keeps only ids in the page's source or the base's, and the merge drops every id the page no longer holds.
- The anchored round-trip proptest, ported to the by-line reading, skips a buffer holding a block the text cannot carry (`text_carries`, as `markdown_source_tests` does): content ending in a blank line, or leaving a fence open before property lines.
- At 4000 cases that proptest found a parser bug. Logseq's page properties (#5160 P3) took a first bullet reading `- :: value` as a page property keyed `-`, a valid key.
  - So a page whose first block starts with `::` could not be saved from Edit as Markdown: its source read back as no block and was refused.
  - An import lost that bullet to a page property.
  - `strip_leading_properties` now stops at a bullet. `a_first_bullet_shaped_like_a_property_is_a_block` pins it; it and the proptest's saved seed go red without the check.

**Verified.**
- `cargo nextest run --workspace` over the page-source, outline, merge, line-ids, `get_page_buffer`, front matter, paste, duplicate, copy and clipboard tests, `page_cmd_tests`, `agaric-engine`, the conformance fixtures, the bindings check and the write-sweep denominator: 1510 passed.
- clippy (`agaric-engine`, `agaric`, all targets, `-D warnings`) and `cargo doc` with the pre-push rustdoc lints are clean. No `.sqlx` change.
- vitest: `PageSourceEditor` (with the dialog), `page-source-diff`, the mock's `page-source-apply` and `names`, `conformance`, `conformance-coverage`, `page-blocks.page-source` and `useDebouncedCallback`, 335 passed. `npm run typecheck` and knip are clean.
- Playwright `e2e/page-source-edit.spec.ts`: 11 of 11 with `--workers=2`. The Overwrite case now also checks that the conflict row holds no `^`.
- Falsification on copies (restored and `cmp`'d):

  | Mutation | Red |
  |---|---|
  | `read_by_line` reads `line_ids` one line off | 46 of 137 page-source, front matter, merge and line-ids tests, the own-text proptest and the conformance fixtures |
  | No stale refusal, as an Overwrite that skipped it would be | 4: the by-line stale test, the merge's stale step, the renamed-link test, the fixtures |
  | The conflict dialog given the anchored sources | 2 editor tests (the conflict list, the restored draft's list) |
  | Overwrite sends `merge` (skips the stale refusal) | 1 editor test |
  | A draft stores its base as the source string | 2 editor draft tests |
  | The mock reads `lineIds` one line off | 42 of 237 mock, conformance and names tests |
  | The diff keys blocks by bullet text, not ids | 5 (2 diff, 3 dialog and editor) |
