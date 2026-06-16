# Session 1039 — audit fix #1260: exhaustive OpType match in invalidations_for_op

2026-06-16. From the 2026-06 Opus quality audit (maintainability, high).
`/loop /batch-issues` run.

## Problem
`invalidations_for_op` (`src-tauri/src/materializer/dispatch.rs`) matched
`record.op_type.as_str()` (raw strings) with an `other => warn` catch-all. This
defeated the load-bearing no-`#[non_exhaustive]` invariant on `OpType`: a NEW op
variant would silently get **no cache invalidation** at runtime instead of failing the
build. `rename_attachment` (the 13th variant) was already silently in that catch-all.

## Fix
Parse `record.op_type` once via `OpType::from_str` (clippy-clean `let Ok(op_type) = …
else { warn; return Ok(tasks) }`, matching the `reverse/mod.rs` / `handlers/apply.rs`
pattern), then `match op_type { … }` **exhaustively with no `_` arm**. `rename_attachment`
is now an explicit empty arm alongside the other attachment ops. Behavior is
byte-identical per op (verified across all 13 variants + the unparseable-string warn+empty
path); no SQL change. A 14th variant will now fail to compile here until its
invalidations are declared.

## Verification
New tests: `invalidations_for_op_rename_attachment_returns_empty` and
`invalidations_for_op_covers_every_op_type`. Reviewer confirmed byte-identical per-op
behavior and fixed a `manual_let_else` form that CI's `-D warnings` would have hard-failed.
Full Rust suite 4167 passed; clippy clean.
