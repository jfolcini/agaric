# Session 1852 — Edit as Markdown: block ids travel beside the text (#5160 phase 5-4)

#5160 A, with D15 and D5 on the backend. The UI is unchanged; phase 5-5 builds the TipTap buffer on this.

**What changed.**
- **`get_page_buffer(page_id) -> PageBuffer { source, text, line_ids }`.**
  - `source` is `get_page_source`'s anchored buffer, which stays the staleness fingerprint a save sends back as `base_source`.
  - `text` is the same buffer without its `^ID` anchors, both the one ending a line and the one on a line of its own after a code block. A `^word` that is no block id stays.
  - `line_ids` has one entry per line of `text`: the block's id on the line it starts on, `null` on continuation, property and blank lines.
- **`apply_page_source` takes an optional `line_ids`.**
  - With it, each block is the one whose id the line it starts on carries, and no `^ID` in the text is read: a trailing one is content, and an anchor line in a fence is code.
  - A `line_ids` that is not one entry per line is refused before anything is written.
  - The page's own source is read the same way, anchors removed and ids by line, so saving the page's own text writes nothing. The stale check and `merge` work as before.
  - Without it, the save is unchanged. The store passes `null` for now.
- **D15 on the line-ids path.** A copy is a new block and a cut is a move. An id on a second line stays with the first, and an id that is not a block of the page (another page's, or no ULID at all) is read as none. Each is saved as a new block with a `line N: …` warning. Nothing is refused.
- **D5 on the line-ids path.** An unclosed fence ends before the next line that carries an id, whatever that line looks like, with the existing warning naming both lines. A bullet with no id inside the fence is code. Import and paste keep CommonMark: the fence runs to the end of its list item or of the text.
- **Mock.** `get_page_buffer` and the `lineIds` path are mirrored. The mock's outline parser models fences only when reading by line ids (`fenceTracker`), since D5 needs them there. A new fixture, `apply_page_source_line_ids.json`, drives the own-text, edit, move, wrong-length, open-fence and merge-with-copy-and-foreign-id steps. It reads the resulting buffer back through a new `buffer-lines` query projection, one `id#text` row per line. Bindings are regenerated.

**Worth knowing:**
- The text can't carry two block shapes that only their anchors keep apart. One is content ending in a blank line, which becomes the blank line between blocks. The other is a block that leaves a fence open before its property lines: the property lines read as code up to the next id, and each save warns about the fence. The save reads the page's own source through the same text, so neither causes a write by itself. But editing the second kind by line ids saves its property lines into its content.
- An id on a line where no block starts is ignored, and that line continues the block before it. So the block the id named is deleted, unless some other line starts it. The phase 5-5 editor must keep each id on the line where its block starts.
- The fixture's query pins `text` and `line_ids`, not `source`. The mock ends a code block's anchor at the end of its line, while the backend puts it on a line of its own. Both give the same text.

**Verified.**
- Rust falsification on copies (each mutation env-gated in the three `.rs` files, then restored and `cmp`'d; `P54_MUT` was grepped out of the tree). Every mutation turned tests red; the unmutated build passed 21 of 21.

  | Mutation | Red (of 21) |
  |---|---|
  | R0 no line-ids path (buffer is the anchored source, anchors read, `line_ids` ignored) | 11 |
  | F1 a copied id keeps the id | 2: the copy test, the fixture |
  | F2 a foreign id accepted | 2: the foreign-id test, the fixture |
  | F3 a line carrying an id does not end a fence | 6 |
  | F4 `line_ids` read one line off | 9 |
  | F5 an anchor on its own line kept in the text | 3 |
  | F6 the page's own source read by anchors, not as its text | 1: the own-text proptest |
  | F7 no length check | 2: the wrong-length test, the fixture |
  | F8 anchors read from the text by line | 2: the engine test, the read-back proptest |

- TS falsification on copies against `page-source-apply` and `conformance` (224 tests): every mutation turned tests red.

  | Mutation | Red |
  |---|---|
  | T0 no line-ids path | 10 |
  | T1 no copy check | 4 |
  | T2 no foreign-id check | 4 |
  | T3 no fence stop at an id line | 4 |
  | T4 `lineIds` read one line off | 10 |

- `cargo nextest run --workspace` over the line-ids, buffer, fence, paste/import, page-source and source-outline tests, the conformance fixtures, the bindings check and all of `agaric-engine`: 1184 passed.
- clippy (`agaric-engine`, `agaric`, all targets, `-D warnings`) is clean after one `nonminimal_bool` fix in the read-back proptest's filter. `cargo fmt --check` is clean, and so is `cargo doc` with the pre-push rustdoc lints. No `.sqlx` change.
- vitest: `page-source-apply`, `conformance`, `conformance-coverage`, `PageSourceEditor` and `page-blocks.page-source`, 303 passed; the paste, clipboard, names, import and `tauri-mock` files that run the mock's outline parser, 411 passed. `npm run typecheck` is clean.
