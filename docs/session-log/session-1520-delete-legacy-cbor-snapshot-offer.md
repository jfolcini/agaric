# Session 1520 — the legacy CBOR `SnapshotOffer` path is deleted

Issue #3487. The pre-#2503 CBOR catch-up path survived as a shim for peers that could still send
it. The iroh cutover ended that: `SYNC_ALPN` is negotiated before any application byte moves, so
a build predating the ALPN cannot establish a session at all. **-3078 / +169.**

## Why the retained-dead-variant precedent did not apply

`types.rs` keeps `LoroSyncChunked` deliberately, so a chunking-era peer is "decoded and rejected
explicitly rather than as an unknown `type` tag — same contract as `SnapshotOffer`". That
sentence reads like an argument against this deletion. It is not, and the distinction is the
whole reason #3487 is safe:

- `LoroSyncChunked` was removed **by** the iroh port, so peers either side of that change share
  `SYNC_ALPN` and **can** still connect.
- `SnapshotOffer` is pre-#2503, predating the ALPN entirely. Such a peer fails the QUIC handshake.

`LoroSyncChunked` is therefore untouched. The only edit near it was one comment phrase that
pointed at the deleted variant.

`SyncMessage` is `#[serde(tag = "type")]` — tagged by NAME, not variant order — so the issue's
"keep the variant numbering story straight" caution resolves to nothing: removing a variant is
not a wire-position change for the others.

## The issue's own file list and constraints were partly wrong

**`sync_daemon/server.rs` has zero `SnapshotOffer` references** and always did. The issue lists it
as "responder side"; the responder already only calls `try_offer_loro_snapshot_catchup`. Real
count: 99 references across 11 files, not "80 across 7". 13 survive, all deliberate prose.

**Constraint 2 is factually inverted.** The issue says `MAX_SNAPSHOT_SIZE` "is a cap on the
*current* path, not the legacy one". On the pre-change tree its only non-test uses were the
`size_bytes > MAX_SNAPSHOT_SIZE` check on the legacy `SnapshotOffer`, the `recv_bulk` backstop in
`receive_snapshot_to_temp` (reachable only from that arm), and the `Rejected` error text. The Loro
path never touched it — its bound is `transport::session::MAX_FRAME_SIZE`, independent and
untouched. #2538's bug class dies with the path too: `Rejected` was constructible only from an
over-cap `SnapshotOffer`.

It was kept anyway, because the constraint was explicit. The consequence is recorded in #4692
rather than acted on unilaterally: `MAX_SNAPSHOT_SIZE`, `CatchupOutcome::Rejected` and its
supervisor arm, and `SnapshotAccept` / `SnapshotReject` are now **unreachable** rather than merely
unused — which is the anti-pattern AGENTS.md names ("a branch that cannot be taken; delete the
code"). All are `pub`, so nothing warns and the build stays green, which is exactly how such code
becomes permanent — the failure mode #3487 was filed to prevent.

## Tests: per-test, never as a group

`snapshot_transfer_tests.rs` interleaves the current Loro catch-up with the legacy CBOR one, and
`ResetRequired` is the least-exercised branch in the session FSM. 16 deleted, 12 kept, each read
individually.

The one judgement call worth recording: `run_catchup_with_ids` backed six surviving tests covering
`try_receive_snapshot_catchup`'s #4097 identity resolution — precisely the coverage the issue calls
least affordable to lose. It was **re-scripted, not deleted**: the CBOR responder became a Loro
one, and it now passes `Some(EngineReloadCtx)` where it used to pass `None`, so it exercises more
than before. No new helper, no new abstraction.

Also kept deliberately: `sweep_orphaned_snapshot_temps` and its two tests. No build creates
`snapshot-recv-*.tmp` any more, but a vault carried over from a pre-#3487 build can still hold a
stranded 256 MB orphan. Named victim, so it earns its keep.

## Falsification

Three mutations, each against a `cp` backup, each restored and `cmp`-verified byte-identical.

- **A** — drop the #4097 identity fallback: 3 of 4 targeted tests red, including two of the
  re-scripted six. That is what proves the re-scripting did not hollow them out.
- **C** — merge into a throwaway registry instead of the live one: `#2503: the responder's block
  must be merged into the engine` red.
- **B** — drop the `changed_page_ids` accumulation: **survived**. All 7 catch-up tests still
  passed. A pre-existing coverage gap, not introduced here, reported rather than papered over.

## Verified

`cargo nextest run -p agaric-sync`: **1095 passed**, 1 skipped. `cargo check --workspace
--all-targets`: 0 warnings. `cargo clippy -p agaric-sync --all-targets`: 0 warnings — run
explicitly because a removed `#[expect(clippy::too_many_lines)]` fails closed once its function
shrinks.

The tauri-mock and the conformance fixtures reference nothing here: `SnapshotOffer` is a wire
message, never an IPC surface.
