## Session 899 — #107: command-param boundary for properties/history/queries/pages (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 1 build (orchestrator-verified) |
| **Items closed** | `#107` (with #228) |
| **Items modified** | — |
| **Tests added** | +0 (call-site arg types only) |
| **Files touched** | ~20 |

**Summary:** Final #107 batch — converts the remaining `block_id`/`page_id` `String` params on the
`#[tauri::command]` fns + module-local `_inner` in `commands/{properties,history,queries,pages}.rs`
to `BlockId`/`PageId`. Contained (NOT a cascade): the core block `_inner` already take `BlockId`
(from #228), so this just drops the now-redundant `.into()` at those call sites and types the IPC
boundary. With this + #228 (deep cascade) + the PageId newtype + the attachments/drafts/tags batch,
**#107's IPC-param conversion is complete**. Stacked on #228 (must merge first).

**Converted:** properties (`set_property`/`set_todo_state`/`set_priority`/`set_due_date`/`set_scheduled_date`/`delete_property`/`get_propert*`/`set_todo_state_batch`/`get_batch_properties`), history (`compute_block_vs_current_diff`), queries (`get_backlinks`/`query_backlinks_filtered`/`list_backlinks_grouped`/`list_unlinked_references`→PageId/`count_backlinks_batch`→Vec<PageId>), pages (`set_page_aliases`/`get_page_aliases`/`export_page_markdown`/`load_page_subtree`). One production caller adapted (`mcp/tools_ro.rs` — `BlockId::from` at the boundary, normalization identical).

**Left `String` (genuinely not plain ids):** the `"__all__"` sentinel `page_id` in
`list_page_history`/`restore_page_to_op`/`undo_page_op`/`find_undo_group` (a `PageId` would uppercase
it to `__ALL__`, breaking the byte-exact sentinel); nested serde filter structs (`SearchFilter`,
`PropertyFilter`, `TagFilterExpr`) shared with `fts`/MCP (would ripple out of scope); `space_id`
(SpaceId), `tag_ids` (TagId) — separate future newtypes.

**Verification:**
- `cargo check --all-targets` — **0 errors**; `cargo nextest run` — **4067 passed**; `bindings.ts` regenerated (wire-identical = string). No `.sqlx` change.
- Normalization-sensitive test (`get_property_normalizes_lowercase_block_id`) still passes — normalization moved to the `BlockId::from` type boundary (the #107 intent), no assertion change.

**Process notes:** Stacked on the #228 branch (its `_inner` are `BlockId`); PR base = `main` so it
shows the combined diff until #228 merges, then shrinks to the boundary changes (avoids the
chained-PR orphan pitfall). `Closes #107` fires when this merges (after #228).

**Commit plan:** single commit, pushed, PR (Closes #107; stacked on #228).
