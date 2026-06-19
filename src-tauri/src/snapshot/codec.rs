use std::cell::Cell;
use std::io::Read;
use std::rc::Rc;

use super::types::SnapshotData;
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

// ---------------------------------------------------------------------------
// #1586 — content checksum (silent bit-rot detection)
// ---------------------------------------------------------------------------
//
// The pre-#1586 wire format was a *bare* zstd frame wrapping one CBOR value,
// with no trailing integrity digest. zstd's frame checksum is optional and was
// not enabled, and CBOR is a self-describing format — so a single flipped bit
// *inside* an otherwise-valid frame can decompress and structurally parse into
// a **silently corrupted** `SnapshotData` that `decode_snapshot` happily
// returns. A snapshot is the recovery-of-last-resort artifact, so undetected
// bit-rot there is the worst-case data-integrity failure.
//
// Fix: a new framed format that prepends a fixed-size header carrying a blake3
// digest of the compressed zstd payload. `decode_snapshot` recomputes the
// digest over the bytes it reads and rejects a mismatch with a clear
// `AppError::Snapshot("snapshot checksum mismatch …")`.
//
// **Back-compat (mandatory).** Existing stored snapshots are bare zstd frames,
// which always begin with the 4-byte zstd magic `28 B5 2F FD`. The new format
// is distinguished by an 8-byte ASCII magic `AGSNAP01` whose first byte is
// `0x41` ('A') — so an old blob can *never* be misread as new, and the new
// magic can never collide with a zstd frame start. `decode_snapshot` peeks the
// leading bytes: a new-format magic → verify the trailing-free leading digest;
// anything else → fall through to the legacy bare-zstd path verbatim (no digest
// check), exactly as before. The op-frontier hash (`up_to_hash`) lives *inside*
// the CBOR payload and is unchanged — this checksum is an orthogonal
// payload-integrity digest over the stored bytes.

/// 8-byte magic marking a #1586 checksummed snapshot. Chosen so its first byte
/// (`0x41` = 'A') differs from the zstd frame magic's first byte (`0x28`), so a
/// legacy bare-zstd blob is never misclassified as new-format and vice versa.
pub(super) const SNAPSHOT_MAGIC: [u8; 8] = *b"AGSNAP01";

/// Length of the blake3 digest stored in the new-format header (256-bit).
const SNAPSHOT_DIGEST_LEN: usize = 32;

/// Full new-format header length: magic (8) + digest (32). Exposed to the
/// sibling test module so it can carve the legacy bare-zstd payload out of a
/// new-format blob (back-compat fixture) and target the payload region for
/// bit-flip corruption tests.
pub(super) const SNAPSHOT_HEADER_LEN: usize = SNAPSHOT_MAGIC.len() + SNAPSHOT_DIGEST_LEN;

