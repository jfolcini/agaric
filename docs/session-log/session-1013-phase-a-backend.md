# Session 1013 — Phase A: backend data-correctness trio (#623/#627/#681)

- **#623** import/batch bound every property as value_text → dated reserved keys
  (due_date/scheduled_date) failed validation. New `typed_property_args_for_string_value`
  (domain/block_ops.rs) routes the date keys to value_date; both callers
  (import_markdown_with_progress, create_blocks_batch_inner) build the typed shape.
- **#627** move_block never enqueued RebuildPageLinkCache → stale cross-page link
  attribution. Added it to the move_block dispatch arm.
- **#681** soft-deleted seeded space block → eternal slow bootstrap. ensure_space_block now
  filters deleted_at IS NULL + upserts ON CONFLICT DO UPDATE SET deleted_at=NULL (restores a
  tombstoned seed), agreeing with is_bootstrap_complete.

Reviewer SHIP (caught + fixed a clippy::type_complexity CI-breaker via a type alias). 967
tests pass, check + clippy clean. One new .sqlx entry (the upsert), 0 deletions; bindings
unchanged. Closes #623 #627 #681.
