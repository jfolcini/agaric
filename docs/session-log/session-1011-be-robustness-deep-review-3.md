# Session 1011 — /batch-issues loop: backend robustness, batch 12 (2026-06-19)

## What happened

Twelfth batch of the `/loop /batch-issues` run: four backend robustness /
security defense-in-depth findings from the multi-agent deep review, each on a
disjoint file, built by parallel subagents (≤2 concurrent Rust) and adversarially
reviewed. Ran overlapped with frontend batch 11 in worktree `wt-fe11`.

## Shipped

Single PR `fix/be-robustness-deep-review-3`:

- **#1580** (MEDIUM, security) — the combined `.pem` holding the device ECDSA
  P-256 private key was created with `create_new(true).open()` and no `mode()`,
  inheriting the process umask (commonly world-readable). Added
  `secure_create_options()` (`#[cfg(unix)]` `OpenOptionsExt::mode(0o600)`) used for
  both the `.pem` and the `.hash` file, so the key is owner-only at creation with
  no chmod-after window. Windows still compiles (NTFS ACLs).
- **#1528** (MEDIUM) — `read_existing_cert` validated the `.hash` file's 64-hex
  shape but never re-bound it to the cert, so a swapped/edited `.hash` made the
  device advertise a hash mismatching its presented cert → peers TOFU-pin the wrong
  hash → permanent sync outage. Now recomputes `SHA-256(DER(cert_pem))` (DER via the
  existing `pem_to_der`, lowercase hex matching the write side in
  `sync_net/tls.rs::generate_self_signed_cert` byte-identically) and returns the
  M-54 `corrupt_cert_error` on mismatch so the existing recovery regenerates.
- **#1575** (MEDIUM) — the `_op_log_mutation_allowed` bypass sentinel is a shared
  (non-temp) table and the op_log immutability triggers gate on a global
  `WHEN NOT EXISTS` predicate; init never cleared it, so a leaked sentinel would
  permanently disable append-only enforcement DB-wide. Added
  `clear_leaked_bypass_sentinel` to the production write-pool init (`init_pools`,
  after migrations / before serving traffic) — `DELETE FROM _op_log_mutation_allowed`
  with a `tracing::warn!` only when a row was actually present. (`init_pool` is the
  test/bench-only fixture; production boots exclusively through `init_pools`.)
- **#1582** (LOW) — the depth-100 cascade CTE bound silently drops descendants on
  a >100-deep tree; the user-facing `delete_block_inner`/`restore_block_inner`
  commands warn via `cascade_depth_saturated`, but the op-replay / sql_only /
  reprojection paths did not. Centralized the saturation probe + `tracing::warn!` in
  `project_delete_block_to_sql` / `project_restore_block_to_sql` (the single point
  all three non-command paths route through), deliberately leaving the materializer
  cohort collectors untouched (they run through the projection on the same op, so a
  warn there would double-fire). Observability only — SQL row behavior unchanged.
- **#1666** (LOW, maintainability) — the cross-space write authorization guard
  (`validate_block_in_space`) used a raw runtime `sqlx::query_scalar` (no
  compile-time check), so a `blocks.space_id`/`page_id` schema change could silently
  alter a security-critical guard. Converted to the checked `query_scalar!` macro,
  preserving the `Option<Option<String>>` three-state via `COALESCE(...) AS "space?"`
  (nullable annotation) + `.fetch_optional`. New `.sqlx` cache entry generated.

## Review pass

Four adversarial reviewers, all four items verified correct with no defects
introduced; reviewers ran the real `cargo clippy --all-targets -- -D warnings`
gate (which caught a test-only lint in a previous batch) plus targeted nextest:

- **#1528 reviewer** traced the write-vs-read hash byte-equivalence (the high-risk
  item — a mismatch would force mass false cert regeneration) and confirmed
  identical DER bytes / digest / lowercase-hex on both sides.
- **#1666 reviewer** exhaustively traced the three-state auth mapping (no-row /
  NULL-space / matching / different-space) and confirmed `.sqlx` `nullable: [true]`,
  fail-closed posture intact — no cross-space hole.
- **#1582 reviewer** verified all three non-command paths route through the
  projection and that no cohort-collector path runs the depth-100 CTE without a
  corresponding saturation warn; confirmed the probe is read-only and depth-invariant.
- **#1575 reviewer** confirmed production boot goes only through `init_pools`, the
  DELETE runs after migrations, and the warn fires only on an actual leaked row.

## Gotcha (recorded)

Builder #1666 ran `cargo sqlx prepare` **without `-- --tests`**, which pruned ~210
test-only `.sqlx` entries (kept only the lib-reachable queries + its new one). The
offline `cargo check -p agaric` passed because that scope doesn't compile the
targets needing the pruned files — but CI's full build and the pre-push
`sqlx prepare --check -- --tests` would have failed. Fixed by regenerating with the
canonical `cargo sqlx prepare -- --tests`; net `.sqlx` change is now exactly the one
new query. Always use `-- --tests` (matches CI's `--check -- --tests`).

## Notes

- Files: `sync_cert.rs`, `db/pool.rs`, `loro/projection.rs`, `mcp/handler_utils.rs`
  (+ their tests) and one new `.sqlx` entry. No frontend/codegen beyond the `.sqlx`.
- Pushed serially with frontend batch 11 to avoid concurrent heavy pre-push (OOM).
