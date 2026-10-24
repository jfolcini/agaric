# Session 2902 — MCP create_tag tells open views, once the tag list holds the tag

#6049, the Rust half. A tag an MCP agent creates stayed missing from an open journal's `#` picker until the next sync event. Typing it offered only "Create". The backend then reuses the existing tag of that name (#5236), so nothing is lost; the picker was just out of date. The frontend half (#6068) gave every out-of-band write path one `invalidateDerivedCaches()`. This half makes `create_tag` send the event that runs it.

**The event.**
- `handle_create_tag` emitted nothing. It had nothing to send: a tag sits on no page, and an empty `changed_page_ids` means "reload every mounted page store".
- It now sends the tag's own id. The frontend's targeted path finds no store that holds the id, so it reloads none, and it still runs `invalidateDerivedCaches()`. That empties the picker's tag list.
- No new payload field: an id no store holds already meant exactly this, and the empty set keeps its meaning for every other emitter.

**The order.** The picker refills from `tags_cache`. The background queue rebuilds it after the commit, with no debounce for a create but behind whatever is already queued. A `#` typed between the event and the rebuild would refill the list without the tag and keep it, because a non-empty list is never fetched again. `create_tag` now awaits `flush_background()` before it emits. `SpacePlacementSink` and the recovery cache refresh do the same for the same reason. The reply waits for the background queue, which matters only under a backlog.

**Shown red:**
- With the emit removed, `create_tag_creates_in_space_and_reuses_the_name` sees no event.
- With the flush removed, `create_tag_signals_once_the_tag_list_holds_the_tag_6049` reads the tag list at the emit and finds it without the tag, six runs out of six.
- On the frontend, two `useSyncEvents` changes each redden "reloads no page store for an id none holds, and still drops the picker name caches": a set that names no page reloading every store, and the targeted path skipping the cache reset.
- `e2e-tauri/mcp-create-tag-picker.e2e.ts` creates a tag through MCP while the journal is open and its picker list is already filled, then types it. It is CI's real-backend lane that runs it. The MCP agent setup moved into `e2e-tauri/helpers.ts`.

**Not here:**
- Deleting or restoring a tag through MCP rebuilds `tags_cache` on the 300 ms inbound debounce. A `#` typed in that window can keep a deleted tag in the picker.
- MCP `create_page` and the Pages list, which reads `pages_cache`, have the same shape.
- The `[[` picker reads `blocks` and has no race.

**Suites:**
- nextest over `create_tag`, MCP, `blocks_changed`, sync events, `resolve_changed_page_ids` and `tags_cache`;
- clippy, fmt and `SQLX_OFFLINE` check;
- vitest over `src/hooks`, `src/lib`, `src/stores` and `src/components/block-tree`, and the e2e-tauri helper tests;
- typecheck, including `typecheck:e2e-tauri`, and lint.
