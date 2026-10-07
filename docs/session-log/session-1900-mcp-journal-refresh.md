# Session 1900 — an MCP-created journal page reaches open views (#5314)

This is another `/batch-issues` batch from the session that logged 1877. It
was built while #5321 (#5294) waited on CI.

## #5314

- **The bug.** MCP `journal_for_date` creates the day's page when it is
  missing and the date is inside the create window. It emitted only
  `mcp:activity`. Open views refresh on `blocks:changed`, which every
  read-write tool emits, so an open journal kept showing no page until the
  user navigated away and back.
- **The fix.**
  - `ReadOnlyTools` takes a view emitter, the same `with_view_emitter` that
    `ReadWriteTools` has. It defaults to a no-op.
  - `spawn_mcp_ro_task` installs the Tauri emitter.
  - Inside the create window, the tool first probes for the page on the
    reader pool. It emits `blocks:changed` for the page only when that probe
    missed.
  - The issue suggested making `resolve_or_create_journal_page` report
    whether it created the page. The probe answers the same question without
    changing that function or its four callers. A lost race to another
    creator costs one extra reload.

## Verified

- New test, `journal_for_date_emits_blocks_changed_only_when_it_creates_5314`:
  a create and then a lookup emit exactly one `blocks:changed`, carrying the
  page id. Two mutations were run against a copy, then restored:
  - no emit turns it red;
  - emitting on every call turns it red.
- The MCP tests pass, 295 of them, and `cargo clippy --workspace
  --all-targets -- -D warnings` is clean.
- `cargo nextest run --workspace`: 6699 tests pass.
