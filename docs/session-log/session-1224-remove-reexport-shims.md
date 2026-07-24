# Session 1224 — Remove the post-#2621 re-export shims (#2897)

**Issue:** #2897 (arch-backend deep-review family)

## What

The app crate retained 66 `pub use agaric_*` re-export shims across 19 files, keeping
pre-split paths (`crate::domain::…`, `crate::loro::…`, `crate::import::…`) first-class
and hiding the real crate dependency graph. Migrated ~1,881 legacy references across
the app crate, benches, and diagnostics to their owning-crate paths; 66 → 6 shims.

- 37 lib.rs root module aliases removed (largest: loro 303 refs, ulid types 295,
  op_log 178, op 174).
- 3 pure-shim files deleted (`src/domain/block_ops.rs`, `src/domain/mod.rs`,
  `src/mcp/actor.rs`).
- Aggregator files de-shimmed keeping local code (ulid.rs, import.rs); test-only
  re-export needs gated to `#[cfg(test)] use` (dag, soft_delete, 5 sync test-hosts).
- diagnostics crate gained a direct agaric-core dependency.
- 6 kept shims, each `// kept (#2897):`-commented: specta binding paths, the db
  aggregation seam, the bootstrap seeded-ULID seam, and 3 cfg(test) test-preludes.

## Review (adversarial, independent agent): SHIP, zero fixes

- Production-only `cargo check --workspace` clean — proves the cfg(test) gating of
  former production re-exports is sound.
- **Bindings drift ruled out decisively**: `bindings.ts` absent from the diff;
  `check-tauri-bindings-parity` passes (121/141 wrapped, 20 allowlisted).
- All path-keyed guards pass (dynamic-sql, raw-tx, doc-code-paths,
  architecture-citations); external consumers (benches, fuzz, MCP bin) verified.
- LOW flag (pre-existing, filed as follow-up): `dynamic-sql-baseline.txt` carries
  stale pre-#2621 entries and the scanner never followed moved code into the
  subcrates — a coverage gap predating this PR.

## Verification

`cargo check --workspace` + `--all-targets` clean; nextest smoke/block_ops/import/
mcp/sync → 932 passed; clippy --workspace --tests no warnings; residual-path greps 0.
