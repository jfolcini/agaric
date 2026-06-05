## Session 984 — release-build guard for the global apply cursor vs per-device seq (#412) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#412` (guard; full per-device-cursor fix deferred) |
| **Dimension** | correctness (latent until multi-device sync ships; P1 debt) |
| **Tests added** | +1 (multi-device replay rejected) |
| **Files touched** | 3 + 1 `.sqlx` |
| **Schema / wire-format** | none (no migration) |

**Summary:** `materializer_apply_cursor` is a single global scalar
`materialized_through_seq`, and replay selects `op_log WHERE seq > cursor`. But
`seq` is a PER-DEVICE counter (PK `(device_id, seq)`): with two devices
(A/1,A/2,B/1,B/2), after applying device A the cursor sits at 2 and
`WHERE seq > 2` returns ZERO rows — device B's ops are **silently never
replayed**. This is latent today (sync is dormant, the remote-apply path is
test-only, a `debug_assert!` already marks the single-device-batch assumption)
but becomes a hard correctness wall the moment multi-device sync ships.

The **full** fix — a per-device watermark cursor + `WHERE device_id = ? AND
seq > ?` replay — is a schema migration + replay rewrite gated by AGENTS.md
arch-stability and only needed once multi-device sync ships; it stays deferred.
This lands the recommendation's "until then" **guard** so the latent bug
surfaces loudly instead of silently dropping ops:

1. **Read/replay side (`recovery/replay.rs`, the cited location):**
   `replay_unmaterialized_ops` now counts `DISTINCT device_id` in `op_log` and,
   if > 1, logs `error!` and returns `AppError::InvalidOperation` — failing boot
   loudly rather than silently dropping another device's ops.
2. **Write side (`materializer/handlers.rs`):** the `BatchApplyOps`
   single-device `debug_assert!` gains a release-build counterpart that returns
   `AppError::InvalidOperation` on a mixed-device batch.

**No production false-positive:** today's single-device build has exactly one
`device_id` in `op_log`; the guard only trips if multi-device sync is enabled
before the per-device cursor lands — exactly the situation that must fail.

**Files touched:**
- `recovery/replay.rs` — multi-device `op_log` guard at the replay entry.
- `materializer/handlers.rs` — release-build mixed-device-batch guard.
- `recovery/tests.rs` — `replay_rejects_multi_device_op_log_412`.
- `src-tauri/.sqlx/query-5f60….json` — cache entry for the new `COUNT(DISTINCT device_id)` query (regenerated against a freshly-migrated DB; only the one new entry added).

**Verification:**
- New `replay_rejects_multi_device_op_log_412` (A/1,A/2,B/1,B/2 → `InvalidOperation` referencing #412); existing single-device `replay_walks_unmaterialized_ops_c2b` and the full `recovery::` suite still pass (**52 passed**). Offline build (`SQLX_OFFLINE=true`) clean — CI's offline `.sqlx` build is satisfied. clippy + rustfmt clean.

**Commit plan:** single commit (incl. the new `.sqlx`); branched off `main`; PR against `main`.
