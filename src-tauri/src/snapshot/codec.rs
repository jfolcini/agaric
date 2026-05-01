use std::io::Read;

use super::types::{SnapshotData, SCHEMA_VERSION};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

/// Encode SnapshotData to zstd-compressed CBOR bytes.
#[must_use = "encoded bytes must be stored or transmitted"]
pub fn encode_snapshot(data: &SnapshotData) -> Result<Vec<u8>, AppError> {
    let mut cbor_buf = Vec::new();
    ciborium::into_writer(data, &mut cbor_buf)
        .map_err(|e| AppError::Snapshot(format!("CBOR encode: {e}")))?;
    let compressed = zstd::encode_all(cbor_buf.as_slice(), 3)
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
    let zstd_decoder = zstd::stream::Decoder::new(reader)
        .map_err(|e| AppError::Snapshot(format!("zstd decompress: {e}")))?;
    let snapshot: SnapshotData = ciborium::from_reader(zstd_decoder)
        .map_err(|e| AppError::Snapshot(format!("CBOR decode: {e}")))?;
    if snapshot.schema_version < 1 || snapshot.schema_version > SCHEMA_VERSION {
        return Err(AppError::Snapshot(format!(
            "unsupported schema version {} (expected 1..={SCHEMA_VERSION})",
            snapshot.schema_version
        )));
    }
    Ok(snapshot)
}
