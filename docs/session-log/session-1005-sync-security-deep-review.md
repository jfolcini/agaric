# Session 1005 — /batch-issues loop: sync-security hardening, batch 6 (2026-06-19)

## What happened

Sixth batch of the `/loop /batch-issues` run: three backend sync/TLS-security findings
from the multi-agent deep review, built by parallel subagents (≤2 concurrent Rust to
respect the cargo target lock) and adversarially reviewed.

## Shipped

Single PR `fix/sync-security-deep-review`:

- **#1601** — `SyncCert` (the struct actually holding the plaintext device private key,
  in `sync_net/tls.rs`) and its `PersistedCert` wrapper derived `Debug`, so a future
  `error!("{cert:?}")` / un-`skip`ped `#[instrument]` would dump the key; replaced the
  derive with a manual `impl Debug` that redacts `key_pem` while still showing the public
  `cert_pem`/`cert_hash`. (Reviewer confirmed `cert_pem` holds only the certificate, not
  a combined cert+key PEM — no re-leak.)
- **#1602** — `upsert_peer_ref_with_cert` persisted the TOFU pin with no format check,
  asymmetric with `read_existing_cert`; added the same 64-char ASCII-hex guard before any
  DB write. (Two `sync_daemon` tests passed non-hex placeholder pins and were corrected to
  valid hex without weakening their mismatch/cert-less assertions.)
- **#1604** — both certificate-CN sites (`tls.rs verify_server_cert`, `websocket.rs`
  peer-CN extraction) accepted CN `agaric-` with an empty device id; now require a
  non-empty remainder (device ids are free-form UUIDs, so non-empty is the correct minimal
  gate — full UUID validation would false-reject legit test CNs). Empty → same negative
  result as a non-`agaric-` CN, which is strictly safer for downstream pinning.

## Review pass

Three adversarial reviewers. The **#1604 reviewer fixed a `clippy::collapsible_if`
warning** the builder introduced (would have red the pre-push hook) and added the missing
**websocket-site** empty-id test (the builder tested only the tls site). The #1601
reviewer verified the subtle PEM-concatenation non-leak; the #1602 reviewer verified the
test-fixture edits didn't weaken assertions.

## Notes

- Files: `sync_net/tls.rs`, `sync_cert.rs`, `peer_refs.rs`, `sync_net/websocket.rs`
  (+ test files). #1601 and #1604 both touch `tls.rs` (different regions) and were run
  sequentially to avoid a parallel-edit conflict. `cargo clippy --lib` + `check
  --all-targets` clean; targeted suite 77/77 pass. No new SQL → no `.sqlx` regen.
