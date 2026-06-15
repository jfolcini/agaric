# Session 1036 — audit fixes #1274/#1275/#1247/#1259: architecture-doc accuracy

2026-06-15. From the 2026-06 Opus quality audit (documentation). `/loop /batch-issues`
run. Pure-markdown corrections; each verified against the current code (doc-citation
guard passes).

- **#1274** `docs/ARCHITECTURE.md` Core principle 6 — per-space partitioning is the native
  `blocks.space_id` column (migration 0086, #533) + `spaces` registry FK (0089), NOT a
  `space` ref-property (0088's `key_not_reserved` CHECK forbids `space` as a property key).
- **#1275** `docs/architecture/frontend.md` §Spaces — removed the contradictory per-page
  `space`-property description; membership is `blocks.space_id` (sole source of truth per
  `spaces/bootstrap.rs`), backfill is `UPDATE blocks SET space_id = ?`.
- **#1247** `docs/architecture/crdt-and-recovery.md` — sibling order IS the engine's
  fractional index; SQL `position` is a derived dense rank re-projected by
  `reproject_dense_positions` (projection.rs, #400), not a deliberate scope-cut scalar.
- **#1259** same file — crash-recovery step 3 compares INTEGER epoch-ms (`now_ms()`,
  migrations 0079/0082) numerically with same-ms content-provenance disambiguation (#384);
  removed the stale `now_rfc3339` lex-monotonic rationale.
