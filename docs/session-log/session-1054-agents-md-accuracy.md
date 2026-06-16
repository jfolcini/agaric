# Session 1054 — audit fixes #1273/#1276: AGENTS.md accuracy (with explicit user approval)

2026-06-16. From the 2026-06 Opus quality audit (documentation). `/loop /batch-issues` run.
AGENTS.md edits made with **explicit user approval** (the file's header forbids changes
without it). Both verified against current code.

## #1276 — invariant #2 referenced a deleted function + wrong behavior
The "Key Architectural Invariants" #2 said old flat-map snapshots "migrate forward to the
tree on load (`migrate_flat_blocks_to_tree`, idempotent)". That function is **deleted**;
since #332 a v2 engine **rejects** a legacy v1 (flat-map) snapshot loudly
(`reject_legacy_v1_snapshot`) rather than migrating it. Updated to describe the reject
behavior + `ENGINE_FORMAT_VERSION = 2`.

## #1273 — §Database listed migrated columns as "legacy TEXT ISO-8601"
The timestamp-encoding note claimed `blocks.deleted_at`, `op_log.created_at`,
`materializer_retry_queue.created_at` "keep `now_rfc3339()` until Phase 2 of #109." All
three (and the rest of the timestamp columns) were migrated to INTEGER ms in migrations
0074–0082 (`materializer_retry_queue.created_at` 0077, `op_log.created_at` 0079,
`blocks.deleted_at` 0080). Updated to state Phase 2 has landed and `now_rfc3339()` is
retained only for not-yet-migrated columns / non-DB use.
