use serde::{Deserialize, Serialize};

/// A fully-materialised op log row, returned after a successful append.
///
/// # Schema doc — `op_log.created_at` monotonic invariant
///
/// `created_at` mirrors the `op_log.created_at` column, migrated to
/// `INTEGER NOT NULL` epoch-milliseconds in migration `0079` (#109
/// Phase 2). Reverse-op "find prior op" queries in `reverse::block_ops`,
/// `reverse::property_ops`, and `reverse::attachment_ops` compare
/// `created_at` (`created_at < ?` and `ORDER BY created_at DESC`) to
/// find the immediately-prior op for a given block/property/attachment.
/// With INTEGER epoch-ms this is a plain numeric comparison — the
/// fixed-width/`Z`-suffix lex-monotonic shape the TEXT column relied on
/// is now subsumed by integer ordering. Every value stored here MUST be
/// the output of [`crate::db::now_ms`].
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OpRecord {
    pub device_id: String,
    pub seq: i64,
    pub parent_seqs: Option<String>,
    pub hash: String,
    pub op_type: String,
    pub payload: String,
    pub created_at: i64,
    /// Rust-only sidecar caching the parsed `block_id` so callers
    /// on the materializer hot path (`dispatch::enqueue_background_tasks`)
    /// do not have to re-parse `payload` for the JSON `block_id` field.
    /// Populated at every construction site:
    ///   * `append_local_op_in_tx` / `append_merge_op` reads it from the
    ///     typed [`OpPayload`] (no JSON parse).
    ///   * DB-read paths (`get_op_by_seq`, `get_ops_since`) populate it
    ///     from the indexed `op_log.block_id` column added in
    ///     migration 0030 (no JSON parse).
    ///   * `From<OpTransfer>` and bespoke row-by-row constructors fall
    ///     back to `extract_block_id_from_payload` — one parse, exactly
    ///     once, replacing the previous per-call-site parse.
    ///
    /// Marked `#[serde(skip, default)]` so the wire format is unchanged
    /// (sync still ships `OpTransfer`, which mirrors only the persisted
    /// columns) and `#[sqlx(default)]` so legacy `FromRow`-using read
    /// paths that don't `SELECT block_id` continue to compile and
    /// default the field to `None` instead of failing.
    #[serde(skip, default)]
    #[sqlx(default)]
    pub block_id: Option<String>,
}

impl OpRecord {
    /// Parse `parent_seqs` JSON into typed tuples.
    ///
    /// Returns `None` for genesis ops (where `parent_seqs` is NULL).
    ///
    /// # Errors
    /// Returns `serde_json::Error` if the JSON is malformed.
    pub fn parsed_parent_seqs(&self) -> Result<Option<Vec<(String, i64)>>, serde_json::Error> {
        match &self.parent_seqs {
            None => Ok(None),
            Some(json) => serde_json::from_str(json).map(Some),
        }
    }
}
