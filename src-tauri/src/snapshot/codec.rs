use std::cell::Cell;
use std::io::Read;
use std::rc::Rc;

use super::types::{SCHEMA_VERSION, SnapshotData};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// #428 — decompression-bomb bounds
// ---------------------------------------------------------------------------
//
// `decode_snapshot` used to feed a bare `zstd::Decoder` straight to ciborium
// with NO bound on the decompressed byte count or the zstd window. The only
// upstream guard caps the *compressed* blob at `MAX_SNAPSHOT_SIZE` (256 MB),
// but zstd routinely hits 10-100x on repetitive CBOR, so a compromised/buggy
// *already-paired* peer (the transport is mTLS + TOFU cert-pinned, so not an
// arbitrary network attacker) could advertise a sub-256 MB blob that expands
// into a multi-GB `SnapshotData` — an allocation-driven crash instead of a
// clean rejection.
//
// Fix: cap the decompression *ratio* on the fly. We never know the legitimate
// decompressed size up front (it scales with vault size, not the 256 MB
// compressed figure — see the audit), so a fixed absolute ceiling would either
// reject huge-but-legit vaults or still permit a multi-GB blow-up. Instead we
// count compressed bytes pulled and decompressed bytes produced and reject once
// `decompressed > compressed * MAX_DECOMPRESSION_RATIO + DECOMPRESSION_SLACK`.
// Real snapshots carry high-entropy ULIDs and hashes and compress only a few x,
// far under the ratio; a bomb (tiny blob → GBs) trips the bound after at most
// ~`DECOMPRESSION_SLACK` bytes. `window_log_max` additionally caps the zstd
// window memory.

/// Max tolerated zstd decompression ratio (decompressed / compressed). Our
/// own level-3 encoder on real snapshot CBOR (distinct ULIDs / content hashes)
/// compresses only single-digit×; 100× leaves a very wide margin for legit data
/// while still catching a decompression bomb long before it can exhaust memory.
const MAX_DECOMPRESSION_RATIO: u64 = 100;

/// Absolute headroom added to the ratio bound so a legitimate stream is never
/// falsely tripped by zstd's internal read-ahead (it emits decompressed output
/// slightly before the matching compressed bytes have been pulled through the
/// counter). Also bounds the degenerate "almost no compressed input" case.
const DECOMPRESSION_SLACK: u64 = 64 * 1024 * 1024;

/// Cap the zstd decompression window at 2^27 = 128 MB. Our level-3 encoder uses
/// a far smaller window, so this never rejects a snapshot we produced; it just
/// refuses a frame whose header demands an outsized window allocation.
const DECODER_WINDOW_LOG_MAX: u32 = 27;

/// Counts the bytes pulled from the wrapped (compressed) reader into a shared
/// cell, so the ratio limiter downstream can see how much compressed input has
/// actually been consumed. See [`RatioLimitedReader`].
struct CompressedCounter<R> {
    inner: R,
    consumed: Rc<Cell<u64>>,
}

impl<R: Read> Read for CompressedCounter<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.consumed
            .set(self.consumed.get().saturating_add(n as u64));
        Ok(n)
    }
}

/// Wraps the zstd decoder's *output* and errors once the decompressed byte
/// count exceeds `compressed_consumed * MAX_DECOMPRESSION_RATIO +
/// DECOMPRESSION_SLACK`. The error surfaces through `ciborium::from_reader` as
/// a decode failure, which [`decode_snapshot`] maps to `AppError::Snapshot` —
/// a clean rejection instead of an OOM abort (#428).
struct RatioLimitedReader<R> {
    inner: R,
    compressed_consumed: Rc<Cell<u64>>,
    decompressed: u64,
}

impl<R: Read> Read for RatioLimitedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.decompressed = self.decompressed.saturating_add(n as u64);
        let allowed = self
            .compressed_consumed
            .get()
            .saturating_mul(MAX_DECOMPRESSION_RATIO)
            .saturating_add(DECOMPRESSION_SLACK);
        if self.decompressed > allowed {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "snapshot decompression exceeded the {MAX_DECOMPRESSION_RATIO}x ratio bound \
                     ({} bytes decompressed from {} compressed) — possible decompression bomb",
                    self.decompressed,
                    self.compressed_consumed.get(),
                ),
            ));
        }
        Ok(n)
    }
}

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

