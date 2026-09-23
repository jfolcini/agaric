# Session 1811 — markdown source mode, phase 3a

Phase 3a of #5140 moves Duplicate (`Ctrl+Shift+J`, the context-menu row, `/duplicate`) to one backend command, `duplicate_block`. I re-planned against the code before building. The re-plan comment on #5140 records what changed from the 08:32 plan and why.

**Today's defect.** Duplicate serialised the block in TS and pasted the text back through `parseIndentedMarkdown`, which splits on every newline. So a multi-line block, such as a code block, came back as one block per line. Every copy also lost its task state, priority, dates, list style and properties, and a literal `#5` or `[[x]]` in the text created a tag or page. The new Playwright spec fails on the old code in exactly these ways: a two-line code block came back as four blocks, and a TODO copy had no `todo_state`.

**Backend.** `duplicate_block_inner` does everything inside one `BEGIN IMMEDIATE` transaction:
- It renders the block's subtree as a source buffer, with anchors and an empty `NameSnapshot`, so refs stay raw. `render_subtrees` is now shared with the page render.
- It parses the buffer with `parse_source_outline`.
- It creates the copy right after the original and ignores the parsed anchors.
- It writes properties through `apply_block_properties`, which gains a flag that sends ref-declared keys to `value_ref`. Import passes the flag off, so import is unchanged.
- It gives a task copy its #5074 `created_at` or `completed_at` stamp.

It refuses anything over 1000 planned ops, the same cap as one undo, and returns every created row under `capture_op_refs`. The anchors stay in the rendered buffer because the anchor line is what ends an unterminated fence (#5152). Without it, the child of an open code block folds into the code.

**Frontend.** All three entry points now `await flushActiveDraft()` and call the store's `duplicateBlock`, which notifies undo once and reloads. The mock copies rows directly and skips the same keys the backend's render leaves out. A conformance fixture pins both sides; its expected results were authored by the backend. It covers:
- a closed fence;
- an open fence with a child;
- a ref property;
- the task columns and list style;
- three refusals: an unknown id, a page and a trashed block.

**Also landed.** The #5152 review note: `push_anchored_source_bullet` now renders the anchored bullet once and re-renders only when the last line is code. Output is byte-identical.

**Review.** An independent reviewer found one blocking defect and one silent-corruption case. Both are fixed, and each fix has a test that fails without it:
- **Stale values failed the whole copy.** Copying re-validated every value against its key's options today. So a block whose priority was "3", on a vault whose priority levels had since been narrowed to 1–2, failed to duplicate at all. So did a select value whose option was later retired. The old path never failed here, because it copied no properties. A copy now re-stores an accepted value without re-checking options.
- **A value with a line break mangled the copy.** A property value containing a newline (MCP can write one) read back as extra content, or as a second root block that re-parented the copy's children. The copy now refuses unless every parsed block reads back the anchor it was rendered with, in order.

The reviewer also caught:
- The e2e-tauri spec waited for two static rows, but the original keeps the editor, so it would have timed out.
- A useless `load()` in the store's failure branch.
- The mock's fifth copy of the reserved-key list. The mock now reuses `INLINE_PROPERTY_RESERVED_KEYS`.

**Named gaps, unchanged from before this phase.** A value whose key has no definition comes back as text. Explicit tags, attachments and `repeat*` are not copied. A property value with a newline or surrounding whitespace doesn't survive the grammar.

**Verified.**
- The workspace nextest filter `duplicate_block|source|markdown|import|export|conformance|properties` passes 574 of 574, and clippy is clean.
- Both conformance sides pass: all fixtures in Rust, and the tauri-mock suite in TS.
- vitest passes on every touched suite, and `e2e/block-duplicate.spec.ts` passes 3 of 3.
- `e2e-tauri/block-duplicate.e2e.ts` is unrun locally, because that lane needs a native build.
- Every new test was falsified against a copy. Each carried item, the placement, the ref arm, the stamps, the op cap, the depth rollback, the refusals, the flush ordering and the undo entry were each reddened by a mutation.

**Disk.** The Rust builder's incremental cache reached 11 GB and twice pushed free disk under 2.5 GB. Pruning stale session dirs between compiles and switching to `CARGO_INCREMENTAL=0` held it.
