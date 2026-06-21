# Validated Robustness Report — Agaric

## Verdict tally
- CONFIRMED: 2 (both LOW, both correctly rated / WONTFIX-leaning)
- CONFIRMED-BUT-RESEVERITY: 0
- EXAGGERATED: 0
- ALREADY-HANDLED: 0
- HALLUCINATED: 0
- Spot-checks of "all false positives" claim: 4 sampled, all upheld
- Coverage-gap probe (sync_net): no new issue found

The raw report is honest and accurate. It did not under-rate or wave away anything I could find. This is a genuinely robust scope and the "essentially nothing" conclusion is correct.

---

## Finding 1 — [LOW] op_log bypass relies on straight-line enable/disable, not RAII
**Verdict: CONFIRMED (severity correct; WONTFIX-leaning).**

Evidence read:
- `src-tauri/src/op_log/bypass.rs:18-47` — enable INSERTs sentinel, disable DELETEs. Doc-comment explicitly states the caller contract and that a committed sentinel "would silently grant every subsequent connection a global bypass."
- `src-tauri/src/snapshot/restore.rs:205-207` — straight-line enable → `DELETE FROM op_log` → disable, all inside one tx (H-13 comment).
- `src-tauri/src/db/pool.rs:383-400` — `clear_leaked_bypass_sentinel` boot backstop: DELETEs any leaked sentinel after migrations, before serving traffic, and warns.

Assessment: The raw agent's characterization is precise. In current code this is NOT a live bug — both call sites are straight-line, any error rolls back the whole tx (and the sentinel INSERT with it), and the boot backstop catches a crash-leaked sentinel. It is a latent-maintenance hazard only. LOW + likely-WONTFIX is the right call. The optional RAII fix is reasonable but the project's stated aversion to over-engineering plus the existing triple-defense (straight-line + tx-rollback + boot cleanup) justifies deferring.

## Finding 2 — [LOW] Sync file-transfer failures swallowed as non-fatal; "Complete" still reported
**Verdict: CONFIRMED (severity correct; design choice, WONTFIX-leaning).**

Evidence read:
- `src-tauri/src/sync_daemon/orchestrator.rs:1088-1096` — `Err(e) => warn!("initiator file transfer failed (non-fatal)")`; `_ => warn!("could not determine app_data_dir, skipping file transfer")`. Function then returns `Ok(())` (line 1100), so session reports Complete.

Assessment: Accurate. No data loss (op-log + metadata intact; only attachment blobs lag, reconciled by sync GC). This matches the documented graceful-degradation design. The optional fix (a distinct `AttachmentsPending { n }` SyncEvent for UX) is a legitimate small enhancement, not a defect. LOW is correct.

---

## Spot-checks of the "all false positives" clearance claim
I independently re-verified the riskiest cleared items; all upheld:

1. **zstd decompression-bomb bounds** — UPHELD. `snapshot/codec.rs:36-47` defines `MAX_DECOMPRESSION_RATIO=100`, `DECOMPRESSION_SLACK=64MB`, `DECODER_WINDOW_LOG_MAX=27`; ratio limiter at lines 124-150 errors cleanly (`AppError::Snapshot`) on a bomb. Real, well-reasoned (#428).
2. **React error boundary mounting** — UPHELD. `src/main.tsx:60-81` mounts `<ErrorBoundary>` at root, plus global `error` + `unhandledrejection` handlers (lines 16-30). Not a false clearance.
3. **Single production `.unwrap()` unreachable** — UPHELD. `recovery/draft_recovery.rs:277` `heads.into_iter().next().unwrap()` is inside the `1 =>` match arm (provably non-empty). Safe.
4. **op_log bypass boot backstop** — UPHELD (see Finding 1).

## Coverage-gap probe — sync_net (admitted not line-audited)
Quick targeted probe, no broad re-audit:
- Production `sync_net/` has **zero** `.unwrap()/.expect()/panic!/unreachable!` (grep, excluding tests).
- `sync_net/websocket.rs:302-359` — `SyncServer` holds `shutdown_tx` + `join_handle`; accept loop is semaphore-bounded (#1581, permit acquired before handshake spawn) with exponential backoff on accept failure.
- `websocket.rs:525-529` — `shutdown()` takes `shutdown_tx` and the `join_handle`, giving a clean teardown path (no obvious task/FD leak).

No obvious unguarded panic or leak surfaced. A full framing/TLS-handshake line-audit remains genuinely unreviewed (as the raw report admitted), but nothing jumped out in the quick pass.

---

## Net assessment
Nothing here is worth filing as a GitHub issue at meaningful priority. Both LOW findings are real but correctly self-flagged as defense-in-depth / intentional-design and lean WONTFIX. If anything is filed, rank:
1. (Optional, S) RAII scope-guard for the op_log bypass sentinel — purely latent-maintenance hardening.
2. (Optional, M) `AttachmentsPending` SyncEvent for honest "N attachments still syncing" UX.

The raw agent did not over-rate or under-rate; its skepticism was calibrated. The one residual real coverage gap is the sync_net websocket framing / TLS handshake internals, which warrant a dedicated future pass but produced no quick-win finding.
