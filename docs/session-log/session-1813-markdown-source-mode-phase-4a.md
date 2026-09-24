# Session 1813 — markdown source mode, phase 4a

Phase 4a of #5140 adds `apply_page_source`: the backend command that saves a page edited as its markdown source buffer. There is no UI yet; 4b adds it. I re-planned against the code before building, and the re-plan comment on #5140 has the eleven changes from the body's Phase 4.

**How a save works.** Everything runs in one `BEGIN IMMEDIATE` transaction, which gives one undo entry.
1. **Stale check.** Render the current source with its name snapshot. If it differs from the base the user edited, refuse with `RequiresRefresh`. `force` doesn't skip this.
2. **Read-back check.** Refuse unless the current source (T0) reads back every rendered anchor.
3. **Pair the buffer (T1) by anchor.**
   - A duplicate anchor is refused.
   - An anchor that isn't a block of this page is refused, or, with `force`, saved as a new block with a warning.
   - An unanchored bullet is created, and a rendered block that's missing is deleted.
4. **Diff.** Compare T1 and T0 per anchor, on content and on the property map, before any name is resolved. An unchanged buffer therefore writes nothing by construction, and there's no Rust canonicaliser to lean on.
5. **Names** are resolved only for created or edited blocks. A name the block already held keeps the meaning the render gave it. So fixing a typo next to "issue #42" doesn't create a tag "42".
6. **Placement.** Per parent, among the children the source shows, the longest in-order run of existing ones stays put. The rest are moved or created right after the shown sibling before them. No op names a nested page.
7. **Writes.** Edits, properties and task state go through the existing `_in_tx` writers. Task state goes through a new shared `set_todo_state_in_tx`, which writes the stamps and runs recurrence exactly as the checkbox does.
8. **Deletes** run last. A delete that would take a nested page with it is refused.
9. **Op cap.** Ops are counted as written, against the 1000-op limit.

Source parsing no longer clamps depth: an over-deep save is refused instead. Paste keeps its clamp.

**One design fix before review.** The builders followed my contract and wrote a save's properties with Duplicate's `copying` rule. That rule skips option checks, so a source-mode save would have stored a typed `priority:: 9` that the property editor refuses. Duplicate and paste need the skip, because they re-store values a key may since have retired. A source save only ever writes the properties the user changed. So `apply_block_properties` now takes a three-way `PropertyWrite` mode:
- **Import:** a ref value is text, and options are checked.
- **Copy:** a ref value is the raw id, and options are skipped.
- **Edit:** a ref value is the raw id, and options are checked.

Source saves use Edit. A test pins that a typed value outside the options is refused, while an untouched retired value doesn't block other edits.

**Found and filed: #5155.** Undoing a move of a block created by an append fails with `NonReversible`. Since #400, an append's create op records neither an index nor a position, and the reverse-move lookup treats that shape as an ancient payload. It predates this phase, and it affects moves of blocks made by paste, Duplicate, import and templates. A source save that moves such a block can't be undone in one step until #5155 is fixed. The fix records the append slot in the create op, as its own PR before 4b.

**Review.** An independent reviewer found no blocking defect. It traced every path that could delete or overwrite something the user didn't change, and checked zero ops by construction, the slot arithmetic against the engine, the property keys the render omits, and the depth-clamp change. I fixed four of its findings before pushing:
- **Placement is among visible siblings only.** The first build kept each nested page at its slot, which moved blocks the user never touched. Adding a bullet above a nested page moved a sibling past it. A nested page's place isn't shown anywhere, so the rule went, and the code is smaller for it.
- **A non-id value for a ref-declared key is refused, naming the key.** A typed title in a ref-declared property used to be counted as set, while the projection dropped the row because no block has that id.
- **A new bullet ending in ` ^word`, where the word isn't a block id, stays text.** It used to be refused as "not a block of this page". The mock keeps it as text too.
- **Two tests added.** One asserts the engine rollback when a delete would take a nested page with it. The other moves a block under a bullet created in the same save.

**For 4b's copy.**
- Overwrite (force, with base set to the current source) keeps the user's buffer over everything changed elsewhere since their base. That includes deleting blocks created elsewhere in the meantime, not just the forks and renames the dialog has to name.
- Joining two bullets into one line deletes the first block and moves its anchor text into the second, like any deleted anchor. The hint line should say that anchors are how blocks are kept.

**Conformance.** `apply_page_source.json` was authored by the backend. It covers:
- an unchanged buffer, an edit, a reorder, a reparent, a delete and a create;
- stale-even-forced (`RequiresRefresh`);
- a duplicate anchor, a foreign anchor, a non-page id and an unknown page.

The mock models plain bullets, anchors and structure, not properties or names. Its `get_page_source` now skips nested pages and indents continuation lines, as the backend does.

**Verified.** The full `cargo nextest run --workspace` passed 6469 tests, with 13 skipped, including `ts_bindings_up_to_date` and the conformance fixtures on both sides. `npx vitest run src/lib/tauri-mock` passed 1017 tests. Clippy, `cargo fmt --check`, the rustdoc link check and `npm run typecheck` are clean. Every new or changed test was reddened by a mutation against a copy, and then restored:
- the placement rule, against the pre-fix code;
- the ref refusal and the caret-word text;
- the move under a created bullet, and the nested-page rollback;
- the mock's caret-word rule.
