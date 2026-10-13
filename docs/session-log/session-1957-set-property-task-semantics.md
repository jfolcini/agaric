# Session 1957 — set_property on todo_state stamps and recurs like the app

Issue #5394: an agent that set `todo_state = DONE` through MCP `set_property` flipped the column and nothing else. There was no `completed_at`, and a repeating task never spawned its next occurrence.

`set_property_inner` now routes `todo_state` to `set_todo_state_inner`, so the property drawer and every other generic caller get the checkbox's transitions. A non-text value is refused. The issue also asked to route `priority`, `due_date` and `scheduled_date`, but that premise was wrong:
- The two date setters call `set_property_inner` themselves, so routing them there would recurse.
- All three dedicated setters validate only what the engine's `set_property_in_tx` already validates.

Import, sync replay, undo and the recurrence code call `set_property_in_tx` directly, so they still write raw values.

The trap: once one call writes several ops, the Activity feed's Undo has to send all of them. The backend already reported `additionalOpRefs`, but `useMcpActivityFeed` dropped the field and `ActivityFeed` reverted only `opRef`. Undo and session revert now send every ref of an action. Counts stay per action, not per op.

Suites that ran:
- the whole workspace under nextest, in two partitions;
- clippy over every target;
- vitest on the feed, the hook and the tauri mock;
- typecheck.

The tauri mock writes the same `completed_at` transition, which the conformance fixture `set_todo_state_completed_at.json` pins from the backend. The mock still does no recurrence; its own `set_todo_state` has the same gap.
