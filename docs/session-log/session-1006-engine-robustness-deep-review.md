# Session 1006 — /batch-issues loop: engine robustness, batch 7 (2026-06-19)

## What happened

Seventh batch of the `/loop /batch-issues` run: three backend engine/query
defense-in-depth findings from the multi-agent deep review, each on a disjoint file,
built by parallel subagents (≤2 concurrent Rust) and adversarially reviewed.

## Shipped

Single PR `fix/engine-robustness-deep-review`:

- **#1600** — `compute_op_hash` used a plain `assert!` to reject a raw NUL byte, so a
  NUL byte panicked in release on the `insert_remote_op` ingest path; downgraded the
  asserts to `debug_assert!` (pure hash, dev-time invariant) and added an explicit
  NUL-byte gate at the top of `insert_remote_op` returning `AppError::InvalidOperation`
  before hashing. Local-write callers feed serde-escaped input (no raw NUL), so the
  untrusted remote boundary is the only one gated. Hash value unchanged (golden vector).
- **#1597** — `TagExpr` had `And`/`Or`/`Not` with no depth gate, asymmetric with
  `FilterExpr::validate_depth`; added `TagExpr::validate_depth` (`MAX_DEPTH=50`,
  bounded validation walk) called at the `eval_tag_query` entry before `resolve_expr`
  recurses. Defense-in-depth (TagExpr isn't `Deserialize` today).
- **#1599** — the brace-expansion `Literal` branch lacked the in-loop `EXPANSION_CAP`
  break the `Alts` branch has; added it for symmetry (the post-segment truncate already
  bounds output, so it's defensive — kept per the issue's recommendation).

## Review pass

Three adversarial reviewers, two real catches:
- **#1600 reviewer** found the four `#[should_panic]` null-byte tests would FAIL under
  `--release` (debug_assert compiles out) and the builder's "cfg-gated" comment was
  false; added `#[cfg(debug_assertions)]` gating. Also verified no other production
  caller of `compute_op_hash` feeds untrusted NUL content.
- **#1599 reviewer** found the cap test was tautological (passed even with the new
  break reverted) and tightened it to an exact-width assertion.
- **#1597 reviewer** confirmed `FilterExpr` parity, no bypass path to `resolve_expr`,
  and a bounded validation walk.

## Notes

- Files: `hash.rs`, `dag.rs`, `tag_query/{mod,query}.rs`, `fts/glob_filter.rs`
  (+ tests). `cargo clippy --lib` + `check --all-targets` clean; targeted suite 257/257
  pass. No new SQL → no `.sqlx` regen.
