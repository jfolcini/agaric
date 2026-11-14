# Session 4117 — the sync peer's pull runs past a backoff

The real-backend spec "unpairing refuses the peer's next sync and drops only this device's row" (`e2e-tauri/sync-two-device.e2e.ts`) failed once on a PR that touches no sync code: `waited 60s for the app to refuse this vault's pull; the daemon reported no error`. The task was the root cause, not a retry.

## What happened

It was the test peer (`e2e_sync_peer`), not the app. The app refuses an unpaired device's dial at once; the peer never dialled.

The spec before it, "after a restart the state card shows the last sync before any new one", freezes the peer while the app restarts. When the peer thaws, each device discovers the other and both dial in the same few milliseconds. In the failing run the app's dial took the lock first, so the app refused the peer's dial as busy. A busy refusal is reported nowhere, but it books the dialler's backoff, about two seconds after one failure.

The unpair spec then reached `peer.syncRefused()` about a second and a half after the thaw. `sync_refused` only woke the peer's daemon (`notify_change`); the round it woke ran inside the backoff, `may_retry` skipped the app, and the wake was spent. The peer runs with `NO_PERIODIC_PULL`, so nothing dials again, and the command timed out at 60 s.

The run's own logs show it: the peer books the busy failure at `22:55:19.427`, neither log holds a connection after `22:55:19.44`, and the 60 s wait ends at `22:56:20.9`.

A second failure of the same spec, on #6724 (run `43525977672`), reads the same way: both devices discover each other at `23:29:13.902`, both dials are refused as busy, both book a backoff at `23:29:13.940`, and the peer dials nothing after.

Why now: #6710 added the restart spec, which stages that crossed dial right before the unpair spec. #6676 had made the app's own Sync press clear the backoff before it wakes the daemon (`start_sync_inner`, `user_initiated`), while the peer's `sync` and `sync_refused`, documented as waking the daemon "as `start_sync` does", kept the bare wake.

## What was ruled out

- The dial did not go to a stale address or port (#6703): the app bound once after the restart, and the peer's refused dial two seconds before had reached it.
- No refusal was lost on the way back (#6687): no connection arrived for the app to refuse.
- The app is not at fault. With two peer processes here, an unpaired device's dial is refused in about half a second once the backoff has run out.

The product was left alone. In the app the same skipped wake is picked up by the next resync round, a minute at most; the peer turns that round off on purpose, so its explicit commands are its only dial.

## The fix

`pull_now` in `e2e_sync_peer.rs`: `sync` and `sync_refused` clear the app's backoff and then wake the daemon, as the app's Sync press does. One unit test pins it, shown red by deleting the clear (`the round the pull wakes may dial the app`).

No spec changed, and no wait was lengthened or retried.

## Reproduction

The WebdriverIO lane cannot run in this container (no `WebKitWebDriver`, no `tauri-driver`), so the failure was staged with two `e2e_sync_peer` processes driven by a scratch script, not committed: one hosts the pairing and plays the app, the other joins. The host is frozen, the joiner's `sync_refused` dial times out and books a backoff, the host is thawed and unpaired (its `peer_refs` row deleted, which is all `delete_peer_ref` does), and the joiner is sent `sync_refused` again at once.

- Binary from `origin/main` (`eb66161`): 4 of 4 rounds waited 60 s and failed with the run's exact message.
- The same binary, with 3 s of waiting before the unpair: 2 of 2 refused in about 0.5 s.
- Binary with the fix: 20 of 20 refused in about 0.5 s with `peer not paired with this device`.

## Traps

- This container has no LAN address the bind policy accepts (`eth0` is `192.0.2.2`), so the daemon binds loopback and announces nothing on mDNS. A pairing by QR still works, because the QR carries the address; the crossed dial at a thaw cannot be staged, since it starts from discovery.
- The debug build, the test build, `cargo check --all-targets` and clippy filled the disk during `just gen-bindings`. `rm -rf src-tauri/target/debug/incremental` freed it.

## Ran

On `eb66161` plus this change, and again with `main` at `67d9b68` merged in (it brought Rust changes, one of them a line in `e2e_sync_peer.rs`): `cargo nextest run --workspace` in two halves (4039 and 4033 tests pass, then 4047 and 4040), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-sqlx` and `just gen-bindings` (no diff), `npm run typecheck`, `npm run lint`, `prek run --hook-stage manual --all-files`. Not run: vitest, Playwright (no frontend file changed), and WebdriverIO, which the PR's `e2e-tauri-gate` runs.

`main` moved once more before the push (`ddbbd1b`, #6731, the synced purge). It merged clean and touches neither the peer binary nor the scheduler. On that tree only the peer binary's own tests (22 pass) and the pre-push hooks ran; CI's run on the PR is the check of the whole.
