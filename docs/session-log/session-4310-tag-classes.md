# Session 4310 — Properties for tagged blocks, the classes slice of #6755

This is the first slice of #6755. The maintainer chose "suggested properties" over Logseq's stamped class properties. A tag's internal `tag_properties` list names keys, and every block tagged directly with that tag, or with a tag nested under it by name, is offered those keys as empty typed rows. Nothing is written for a suggestion. The maintainer added *Set on tagged blocks*: one key and one value on every tagged block, with preview counts, one atomic write and one Undo. The paired `Tag/` page is the next two slices.

**Decisions:**
- `tag_properties` is the one internal key that takes a list.
- Its items are property keys that are neither built in nor internal. Built-in keys live in columns, and `todo_state` writes through its own path.
- The bulk write cannot use `set_property_batch`, which has an allow-list of four keys and a cap. `set_property_on_tagged_blocks` selects the tag page's set itself inside `BEGIN IMMEDIATE`. It recounts against the preview, refuses more blocks than `MAX_REVERT_OPS`, and appends ordinary `SetProperty` ops, whose refs `undo_ops` reverts in one step.
- Ref keys and keys that hold several values are not offered for Set on tagged blocks, because their editors write to one block.
- The list is not exported (a tag has no file), and renaming or merging a key does not rewrite it.

**Traps:**
- `ConfirmDialog` closes once an async `onConfirm` resolves. A recount on a stale acknowledgement must therefore throw into it, or the new counts are lost (the review caught this).
- A hand-written mock test that repeats a fixture belongs in the fixture: e2e/AGENTS.md says so.
- #6545 S2a replaced `watchLocalWrites` with the change feed while this was in flight, so a new preview command goes in the mock's `READ_ONLY_EXACT` list in `change-feed.ts`.
- Do not hard-link-copy a `target` dir to get a second build lane. Cargo rewrote shared fingerprint files in place, and the copy linked a stale `agaric-core` that cargo thought fresh. `cargo clean -p` the workspace crates if it happened.

**What ran:**
- Rust: workspace nextest in two partitions on the builder's tree; clippy `-D warnings`, fmt and the offline check; on the review tree, after cleaning the stale crate, the targeted filters (125).
- vitest across pages, properties, the drawer, the mock and i18n after the rebase onto `main`; typecheck.
- e2e: `e2e/tag-suggested-properties.spec.ts` and the tag and property mock specs.
- Not run: the real-backend lane.