/// Encode SnapshotData to zstd-compressed CBOR bytes.
///
/// **#416 — streaming encoder.** The CBOR is serialised *directly into*
/// the zstd encoder rather than into an intermediate `Vec<u8>` that is
/// then handed to `zstd::encode_all`. The old shape held two full
/// transient buffers simultaneously — the uncompressed CBOR (`cbor_buf`)
/// *and* the compressed output — on top of the `SnapshotData` Vecs, i.e.
/// three materialisations of the derived state at peak. Streaming drops
/// the uncompressed CBOR buffer (the largest of the three): at peak only
/// the `SnapshotData` (the caller's working set) and the compressed
/// output Vec are live.
///
/// This is **not** a wire-format change: the output is still a single
/// zstd frame wrapping the same one CBOR value, and [`decode_snapshot`]
/// already decodes it via a streaming reader. The encoding stays
/// deterministic (same input → identical bytes), so the
/// `snapshot_encode_deterministic` / `snapshot_cbor_roundtrip` property
/// tests continue to hold.
///
/// A fully streaming snapshot *format* (row-batched CBOR frames so the
/// `SnapshotData` Vecs themselves never fully materialise on create) is
/// a wire-format change gated by AGENTS.md "Architectural Stability" and
/// remains deferred (#416); the `encode_snapshot` 100k-scale bench is in
/// place to gate that decision on a measured budget.
#[must_use = "encoded bytes must be stored or transmitted"]
pub fn encode_snapshot(data: &SnapshotData) -> Result<Vec<u8>, AppError> {
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3)
        .map_err(|e| AppError::Snapshot(format!("zstd encoder init: {e}")))?;
    ciborium::into_writer(data, &mut encoder)
        .map_err(|e| AppError::Snapshot(format!("CBOR encode: {e}")))?;
    let compressed = encoder
        .finish()
        .map_err(|e| AppError::Snapshot(format!("zstd compress: {e}")))?;
    Ok(compressed)
}

/// Decode zstd-compressed CBOR bytes to `SnapshotData`.
///
/// **L-67 — streaming decoder.** The reader is wrapped in
/// [`zstd::stream::Decoder`] (lazy decompression) and that decoder
/// is fed straight to `ciborium::from_reader`, so neither the
/// compressed bytes nor the decompressed bytes are ever fully
/// materialised on the heap. The only allocation is the
/// `SnapshotData` itself (which is unavoidable — it is the
/// downstream caller's working set).
///
/// The buffered `&[u8]` shape is still cheap because `&[u8]: Read`,
/// so call sites pass `&compressed[..]` (or `compressed.as_slice()`)
/// for a one-character migration. Production callers
/// ([`sync_daemon::snapshot_transfer::try_receive_snapshot_catchup`])
/// pass a `std::fs::File` opened on the temp file the binary
/// stream was written into — the only buffer in flight is the
/// per-frame chunk inside `receive_binary_streaming`.
///
/// `R: Read` is intentionally NOT bounded by `Send` or `'static`:
/// `decode_snapshot` consumes the reader entirely on the calling
/// task; no spawn-blocking is involved, so the looser bound is
/// correct.
#[must_use = "decoded snapshot data must be applied or inspected"]
pub fn decode_snapshot<R: Read>(reader: R) -> Result<SnapshotData, AppError> {
    // Streaming zstd decoder: pulls compressed bytes from `reader`
    // on demand and surfaces the decompressed CBOR stream lazily.
    // Crucially, the decoder is not given a `decode_all`-style
    // buffer — `ciborium::from_reader` reads ONE CBOR value off
    // the decoder, so as soon as the snapshot has been parsed the
    // remaining decompressor state is dropped.
    // #428: count compressed bytes pulled, cap the window, and bound the
    // decompression ratio so a bomb is rejected (clean `AppError::Snapshot`)
    // rather than allowed to OOM.
    let compressed_consumed = Rc::new(Cell::new(0u64));
    let counted = CompressedCounter {
        inner: reader,
        consumed: Rc::clone(&compressed_consumed),
    };
    let mut zstd_decoder = zstd::stream::Decoder::new(counted)
        .map_err(|e| AppError::Snapshot(format!("zstd decompress: {e}")))?;
    zstd_decoder
        .window_log_max(DECODER_WINDOW_LOG_MAX)
        .map_err(|e| AppError::Snapshot(format!("zstd window cap: {e}")))?;
    let bounded = RatioLimitedReader {
        inner: zstd_decoder,
        compressed_consumed,
        decompressed: 0,
    };
    let snapshot: SnapshotData = ciborium::from_reader(bounded)
        .map_err(|e| AppError::Snapshot(format!("CBOR decode: {e}")))?;
    if snapshot.schema_version < 1 || snapshot.schema_version > SCHEMA_VERSION {
        return Err(AppError::Snapshot(format!(
            "unsupported schema version {} (expected 1..={SCHEMA_VERSION})",
            snapshot.schema_version
        )));
    }
    Ok(snapshot)
}
