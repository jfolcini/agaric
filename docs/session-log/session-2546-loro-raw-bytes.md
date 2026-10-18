# Session 2546 — Loro bytes travel raw after a header frame (#5761)

**Set out to:** let a space past about 64 MB of Loro state sync (#5761).

**Premise held.** The issue's claims checked out against the code. One
correction: `transport/bulk.rs` carries only attachments, and the snapshot
catch-up sent its snapshots as ordinary `LoroSync` frames. The "snapshot blobs
ride bulk" lines were wrong in `sync-protocol-spec.md`, `sync-and-network.md`
and `operations.md`.

**Design:** `transport::session` owns the split, so no caller changes.
- `send_sync_message` writes a `LoroSync` as the existing
  `SyncMessage::LoroSyncChunked` frame (the header that
  `LoroSyncChunkedHeader::split` builds), then the bytes raw on the same stream.
- `send_sync_message` refuses bytes over `MAX_LORO_SYNC_PAYLOAD_SIZE` as
  `AppError::Validation` before writing anything (added in review).
- `recv_sync_message` reads the frame. It refuses a `size_bytes` over
  `MAX_LORO_SYNC_PAYLOAD_SIZE` as `AppError::Validation` before it reads or
  reserves anything. Then it reads exactly that many bytes with `read_body`,
  straight into the buffer the engine imports from, and returns the `LoroSync`.
- No new message type.
- `send_bulk` is not used. The payload is already one `Vec` in memory, and
  `read_body` already reserves exactly, in two steps, with no claim-bought
  allocation.
- `LoroSyncChunked` lost its dead `compressed` field. `set_size_bytes` and the
  JSON round-trips of `LoroSyncMessage` (tests that pinned a shape no longer on
  the wire) are deleted.

**Decision, peer compatibility:** `ENGINE_FORMAT_VERSION` 4 → 5, not a new
ALPN. The wire changed, so the version moves. The bump reuses #5728's coded
`EngineFormatMismatch` refusal at `HeadExchange` ("update both devices") with
no new machinery. An ALPN mismatch fails the QUIC handshake before any
application byte moves, so it shows as an unreachable device with no coded
message. Neither format 4 nor #5728 is in a release: 0.18.0 is format 3, and
it refuses a mismatched peer with the older uncoded text, as it did before. So
the bump protects only devices running builds from `main`, and only those pay
its cost: export stamps `5` into each doc, which a format-4 build refuses, so
their vaults cannot go back to a format-4 build.

**Decision, `Update` payloads:** always raw, one path. In the bench, a 92-byte
update took 41–43 µs new against 37 µs old in the two calm interleaved pairs.
That gap is inside the run-to-run band (old 37–504 µs, new 41–244 µs). Peak
heap fell from about 7.9 KB to 2.4 KB.

**Decision, `LORO_INLINE_MAX_BYTES`:** deleted with its "documentation
threshold" text. `OP_LOG_BATCH_INLINE_MAX_BYTES` keeps the 2,400,000 literal,
which still gates a live capability skip.

**Peak copies, per payload of S bytes.**
- Before: the sender held S plus a JSON `Vec` of about 3.5 S. The receiver held
  the frame (about 3.5 S), serde's `Content` buffering for two internally
  tagged enums, and the final S. Measured in one process: 831.6 MB of peak heap
  for S = 8.77 MB.
- Now: the sender holds S. The receiver holds S plus one 5 MB read buffer.
  Measured: 18.9–21.1 MB, with a realloc counted as holding both blocks.

**Bench** (`benches/groups/loro_wire_bench.rs`, the `loro_wire` group in
`engine_bench`):
- Fixture: a 100K-block snapshot of 8,769,422 bytes, sent over loopback QUIC.
- The old encoding was measured first with the same bench code, and that
  binary was kept for A/B runs.
- Build: `cargo bench --profile release-test`.
- The box was shared, with a load average between 4 and 47.
- `snapshot_send_receive`: old 469 ms – 2.42 s over seven runs (488 ms in the
  calmest); new 22–62 ms over three. Direction: 10–20× faster, beyond the noise.
- Peak heap, as above: about 40× lower.

**Reds**, each shown with a one-command mutation, then restored:
- The integration test `a_snapshot_past_the_old_frame_cap_syncs_over_quic_5761`
  (48 MiB of text, `handle_incoming_sync` against `run_sync_session`) failed on
  the old code: "message too large to send: 485436967 bytes" with 72 MiB of
  text, and 323623915 bytes at 48 MiB with the JSON send restored.
- The wire-shape pin failed on the JSON number array.
- Swallowing read errors failed the truncated-stream and short-read tests.
- `> cap + 1` and `>= cap` each failed the over-cap test.
- A wrong tail slice in `read_body` failed the size proptest, which shrank to
  5,000,001 bytes.
- Format 4 kept failed the peer-compatibility test: an old-format peer got
  `SyncComplete` instead of the refusal.
- The size proptest also ran once at 1000 cases.

**e2e-tauri:** `sync-raw-loro-bytes.e2e.ts`, a smoke test of the framing in
the real app, not a control for #5761: its payload fits the old JSON frame
too. The control is the QUIC integration test above. The peer writes 16 blocks
of 20,000 alphanumerics, the app pairs and pulls, and every block's text comes
back whole through `get_block`.
- The first version, 16 × 200,000 characters read from the DOM, failed in CI.
  The app's debug-build pull outlasted `waitPulled`'s 60 s, and the off-screen
  rows rendered as placeholders.
- Ran locally under Xvfb three times, green in 7.8–9.5 s.
- Red with `bytes.pop()` on every received payload: pairing failed, since
  its pull is a `LoroSync` too. Red with the same cut applied only above
  100,000 bytes: `waitPulled` timed out, as predicted.

**Why the 200,000-character pull stalled** (a probe in `agaric-engine`, not
committed):
- An import into a doc with concurrent local ops (the app's own ops, which the
  peer had pulled first) is quadratic in a block's text length.
  - debug: 1.5 s at 20,000 characters, 119 s at 200,000.
  - `release-test`: 28 ms, 234 ms and 2.8 s at 20,000, 60,000 and 200,000.
- Into an empty doc the same import is linear: 107 ms debug, 12 ms release at
  200,000.
- A plain `LoroEngine::import`, with no subscription, no materializer and no
  SQL, is just as slow. The cost is inside Loro's import, in the richtext
  `DiffCalculator`/`Tracker` the reviewer's sample caught.
- So it is real in a release-like build, not debug-only: extrapolated, about
  0.3 s per block at the 256 KiB content cap. Not fixed here.

**Review fixes:**
- The sender-side cap went red when disabled: the send waited 30 s on a peer
  that never read.
- Fixed round trips at 0, 1, either side of 5,000,000 and of 10,000,000, and
  at the cap. They went red on `>= cap` at the sender and on a wrong tail slice
  in `read_body`, which failed at 5,000,001 bytes.
- The 64 MB rationale now lives only in the `transport::session` module docs.
- Fixed stale copies in `crdt-and-recovery.md`, `transport/mod.rs` and the
  bulk-equivalence baseline. The baseline's generator keeps reasons as written,
  so its one reason was edited by hand.

**Out of scope:** the orchestrator handles the `interactive_slo` bench-slo
dispatch and the Android emulator pairing.
