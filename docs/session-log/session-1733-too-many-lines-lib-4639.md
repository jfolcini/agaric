# Session 1733 — the `src-tauri/src/lib.rs` splits (#4639)

Refs #4639, eighth slice: the four `#[expect(clippy::too_many_lines)]`
sites in `src-tauri/src/lib.rs`, the app bootstrap (`init_logging`,
`spawn_boot_maintenance`, `spawn_background_tasks`, `run`). Pure moves:
plugin order, managed-state order, the setup steps, the spawn order,
the logging layer order and every log line are unchanged, and no lint
suppression was added.

- `init_logging`: `manage_logging_guards` owns the tail (the
  OpenTelemetry announce, the log-directory lines and the three
  `manage()` calls, in order); the subscriber layering stays in the
  parent.
- `spawn_boot_maintenance`: `spawn_boot_cache_gating` is the
  off-critical-path task, awaiting `schedule_fts_rebuild_if_empty` and
  `schedule_block_tag_refs_rebuild_if_empty` in the original order.
- `spawn_background_tasks`: `build_maintenance_jobs` returns the job
  vector from nine one-job helpers, each keeping its own clones so the
  `move` closures capture exactly what they did; the sweeper, the daemon
  and the periodic snapshot stay in the parent.
- `run`: `install_panic_hook`, `build_tauri_builder` (every `.plugin` in
  order, `cfg` gates intact), `setup_app` (the boot-error dialog) over
  `boot` (the former immediately-invoked closure, step for step),
  `build_sync_daemon_wiring`, `build_mcp_server_wiring` (the seven
  clones taken where they were, now into the struct directly) and
  `build_invoke_handler` (the `generate_handler!` list verbatim). A
  stale import-ordering comment and a now-unused `use tauri::Manager`
  went with it.

## Verified

`cargo clippy -p agaric --lib --tests -- -D warnings` prints nothing
with the four attributes gone; `cargo fmt --all -- --check` clean;
`SQLX_OFFLINE=true cargo check --workspace --all-targets` 0 warnings,
with and without the `ci-smoke` feature; `cargo nextest run --workspace`
6318 passed, 13 skipped; doc-tests green; the specta bindings test
regenerates nothing (`src/lib/bindings.ts` unchanged). The reviewer
compared both revisions mechanically: the `.plugin` chain is
byte-identical over its 138 lines, the 23 `manage()` calls, the boot
steps, the nine maintenance jobs with their intervals and clones, the
spawn order and every string literal and tracing call match (the only
literal delta is the four removed `expect` reasons); the early
`McpServerWiring` literal consumes the same seven clones taken at the
same point, so nothing observable moved. Falsified on copies: dropping
each helper call in turn reddened `cargo check` (`unused variable` and
`never used` under the `-D warnings` oracle); the reviewer independently
swapped two plugins and two maintenance jobs and showed that nothing in
the 2591-test app package catches either, which is the real coverage
picture for this file: boot order is guarded by review and the weekly
`e2e-tauri` lane, and by nothing per PR. All restored, `cmp` clean.
Attribute count 94 to 90.
