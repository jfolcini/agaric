# Session 1009 — arch: move tx-cores to domain (#882)

The residual upward edge from #642's commands⇄fts cycle break.

## Shipped

- **`refactor(domain)` #882** — moved `create_block_in_tx` + `set_property_in_tx` (plus the
  private `validate_property_value` / `PropertyDeclaration` + its test module + the consts
  `MAX_BLOCK_DEPTH` / `MAX_CONTENT_LENGTH`) out of `commands/blocks/crud.rs` into the neutral
  `domain/block_ops.rs`, removing the `recurrence → commands` **and** a bonus `spaces → commands`
  upward edge.

  A Plan-agent scoping pass found that #642's "these are command cores, high-ripple to move"
  framing was **stale** — reading the functions shows every dependency already lives in a neutral
  layer (`op` / `op_log` / `materializer` / `spaces` / `pagination` / `db` / `error` / `ulid`,
  none of which import `commands`); the `*_in_tx` naming was accurate and the `*_inner` command
  wrappers (IPC concerns) stay in `commands`. So it's a near-mechanical Design-A move, not the
  decoupling-first job it looked like.

  Behavior-preserving: reviewer diffed every moved item against `main` — **byte-identical** bodies
  (only doc-link requalification + `MAX_BLOCK_DEPTH` private→`pub(crate)` for the re-export).
  `commands` re-exports the two fns + both consts so its ~20 internal callers + the MCP
  `MAX_CONTENT_LENGTH` user don't churn; `commands::blocks::set_property_in_tx` re-export kept for
  the one fully-qualified caller. `recurrence/compute.rs` + `spaces/bootstrap.rs` now import from
  `domain`. The `pagination/block_row_columns.rs` BlockRow column-drift guard re-anchored to
  include `domain/block_ops.rs` (the moved `set_property_in_tx` carried one `query_as!(BlockRow,…)`
  site; EXPECTED_HITS=15 preserved). `domain` has **zero** `commands` deps (grep-proven — no cycle
  reintroduced). bindings.ts unchanged (not `#[tauri::command]`). 1304 tests, clippy clean.
  Closes #882.

## Backlog state — autonomous arch backlog drained
All ungated, well-scoped arch + tooling items are now shipped. Remaining work is maintainer-gated:
- **#833** docs-CI fast-path (strict-gate surgery — wants maintainer review of the gate change).
- **#645-core** (Option C decouple-first Tauri-free core carve) and the **#644** deep slices
  (loro/engine.rs, commands/pages deep split) — deferred pending maintainer boundary sign-off.
- **#709** tag re-key (plan, risky data migration), **#877** 147-component migration (needs a quiet
  tree), **#139** build.rs consolidation (gated on sqlx#3388), **#763** items 2/3/4 (#886/#887/#888,
  each its own tooling/infra decision).
