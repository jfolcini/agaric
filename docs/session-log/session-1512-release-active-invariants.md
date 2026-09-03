# Session 1512 — release-active invariants on the write and sync paths

Issue #4638: `debug_assert!` compiles out in release, so an invariant violation on a
write or sync path proceeded silently and the corruption landed with no log line. The
issue listed 23 production sites, 17 to decide. The grep found 26 (three had drifted in
since the issue was written); each one was promoted, replaced with `return Err`, deleted,
or kept with the one sanctioned justification — a measured cost.

## What shipped

Promoted to `assert!`: `transport/bulk.rs` (a zero-length copy buffer makes `copy_exact`
spin forever issuing zero-byte reads — a hang with no error is worse than an abort),
`loro/revert.rs::arm` (re-arming the un-keyed revert log merges two transactions'
checkpoints and rewinds the wrong one), `sync_daemon/session_supervisor.rs`,
`filters/assembly.rs`, `fts/filter_builder.rs`, `commands/queries.rs` (placeholder/bind
drift silently misbinds and returns wrong rows), `mcp/activity.rs` (a zero capacity never
satisfies `len == cap`, so the ring grows unbounded).

Replaced with `return Err`: both `recovery/draft_recovery.rs` block-id shape checks (a
malformed id fell into the supersession COUNT and was dropped as "already flushed"),
`materializer/dispatch.rs` (the release build skipped every per-block reindex, leaving
backlinks, inline tag refs and FTS stale with no trace), and the file-transfer arm of
`sync_protocol/session_state_machine.rs`, which now returns `InvalidOperation` like every
sibling arm for a message that must never reach the orchestrator.

Deleted: `materializer/handlers/task_handlers.rs` (the #412 `return Err` immediately below
carries the identical predicate), both `bibliography.rs` parser preconditions (every call
site already matches on the character the assert restated), and the release-gated
`fifo_regression.rs` test that pinned the silent-skip behaviour that no longer exists.
`sync_scheduler.rs::remember` is now enforced by construction — a duplicate is a no-op,
so the invariant it asserted cannot be violated.

Kept debug-only, on the cost argument: `apply/kernel.rs` runs an extra `MIN`/`MAX` query
over `op_log` per applied op. Its comment now says that, and no longer claims the batch
arm `debug_assert!`s it — that arm returns `Err`.

## What the review corrected

The `filters/primitive.rs` promotion was not sound as first written. `to_ms` panics on an
unparseable RFC 3339 bound, which is only safe if every path into
`PagesProjection::compile_last_edited` has validated it. Pages does; the search path and
the advanced query path did not, and the advanced query accepts a `FilterExpr` from IPC
*and* from the markdown-persisted `v2:` payload. A user with a bad stored inline query
would have got an aborting app instead of an empty result — a defect this PR would have
introduced. The pages validator moved into `agaric-store` as `LastEditedSpec::validate()`
(same `ValidationCode::InvalidDateFilter`, same messages), the private copy in
`commands/pages/metadata.rs` is gone, and both boundaries now call it. The panic stays as
the backstop it claims to be.

## Verified

`cargo nextest run --workspace`: 6324 run, 6324 passed, 0 failed, 11 skipped (493 s).
`cargo clippy --workspace --all-targets`: clean. `SQLX_OFFLINE=true cargo check
--workspace --all-targets`: clean. The new `query_scalar!` in the draft-recovery test
added one entry to the root and `agaric-sync` `.sqlx` caches, regenerated with
`just gen-sqlx`.

Every new test was falsified — the covered code broken against a scratch copy, the red
output read, the file restored and `cmp`-verified. `commands/queries.rs` got no new test:
every contributor to its placeholder index and bind sequence is internal to one function,
so there is no injection point, and a hand-built test would only re-assert a copy of the
arithmetic. It was falsified instead against real drift (`next_param += 1` → `+= 2`),
which reddened nine existing integration tests.

The surviving production `debug_assert!` set is now exactly the justified list:
`agaric-core/src/hash.rs` ×4 (#1600, hashing hot path), `agaric-store/src/fts/index.rs`
(an extra query per write), `agaric-engine/src/apply/kernel.rs` (a query per op), and
`src/db/command_tx.rs` (a `Drop` guard, where `assert!` would abort on unwind).

## Left open

`apply_op_projected` has no release counterpart to its single-device check. The #412
`return Err` guards only `BatchApplyOps`, and the `COUNT(DISTINCT device_id)` check in
`recovery/replay.rs` runs at boot replay, not per op — so a multi-device single-op apply
in a release build advances the global cursor silently, and boot replay catches it only
later. Filed rather than built: the fix is per-device cursor partitioning, a design
decision (#4661).
