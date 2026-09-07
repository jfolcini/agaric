# Session 1570 — A moved page keeps its task dates on the paired device

Closes #4801, found in the #4679 review. `move_blocks_to_space_inner` reassigns a page's `space`, and `apply_set_property_via_loro` then prunes the page's subtree from the old space's doc and seeds it into the new one through `hydrate_page_subtree_into_engine`. That seed replayed `block_properties` and `block_tags` only; its comment said the reserved keys "need no engine property" because they are `blocks` columns. But the engine does hold them — `apply_set_property_typed` runs for every non-`space` key — and the peer's `reproject_block_properties_from_engine` replaces all four columns (`todo_state`, `priority`, `due_date`, `scheduled_date`) from the doc, NULL for any key absent. So the new doc shipped the tasks without their dates, and on the paired device they left the agenda.

The two-device test in `spaces/tests.rs` (next to the #4775 ones) creates a page in Personal with a `TODO` task due `2026-09-10`, moves the page to a new space on A, ships that space's doc to B the way the catch-up does, then reads B's `blocks` row and B's agenda for that day. Red without the fix: `assertion left == right failed: the moved task's state and due date must reach B / left: (None, None) / right: (Some("TODO"), Some("2026-09-10"))`.

The agenda half reads `agenda_cache` through `pagination::list_agenda` after calling `rebuild_agenda_cache` directly: production refills that cache from `Materializer::enqueue_inbound_sync_rebuilds` on a trailing debounce, and a test must not race a timer. It is deliberately not `list_projected_agenda_inner` — that command projects *repeating* blocks (`JOIN block_properties key = 'repeat'`), so a plain dated task is never in its result, fix or no fix.

The fix reads the four columns in the subtree query the hydration already runs and seeds them as `Str` ahead of the `block_properties` rows, the representation the peer-side reprojection reads back. No new SQL site (the query was already a runtime `query_as`), no `.sqlx` change, no new table, op, store or message. The comment now says why `space` alone stays out of the doc: membership is the doc itself.

Falsified against a copy — `loro_apply.rs` set aside, the reserved-key seeding replaced by an empty `properties` vec, the test run, then restored and `cmp`-verified identical. The mutant reddens exactly this test, at exactly the assertion the bug is about:

```
left:  (None, None)
right: (Some("TODO"), Some("2026-09-10"))
```
