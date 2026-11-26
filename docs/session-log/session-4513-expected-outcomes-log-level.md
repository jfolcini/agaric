# Session 4513 — Expected outcomes off the ERROR level

**Ask.** Fix the open items from #7129's log review. This PR takes two of them, both about level: a command logging a caller's `NotFound` at ERROR, and the projection warning about a property with no definition. The `iroh` endpoint dropped without `close` is its own PR.

**Found.**
- Every command's `*_inner` span carries `#[instrument(err)]`, which logs any `Err` at ERROR. Both boundaries already log the real failures at ERROR themselves: `sanitize_internal_error` at IPC, `app_error_to_rmcp` for MCP. So the span line was a second copy of each internal failure. It was also the only copy of a caller's answer (`NotFound`, `Validation`), at a level that put it in bug reports' recent errors.
- #7129's bridge shards logged those outcomes at ERROR from about ten commands (`blocks::queries`, `pages::opens`, `pages::listing`, `properties`, `crud`, `source_apply`, `spaces`). The two-device WebdriverIO spec logged five more from its poll for a block not synced yet.
- The callers outside IPC and MCP log or propagate their own errors: the mirror daemon, the reminder tick, maintenance, the relay-settings read.
- `sync.run_session` has the same shape: "peer is busy" and "peer not paired" at ERROR, then `record_session_failure` logged the same error at WARN.
- `reproject_block_properties_from_engine` warned for every value of an undeclared key. The property code calls an undeclared custom key "the ordinary state", and `reproject_key_values` already went around the warning.

**Done.**
- The 209 command spans and `sync.run_session` log their error at info. That follows `search_blocks_partitioned_inner`, which made the same call for `Cancelled`. Its comment went; the rule now sits once, on `sanitize_internal_error`. The file log keeps `agaric` at info, so the line stays in the log a bug report bundles.
- The undeclared-key warning is gone, along with the `block_id` parameter two helpers carried only for it.
- Trade: `tracing-opentelemetry` marks a span as an error only for an ERROR event. In the opt-in OTLP view, a command that failed internally no longer shows error status, though the error text is still on the span. The ERROR line at the boundary is unchanged.

**Ran.**
- `not_found_logs_at_info_not_error` (new) and `reproject_undefined_key_defaults_to_text` (one new assertion) pass.
- Shown red: with `get_active_block_inner`'s span back on `err`, the new test fails on the INFO assertion; with the warning back, the projection test fails on its no-WARN assertion.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
