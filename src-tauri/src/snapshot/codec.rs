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

/// Decode zstd-compressed CBOR bytes to SnapshotData.
#[must_use = "decoded snapshot data must be applied or inspected"]
pub fn decode_snapshot(data: &[u8]) -> Result<SnapshotData, AppError> {
    let decompressed =
        zstd::decode_all(data).map_err(|e| AppError::Snapshot(format!("zstd decompress: {e}")))?;
    let snapshot: SnapshotData = ciborium::from_reader(decompressed.as_slice())
        .map_err(|e| AppError::Snapshot(format!("CBOR decode: {e}")))?;
    if snapshot.schema_version < 1 || snapshot.schema_version > SCHEMA_VERSION {
        return Err(AppError::Snapshot(format!(
            "unsupported schema version {} (expected 1..={SCHEMA_VERSION})",
            snapshot.schema_version
        )));
    }
    Ok(snapshot)
}
