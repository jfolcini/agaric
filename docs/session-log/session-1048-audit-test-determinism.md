# Session 1048 — audit fix #1271: remove wall-clock sleeps from page_integration tests

2026-06-16. From the 2026-06 Opus quality audit (testing/determinism). `/loop /batch-issues` run.

## Finding
4 `tokio::time::sleep(2ms)` calls in `command_integration_tests/page_integration.rs`
existed to avoid same-millisecond `created_at` collisions — violating the project's
test-determinism rule.

## Fix — the sleeps were dead weight
The restore query (`commands/history.rs:546-591`) orders/filters by the full tuple
`(created_at, seq, device_id)`, never `created_at` alone. All ops in these tests are
single-device (`DEV`), and `seq` is strictly monotonic per device
(`COALESCE(MAX(seq),0)+1` under `BEGIN IMMEDIATE`). So same-ms ops are fully ordered by
the `seq` tiebreaker — the sleeps never affected correctness (same conclusion as undo_redo
TEST-24). Removed all 4; replaced with explanatory comments. No timestamp-injection seam
needed; no assertion weakened.

## Verification
Reviewer confirmed the seq tiebreaker (quoted the ORDER BY/WHERE), monotonicity, and
single-device, ran page_integration **5× with no flake**, and the full Rust suite (4173
passed). No `sleep` remains in the file.
