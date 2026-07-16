use crate::op::OpPayload;
use agaric_core::error::AppError;

/// Serialize only the inner payload fields (without the `op_type` serde tag).
///
/// Since [`OpPayload`] uses `#[serde(tag = "op_type")]`, serializing it directly
/// embeds the tag. We want the `op_log.payload` column to store *only* the
/// operation-specific data — the `op_type` is already in its own column.
// #2621 (wave S3b-ii): `pub` (was `pub(crate)`) because the app-crate
// remote-ingest path `crate::dag::insert_remote_op` (in `src/dag.rs`, which
// stays in the app) serializes payloads through this helper across the crate
// boundary.
pub fn serialize_inner_payload(op_payload: &OpPayload) -> Result<String, AppError> {
    // Every [`OpPayload`] variant wraps a `Serialize` struct and the match
    // arm is always the same — serialize via `serde_json::Value` so the
    // resulting JSON has canonical (alphabetical) key ordering.  Going
    // through `Value` (a `BTreeMap` under the hood) is what guarantees the
    // ordering: `serde_json::to_string` on `derive(Serialize)` types uses
    // declaration order, which is deterministic within a serde version but
    // not across versions.
    match op_payload {
        OpPayload::CreateBlock(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::EditBlock(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::DeleteBlock(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::RestoreBlock(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::PurgeBlock(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::MoveBlock(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::AddTag(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::RemoveTag(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::SetProperty(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::DeleteProperty(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::AddAttachment(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::DeleteAttachment(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
        OpPayload::RenameAttachment(p) => Ok(serde_json::to_string(&serde_json::to_value(p)?)?),
    }
}

/// Shared helper for [`extract_block_id_from_payload`] and
/// [`extract_attachment_id_from_payload`]: parse the payload JSON and return
/// the value of `field` as an owned `String`, or `None` on missing field or
/// parse error.
///
/// Surfaces JSON parse failures as a warn-level log instead of silently
/// returning `None`. AGENTS.md "Anti-patterns" forbids the silent-swallow
/// pattern — corruption would lose the indexed column entry and produce
/// hard-to-attribute "queries miss this op" bugs. Warn-and-continue keeps the
/// existing call sites' behaviour while making the failure visible in logs.
///
/// The payload prefix is truncated at 80 chars so a multi-MB malformed payload
/// does not flood the log line. `chars().take(80)` handles UTF-8 boundaries
/// correctly (slicing by byte index can split a multi-byte codepoint).
///
/// Test-only since #2071: production ingest parses the payload once via
/// [`extract_indexed_ids_from_payload`]. These single-field helpers remain as
/// the extraction oracle that the `op_log`/`dag` tests compare against.
#[cfg(test)]
fn extract_str_field_from_payload(payload_json: &str, field: &'static str) -> Option<String> {
    match serde_json::from_str::<serde_json::Value>(payload_json) {
        Ok(value) => value.get(field)?.as_str().map(str::to_owned),
        Err(e) => {
            // Truncate at 80 chars so a multi-MB malformed payload does
            // not flood the log line.  `chars().take(80)` handles UTF-8
            // boundaries correctly (slicing by byte index can split a
            // multi-byte codepoint).
            let prefix: String = payload_json.chars().take(80).collect();
            tracing::warn!(
                error = %e,
                op_payload_prefix = %prefix,
                "failed to extract {} from payload",
                field
            );
            None
        }
    }
}

/// Parse the payload JSON **once** and extract both indexed-column values
/// (`block_id` and `attachment_id`) in a single pass.
///
/// `crate::dag::insert_remote_op` needs both denormalised columns for every
/// ingested remote op. Extracting `block_id` and `attachment_id` with two
/// separate `serde_json::from_str` passes parses the same JSON twice; this
/// helper parses it once. Remote-op ingest runs per synced op, so halving the
/// parse work matters under sync burst.
///
/// Same warn-and-continue contract as the single-field helpers: a parse
/// failure logs once at warn level (not once per field) and yields
/// `(None, None)`, leaving the indexed columns unpopulated rather than
/// aborting ingest.
// #2621 (wave S3b-ii): `pub` (was `pub(crate)`) because the app-crate
// remote-ingest path `crate::dag::insert_remote_op` calls it across the crate
// boundary to populate the indexed columns in a single parse.
pub fn extract_indexed_ids_from_payload(payload_json: &str) -> (Option<String>, Option<String>) {
    match serde_json::from_str::<serde_json::Value>(payload_json) {
        Ok(value) => {
            let get = |field: &str| value.get(field).and_then(|v| v.as_str()).map(str::to_owned);
            (get("block_id"), get("attachment_id"))
        }
        Err(e) => {
            // Truncate at 80 chars (UTF-8-safe via `chars().take`) so a
            // multi-MB malformed payload does not flood the log line.
            let prefix: String = payload_json.chars().take(80).collect();
            tracing::warn!(
                error = %e,
                op_payload_prefix = %prefix,
                "failed to parse payload for indexed-id extraction",
            );
            (None, None)
        }
    }
}

/// Extract the `block_id` from a serialized payload JSON string.
///
/// Used by `crate::dag::insert_remote_op` to populate the indexed
/// `op_log.block_id` column (added in migration 0030) when the caller
/// only has the payload as a JSON string rather than a typed [`OpPayload`].
///
/// Returns `None` if the payload has no `block_id` field (the
/// `delete_attachment` op targets an attachment_id only) or if the JSON
/// cannot be parsed.
///
/// Test-only since #2071 (see [`extract_indexed_ids_from_payload`]).
#[cfg(test)]
pub(crate) fn extract_block_id_from_payload(payload_json: &str) -> Option<String> {
    extract_str_field_from_payload(payload_json, "block_id")
}

/// Extract the `attachment_id` from a serialized payload JSON string.
///
/// Used by `crate::dag::insert_remote_op` to populate the indexed
/// `op_log.attachment_id` column (added in migration 0064, SQL-review
/// B-4) when the caller only has the payload as a JSON string rather
/// than a typed [`OpPayload`].
///
/// Returns `None` if the payload has no `attachment_id` field (every
/// op except `add_attachment` and `delete_attachment`) or if the JSON
/// cannot be parsed. Same warn-and-continue contract as
/// [`extract_block_id_from_payload`] — silent-swallow of malformed
/// JSON would lose the indexed entry and produce hard-to-attribute
/// "reverse-attachment query misses this op" bugs.
///
/// Test-only since #2071 (see [`extract_indexed_ids_from_payload`]).
#[cfg(test)]
pub(crate) fn extract_attachment_id_from_payload(payload_json: &str) -> Option<String> {
    extract_str_field_from_payload(payload_json, "attachment_id")
}

// ---------------------------------------------------------------------------
// Op log immutability bypass (H-13)
// ---------------------------------------------------------------------------
//
// Migration 0036 installs BEFORE UPDATE / BEFORE DELETE triggers on `op_log`
// that ABORT unless a sentinel row is present in `_op_log_mutation_allowed`.
// The compaction code path is the only sanctioned bypass; it MUST wrap its
// op_log mutation in:
//
//     let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
//     enable_op_log_mutation_bypass(&mut tx).await?;
//     // ... UPDATE / DELETE FROM op_log ...
//     disable_op_log_mutation_bypass(&mut tx).await?;
//     tx.commit().await?;
//
// Connection scoping is achieved via transactional discipline rather than
// physical schema scoping (SQLite forbids triggers from referencing temp
// tables, so the originally-proposed `temp.` prefix from H-13 cannot work).
// Because BEGIN IMMEDIATE serialises writers and the sentinel is DELETEd
// before commit, sibling connections never observe the sentinel as present.
