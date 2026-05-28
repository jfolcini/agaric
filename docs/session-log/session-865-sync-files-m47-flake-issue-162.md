## Session 865 — flake fix: `run_file_transfer_initiator_breaks_on_cancel_m47` (#162) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | #162 |
| **Items modified** | — |
| **Tests added** | 0 (test edit only — order-sensitive assertion → set-equality assertion) |
| **Files touched** | 2 |

**Summary:** Fixes the ~30% flake of `sync_files::tests::run_file_transfer_initiator_breaks_on_cancel_m47` reported in #162. Root cause is **not** a cancel-propagation race — it's that the test's mock responder asserted `attachment_ids == ["ATT_M47_1", "ATT_M47_2"]` (order-sensitive), while `find_missing_attachments` fans the per-row metadata probe through `futures::stream::buffer_unordered(16)` (`sync_files.rs:237`), so the order in which probes complete (and hence the order in which IDs land in the returned `Vec`) is non-deterministic across runs.

**Diagnosis path:**
1. Reproduced the flake: 4/15 first-attempt failures with `cargo nextest run -E 'test(/run_file_transfer_initiator_breaks_on_cancel_m47/)' --no-fail-fast`.
2. Captured the failure mode with `--retries 0`: the assertion that fired was always *"M-47 setup: both attachments must be requested"* — the responder's `FileRequest` arrival assertion at `tests.rs:1768`, not any of the cancel-effect assertions further down. That ruled out the issue title's "suspected root cause" (cancel-propagation race).
3. Inspected `find_missing_attachments` → `buffer_unordered(16)` collects probes in completion order, not source order. With two attachments inserted in 1→2 order but probed concurrently, the returned `Vec` order is whichever probe's `tokio::fs::metadata` future finishes first.

**Fix shape:** sort `attachment_ids` in the responder before the equality check. The receiver loop does not depend on request order (each `FileOffer` carries its own `attachment_id` and the receiver looks up `AttachmentReceiveMeta` by ID), so the production-side ordering is genuinely irrelevant — the test was the only callsite imposing an order constraint.

**Why not change `find_missing_attachments`:** the existing test `find_missing_attachments_concurrent_probe_set_equality` (`tests.rs:1193`) explicitly pins set-equality (not order) as the contract, and a stable sort would add overhead on the boot-time scan of vaults with thousands of attachments. The function's downstream consumers (`FileRequest` → peer → `FileOffer` matched-by-id) do not care about order.

**Files touched (this session):**
- `src-tauri/src/sync_files/tests.rs` (+5 net — sort `attachment_ids` before equality check; added a 3-line comment citing the `buffer_unordered(16)` source line so a future reader does not file the same bug)
- `docs/session-log/session-865-…md` (new — this log)

**Verification:**
- 30/30 runs clean under `cargo nextest run -E 'test(/run_file_transfer_initiator_breaks_on_cancel_m47/)' --no-fail-fast --retries 0` (was 4/15 first-attempt failures before the fix).
- pre-commit + pre-push hooks will run on commit/push.

**Lessons learned (for future sessions):** when a flake's reproduction shows a wide variety of failure messages, that's the cancel-race shape; when every failure shows the **same** assertion text, the issue is almost always an order/timing dependency in that one assertion (deterministic at the level of "this assert fails", non-deterministic in the bool). The issue's suspected root cause was the former hypothesis and turned out to be the latter — running `--retries 0` once to read the actual assertion was decisive.

**Commit plan:** single commit on branch `fix/sync-cancel-race-162`; PR against `main`. Closes #162.