/// Wraps a reader and folds every byte read through it into a `blake3::Hasher`,
/// so [`decode_snapshot`] can verify the new-format payload digest while still
/// streaming the compressed bytes lazily (never buffering the whole payload).
struct HashingReader<R> {
    inner: R,
    hasher: blake3::Hasher,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
}

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
/// **#1586 — content checksum.** The output is prefixed with a fixed
/// [`SNAPSHOT_HEADER_LEN`]-byte header (`SNAPSHOT_MAGIC` ‖
/// `blake3(zstd_payload)`) so [`decode_snapshot`] can catch silent bit-rot
/// inside the zstd frame (a flipped bit that still decompresses and parses).
/// The digest covers the compressed payload bytes — exactly the region stored
/// on disk / sent on the wire — consistently on encode and decode. Old blobs
/// (bare zstd, no header) still decode via the legacy path; see the module
/// note above for how the two formats are disambiguated.
#[must_use = "encoded bytes must be stored or transmitted"]
pub fn encode_snapshot(data: &SnapshotData) -> Result<Vec<u8>, AppError> {
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3)
        .map_err(|e| AppError::Snapshot(format!("zstd encoder init: {e}")))?;
    ciborium::into_writer(data, &mut encoder)
        .map_err(|e| AppError::Snapshot(format!("CBOR encode: {e}")))?;
    let compressed = encoder
        .finish()
        .map_err(|e| AppError::Snapshot(format!("zstd compress: {e}")))?;

    // #1586: frame the compressed payload with a magic + blake3 digest so a
    // flipped bit in the stored bytes is caught on decode instead of silently
    // restoring corrupted data.
    let digest = blake3::hash(&compressed);
    let mut out = Vec::with_capacity(SNAPSHOT_HEADER_LEN + compressed.len());
    out.extend_from_slice(&SNAPSHOT_MAGIC);
    out.extend_from_slice(digest.as_bytes());
    out.extend_from_slice(&compressed);
    Ok(out)
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
pub fn decode_snapshot<R: Read>(mut reader: R) -> Result<SnapshotData, AppError> {
    // #1586: peek the leading bytes to classify the format. A new-format blob
    // begins with `SNAPSHOT_MAGIC`; a legacy bare-zstd blob begins with the
    // zstd frame magic (`0x28 …`), which can never equal `SNAPSHOT_MAGIC`
    // (`0x41 …`). We read up to a full header's worth of bytes — `R` is not
    // seekable, so the consumed bytes are chained back in front of the reader
    // on the legacy path.
    let mut header = [0u8; SNAPSHOT_HEADER_LEN];
    let header_filled = read_up_to(&mut reader, &mut header)?;

    if header_filled >= SNAPSHOT_HEADER_LEN && header[..SNAPSHOT_MAGIC.len()] == SNAPSHOT_MAGIC {
        // New format: header is magic ‖ blake3(payload). Verify the digest
        // over the compressed payload bytes as we stream them.
        let mut expected = [0u8; SNAPSHOT_DIGEST_LEN];
        expected.copy_from_slice(&header[SNAPSHOT_MAGIC.len()..SNAPSHOT_HEADER_LEN]);

        let mut hashing = HashingReader {
            inner: reader,
            hasher: blake3::Hasher::new(),
        };
        // Decode may succeed (clean snapshot) or fail (corruption broke the
        // zstd/CBOR framing). Either way, drain the rest of the payload so the
        // running blake3 covers the *whole* stored payload, then compare. A
        // checksum mismatch takes priority over a decode error: any corruption
        // — whether it slipped through as a structurally-valid-but-wrong
        // `SnapshotData` (the silent bit-rot #1586 targets) or broke the frame
        // outright — is reported as a single, honest checksum-mismatch error.
        let decode_result = decode_zstd_cbor(&mut hashing);

        // `ciborium::from_reader` stops at the end of the single CBOR value (or
        // wherever decode failed) and may not have pulled the frame's trailing
        // bytes through the hasher. Drain the rest so the digest is complete.
        let mut sink = [0u8; 8192];
        loop {
            let n = hashing
                .read(&mut sink)
                .map_err(|e| AppError::Snapshot(format!("snapshot read: {e}")))?;
            if n == 0 {
                break;
            }
        }

        let actual = hashing.hasher.finalize();
        if actual.as_bytes() != &expected {
            return Err(AppError::Snapshot(format!(
                "snapshot checksum mismatch — stored blake3 digest {} does not match recomputed \
                 {} (corrupted snapshot / bit-rot)",
                blake3::Hash::from(expected).to_hex(),
                actual.to_hex(),
            )));
        }
        // Digest verified: the payload is intact, so surface any decode error
        // verbatim (e.g. an unsupported schema version in a non-corrupt blob).
        decode_result
    } else {
        // Legacy bare-zstd blob (no header / no checksum). Chain the peeked
        // bytes back in front of the reader and decode exactly as before — no
        // digest check, preserving back-compat with already-stored snapshots.
        let prefix = std::io::Cursor::new(header[..header_filled].to_vec());
        let mut chained = prefix.chain(reader);
        decode_zstd_cbor(&mut chained)
    }
}

/// Read into `buf` until it is full or EOF, returning the number of bytes
/// filled. Unlike `read_exact`, a short stream is *not* an error — it just
/// returns fewer bytes (a legacy blob shorter than a full header still decodes
/// via the chained-prefix path).
fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize, AppError> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader
            .read(&mut buf[filled..])
            .map_err(|e| AppError::Snapshot(format!("snapshot header read: {e}")))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Decode one zstd-compressed CBOR `SnapshotData` from `reader`, applying the
/// #428 decompression-bomb bounds. Shared by both the new (checksummed) and the
/// legacy (bare-zstd) decode paths.
fn decode_zstd_cbor<R: Read>(reader: R) -> Result<SnapshotData, AppError> {
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
    // #706 item 1 — the version gate now lives in `SnapshotData`'s
    // `schema_version` deserializer (`deserialize_gated_schema_version`),
    // which runs BEFORE the `tables` field is decoded. An unsupported /
    // pre-layout version is therefore rejected up front, in the same
    // streaming pass, with an honest "unsupported schema version …"
    // message — surfaced here as `AppError::Snapshot("CBOR decode: …")`
    // — instead of failing deep inside `tables` as a misleading raw
    // decode error after the old post-decode check had nominally
    // admitted it. No separate post-decode range check is needed.
    let snapshot: SnapshotData = ciborium::from_reader(bounded)
        .map_err(|e| AppError::Snapshot(format!("CBOR decode: {e}")))?;
    Ok(snapshot)
}
