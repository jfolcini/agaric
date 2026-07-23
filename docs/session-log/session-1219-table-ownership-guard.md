# Session 1219 — Table-ownership ratchet guard (#2895 first slice)

**Issue:** #2895

## Problem

The four runtime crates (app, agaric-store, agaric-engine, agaric-sync) all raw-write the
core tables (`blocks` written from all four; `op_log` from all four) with no owning
boundary and no guard — any crate could grow new cross-crate writers silently. The full
consolidation is an L-effort refactor; this slice is the issue's own cheap win: document
ownership and programmatically stop the bleed.

## Fix

Pure additive tooling — no production Rust, no `.sqlx`, no migrations:

- **`scripts/check-table-ownership.py`** — scans production `.rs` across the four crate
  roots, counts raw `INSERT/UPDATE/DELETE` statements per (crate, table) for the core
  tables, and fails when a NON-owner crate exceeds its grandfathered floor in
  `src-tauri/table-ownership-baseline.txt` (21 pairs). Owner writes are unconstrained;
  decreases re-anchor (check-dynamic-sql semantics). A local comment-only stripper
  preserves string literals — the SQL to match lives inside `sqlx::query!` strings, so
  reusing check-raw-tx's string-blanking stripper would have made the guard vacuous
  (deviation documented in the script). `--self-test` (9 fixture cases) +
  `--update-baseline` (deterministic).
- **Ownership map** — `blocks`→engine (authoritative Loro→SQLite projection writer),
  `op_log`→store (canonical append primitive `agaric-store/src/op_log/append.rs`; the
  app-crate "writes" are proptest fixtures — verified in review that every
  history.rs/recovery.rs site flagged by an earlier scan is inside `#[cfg(test)]`),
  `peer_refs` + derived caches→store (`peer_refs` already clean single-writer).
- **`prek.toml`** — `check-table-ownership` + self-test hooks mirroring the
  check-dynamic-sql pair; files regex covers all four crate roots.
- **`src-tauri/migrations/AGENTS.md`** — `## Table ownership` section: the map, the
  new-writes-go-in-the-owner rule, grandfathering semantics, diagnostics/fuzz
  out-of-scope boundary.

## Verification

- `--self-test` → 9 cases pass; plain run exit 0; `--update-baseline` re-run byte-identical.
- Negative test (both builder and reviewer, independently): injected
  `UPDATE peer_refs` in agaric-engine → guard fails naming (engine, peer_refs, owner
  store); revert sha256-identical → passes.
- `prek run --all-files check-table-ownership check-table-ownership-self-test` → both pass.
- Adversarial review: SHIP, zero fixes. Independent recount of op_log production writers
  per crate matched the baseline exactly; stripper attacked with raw-string/URL/
  block-comment/escaped-quote fixtures — sound. LOW flag (diagnostics crate out of
  scope) addressed with an explicit scope note in AGENTS.md.
