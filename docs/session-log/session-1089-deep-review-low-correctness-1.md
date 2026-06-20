# Session 1089 — /batch-issues loop: 4 LOW deep-review correctness fixes, batch 37 (2026-06-20)

## What happened

Four small, independent LOW-severity correctness findings from the deep review, built by
parallel subagents in one shared worktree `wt-batch37` (each on a DISJOINT file) and
reviewed together. Shipped as one PR.

## Shipped

PR `fix/deep-review-low-correctness-1`:

- **#1535** (`commands/mod.rs`) — `is_mime_allowed`'s `type/*` wildcard used `starts_with`
  on the `type/` prefix, so `image/` (empty subtype) and `image/../x` passed. Now uses
  `strip_prefix` + requires a **non-empty, slash-free** subtype (forbids only empty and
  `/` — `+`/`.` in a subtype like `vnd.api+json` are unaffected). Exact-match path
  unchanged.
- **#1542** (`loro/engine/mod.rs`) — `PropertyValue::from_loro` mapped `I64(i)` to
  `Num(i as f64)` with no precision guard. Added a `tracing::warn!` when
  `i.unsigned_abs() > 2^53` (uses `unsigned_abs` to avoid the `i64::MIN` panic; the
  `±2^53` boundary and normal date-ms/priority ints stay silent). The conversion is kept;
  a new `Int(i64)` enum variant was judged out of scope for a LOW fix (every match arm +
  SQL projection + wire types) and deferred.
- **#1536** (`db/recovery.rs`) — `recover_blocks_from_op_log`'s `create_block` arm used
  `INSERT OR IGNORE` with no `rows_affected` check, silently absorbing a colliding-id
  create from a corrupted op_log. Kept `INSERT OR IGNORE` (idempotent recovery) but added
  a `tracing::warn!` on `rows_affected()==0`. First-create-wins behaviour unchanged.
- **#1545** (`mcp/rmcp_adapter.rs`) — an MCP client without `clientInfo` collapsed every
  anonymous connection to `op_log.origin = 'agent:unknown'`. New `durable_agent_name`
  folds the reused per-connection session ULID into the durable origin
  (`agent:unknown:<ulid>`) only when the sanitized name `== AGENT_NAME_PLACEHOLDER`; named
  clients keep `agent:<name>`. Verified no origin consumer parses the name back out (only
  the `LIKE 'agent:%'` activity-feed prefix filter, which still matches).

## Review pass

One reviewer covered all four (disjoint files, one PR): verified each fix's edge handling
(mime `+`/empty; i64 `unsigned_abs`/`MIN`/`±2^53` boundary; recovery idempotency +
`rows_affected` semantics; origin exact-placeholder match + ULID reuse + grep-confirmed
consumer parse-safety + distinct-anon), mutation-checked the high-value tests, and
confirmed no cross-file conflict / over-reach. `clippy --all-targets -D warnings` clean;
826 targeted tests pass. `.sqlx`/#646 baseline unchanged (#1536 uses runtime `query`).

## Notes

- Files: `commands/mod.rs`, `loro/engine/mod.rs`, `db/recovery.rs`, `mcp/rmcp_adapter.rs`
  (+ inline tests). No `.sqlx`/baseline change.
- Branch base is current `origin/main`.
