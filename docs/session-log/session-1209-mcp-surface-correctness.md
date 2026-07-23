# Session 1209 — MCP tool-surface correctness (search validation + drop-safe activity feed)

**Date:** 2026-07-23
**Closes:** #2956, #2954
**Related:** #2955, #2957 (same MCP audit cluster — triaged and left for a maintainer decision, see the
issue comments); follow-up #3066 filed. Continuation of the same autonomous batch as sessions 1207/1208.

Two correctness fixes on the MCP agent surface, one PR. Both live entirely under `src-tauri/src/mcp/`.

## #2956 — `search` silently swallowed a malformed `space_id`

`handle_search` (`tools_ro.rs`) wrapped its required `space_id` with `SpaceId::from_trusted`, so a
malformed/truncated id became an `Active` id that simply matched nothing — an agent that mangled the id
got an empty result set and wrongly concluded the vault was empty. Every sibling tool
(`list_backlinks`, `list_property_defs`, `create_page`) rejects an invalid id loudly.

Fix: construct via `SpaceScope::Active(SpaceId::from_string(normalize_ulid_arg(&args.space_id))?)`,
matching the siblings exactly, so a bad id now returns an error instead of `Ok { items: [] }`. Note:
`SpaceId::from_string` yields `AppError::Ulid`, which `app_error_to_rmcp`'s catch-all maps to JSON-RPC
**-32603** (internal error), not the -32602 the issue text assumed — but this is identical to all four
sibling tools, so sibling-parity is preserved (surfacing it as -32602 would be a separate cross-cutting
change to the `AppError::Ulid` mapping). Test `search_malformed_space_id_errors_not_empty` asserts a
truncated and an empty id each error while a valid id still returns the seeded hit.

## #2954 — a committed RW mutation could vanish from the activity feed on disconnect

The RW surface advertises "every mutation is recorded in the user-visible activity feed"
(`mod.rs:90-94`), but `emit_tool_completion` ran only *after* the awaited tool future completed, in the
same future that `server.rs:553` drops on grace-period expiry / client stream close. The durable commit
(`CommandTx::commit().await`) is the last `.await` before the value returns, so a write that commits on
the sqlite worker thread just before the connection future is dropped was durably applied yet never
emitted to the feed (nor the `blocks:changed` refresh).

Fix: a drop-safe `ToolCompletionGuard` (`rmcp_adapter.rs`) that lives inside the `LAST_APPEND`
task-local scope, armed for the cancellable call and disarmed synchronously on the normal path right
after `take_appends()`. If the future is dropped before it disarms, its `Drop` drains the recorded op
refs and emits the completion entry (result `Ok`, summary degraded to the tool name; the op refs drive
the `blocks:changed` refresh). Exactly-once holds: the normal path has no `.await` between `call_tool`
returning and the disarm, so cancellation can't interleave; on the cancel path the outer emission is
unreachable. Verified sound for the pinned tokio 1.52.3, whose `TaskLocalFuture::drop` drops the inner
future with the task-local still set (so `take_appends()` is valid in `Drop`). The dispatch+emit body
was extracted into a private `dispatch_tool_call` to make it testable; `server.rs` was not touched.
Test `rw_mutation_emits_activity_even_when_dropped_mid_commit` drops the future via the same
`tokio::time::timeout(...)` mechanism as the grace-period path and asserts exactly one feed entry + one
Tauri event carrying the op ref (non-vacuous: neutering the guard's `Drop` makes it fail).

Follow-up #3066: `record_append` fires pre-commit, so a drop landing between it and commit-completion
could emit a cosmetic false-`Ok` feed entry for an already-disconnected client (benign — the refresh
re-reads true DB state).

## Not fixed this batch (same audit cluster)

- **#2955** (no RW rate-limit) — the issue's own verification adjusted it to *low* as a deliberate,
  documented posture (single-user local-only; bloat is user-reclaimable). Left for a maintainer call.
- **#2957** (self-declared agent identity; same-user RW grants full-vault write) — the documented
  threat model ("no bearer tokens, no crypto"); adding authenticated attribution / per-agent consent is
  an L-effort design change with product trade-offs. Flagged for a maintainer decision.
