# Session 1168 — Orphan-tag adoption hydrates into the space engine (#2674)

## Scope

`add_tag`'s orphan-adoption arm moved an orphan block (and its page children) into
the tagging space by writing `space_id` with an inline
`sqlx::query!("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")`. That
touched only the SQL projection — the block was never hydrated into the destination
space's Loro engine, leaving engine/SQL drift (the #1323/#2326 class).

## Change

`src-tauri/src/commands/tags.rs` — `apply_tag_to_block_resolved` orphan-adoption arm:
replaced the inline UPDATE with
`crate::materializer::apply_op_projected(tx, &set_space_record, state, false)`, routing
the space move through the same `SetProperty(space)` op the rest of the system uses. The
projected path (`project_set_property_to_sql`) runs the byte-identical
`UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?` — same block + page-child
coverage — and additionally hydrates the tag subtree into the space engine
(`hydrate_page_subtree_into_engine`). The `false` flag (LOCAL path, no apply-cursor
advance) matches the sibling `AddTag` `apply_op_projected` call in the same function.

The one behavioral delta — the projected path's #708 registered-space guard — is always
satisfied here: `src_space` is a registered space (migration 0089 FK
`blocks.space_id REFERENCES spaces(id)`), so behavior is identical and strictly safer.

## Tests

`src-tauri/src/commands/tests/tag_cmd_tests.rs` — `add_tag_orphan_adoption_hydrates_tag_into_space_engine`
asserts the destination space's engine sees the adopted block
(`for_space(space_id).engine_mut().read_block("F26_TAG").is_some()`), reading the same
registry the apply mutates.

## Review

Independent consolidation + adversarial review: SQL parity confirmed byte-identical (both
block and `page_id` children covered); accessor chain verified via symbol lookup; no new
raw/dynamic SQL (removes a raw write — improves #110/#646 compliance). Full suite 3471
passed / 0 failed / 6 skipped; clippy `-D warnings` clean; `sqlx prepare --check` green
(no `.sqlx` change — the removed query shares its cache entry with the still-present
projection query).

Closes #2674.
