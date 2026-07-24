# Session 1226 — Remote op_log ingest behind store primitives (#2895 slice 5)

**Issue:** #2895 (slice 5-op_log)

## What

agaric-engine's two remote-ingest raw writes to `op_log` (dag.rs: `ingest_remote_record`,
`append_merge_op`) moved behind new store primitives in `op_log/append.rs`, alongside
the canonical `append_local_op_in_tx`:

- `agaric_store::op_log::ingest_remote_op_in_tx(tx, record, origin, is_replicated)` —
  the INSERT OR IGNORE 11-column ingest; internalizes the (already store-owned)
  `extract_indexed_ids_from_payload`; returns the inserted flag.
- `agaric_store::op_log::insert_merge_op_in_tx(tx, …)` — the plain 9-column merge
  insert relying on schema defaults. Kept as two narrow fns: collapsing would change
  duplicate-PK and default-stamping semantics.

Both `_in_tx` (caller commits); SQL byte-identical; migration-0036 triggers are
BEFORE UPDATE/DELETE only, so INSERTs remain ungated (verified — no bypass needed).

## Review (adversarial, independent agent): SHIP-WITH-FIXES

The predicted cross-crate `.sqlx` failure was real: the macros moved from engine to
store, and store's own offline cache was missing both query hashes (invisible locally
— DATABASE_URL enabled online mode; CI's SQLX_OFFLINE would have failed exactly like
PR #3106). Fixed by adding the two crate-agnostic cache entries to
`agaric-store/.sqlx` (additions only; engine's stale entries tolerated).
`SQLX_OFFLINE=true cargo check --workspace` green. All other claims verified:
byte-equivalence char-for-char, `is_replicated` match↔`i64::from(matches!())`
equivalence, tx/rollback semantics unchanged, engine suite 401/401.

## Baseline

Engine `op_log` pair ELIMINATED (annotations preserved). Engine's remaining baseline
presence is now solely the 8 documented projection-co-writer cache pairs.

## Verification

Post-rebase over slice 1: `SQLX_OFFLINE=true cargo check --workspace` clean; dag +
new-fn tests 66 passed; 2 new store unit tests (idempotent ingest incl. duplicate-PK
false return; merge defaults); clippy clean; ownership guard + self-test pass.
