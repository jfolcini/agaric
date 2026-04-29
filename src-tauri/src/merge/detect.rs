use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::dag;
use crate::db::ReadPool;
use crate::error::AppError;
use crate::op::*;
use crate::op_log;

use super::types::MergeResult;

/// Maximum number of iterations when walking prev_edit chains.
/// Prevents infinite loops on corrupted cyclic data.           (F07)
///
/// **I-Lifecycle-1 — belt-and-suspenders rationale.** The chain-walk in
/// `walk_to_create_block_root` (and similar callers) tracks BOTH this
/// iteration counter AND a `HashSet<(device_id, seq)>` of visited keys.
/// The visited set is the primary cycle-detection mechanism — it catches
/// any structural loop in O(N) regardless of length. The iteration cap is
/// a defensive backstop that fires only if the visited set somehow
/// misbehaves (memory corruption, allocator OOM panic, hash collision —
/// all theoretical) on a chain that is also linearly-long-but-acyclic
/// beyond the cap. Either guard alone would be sufficient for the
/// expected failure modes; both together protect against the unexpected
/// ones at near-zero runtime cost. **Do not remove either.**
pub(crate) const MAX_CHAIN_WALK_ITERATIONS: usize = 1_000;

/// Three-way text merge for a block's content.
///
/// 1. Finds the LCA of `op_ours` and `op_theirs` via `dag::find_lca`.
/// 2. Extracts text at ancestor, ours, and theirs via `dag::text_at`.
/// 3. If no LCA is found, walks BOTH `op_ours` AND `op_theirs` back to
///    their respective `create_block` roots (M-72). Both sides must agree
///    on a single create_block; if the roots **differ**, the merge would
///    be biased toward whichever side was walked first under the previous
///    one-sided code path, so we return `Err` and let the caller fall
///    back to the conflict-copy path.
/// 4. Calls `diffy::merge` for a **line-level** three-way merge.
///
/// **Important:** `diffy::merge` operates at line-level granularity (splits
/// on `\n` boundaries), *not* word-level.  Because auto-split on blur turns
/// each paragraph into its own block, most blocks contain a single line.
/// Any concurrent edit to a single-line block will therefore produce a
/// conflict, even if the changes affect different words.  (See F03.)
pub async fn merge_text(
    pool: &SqlitePool,
    block_id: &str,
    op_ours: &(String, i64),
    op_theirs: &(String, i64),
) -> Result<MergeResult, AppError> {
    // 1. Find the Lowest Common Ancestor
    let lca = dag::find_lca(pool, op_ours, op_theirs).await?;
    tracing::debug!(block_id, lca_found = lca.is_some(), "merge LCA lookup");

    // 2. Get the text content at each point
    let text_ours = dag::text_at(pool, &op_ours.0, op_ours.1).await?;
    let text_theirs = dag::text_at(pool, &op_theirs.0, op_theirs.1).await?;

    let text_ancestor = match lca {
        Some((ref dev, seq)) => dag::text_at(pool, dev, seq).await?,
        None => {
            // M-72: walk BOTH sides back to their `create_block` roots.
            //
            // Previous behaviour walked ONLY `op_ours` and used that
            // root as the ancestor for both sides — biasing the merge
            // toward whichever side happened to be walked when the two
            // heads shared a `block_id` but traced to different create
            // ops (compaction-induced chain truncation, or corrupted
            // `prev_edit`).
            //
            // Now we walk both sides and compare the **content** of
            // their respective create_block roots. The merge is biased
            // only when those contents actually disagree on what the
            // ancestor text is; two distinct create ops with identical
            // content are merge-equivalent (no bias possible) and we
            // proceed with that shared content. When contents differ,
            // we return Err so the caller drops to the conflict-copy
            // path. The pair of root `(device_id, seq)` keys are kept
            // for the divergence-error message.
            //
            // When a chain is truncated (an `edit_block` with
            // `prev_edit = null` mid-walk, e.g. because an ancestor was
            // purged by compaction) we fall back to looking up the
            // unique `create_block` for this `block_id` in `op_log`
            // inside `walk_to_create_block_root`. That fallback is
            // conservative: it succeeds only when there is exactly one
            // `create_block` op for the block, so a corrupted chain
            // that has two divergent creates cannot silently pick one.
            let (root_ours_key, root_ours_text) =
                walk_to_create_block_root(pool, block_id, op_ours).await?;
            let (root_theirs_key, root_theirs_text) =
                walk_to_create_block_root(pool, block_id, op_theirs).await?;

            if root_ours_text != root_theirs_text {
                tracing::warn!(
                    block_id,
                    ours_root_device = %root_ours_key.0,
                    ours_root_seq = root_ours_key.1,
                    theirs_root_device = %root_theirs_key.0,
                    theirs_root_seq = root_theirs_key.1,
                    "M-72: divergent create_block roots — declining biased merge"
                );
                return Err(AppError::InvalidOperation(format!(
                    "merge_text: edit chains for block '{}' resolve to different \
                     create_block roots with different content — ours roots at \
                     ({}, {}), theirs roots at ({}, {}); cannot safely choose \
                     ancestor — caller should fall back to a conflict copy",
                    block_id,
                    root_ours_key.0,
                    root_ours_key.1,
                    root_theirs_key.0,
                    root_theirs_key.1,
                )));
            }
            // Either keys also matched (single canonical root) or keys
            // differ but the content is identical (merge-equivalent
            // creates, no bias possible). Either way, the ancestor text
            // is unambiguous.
            if root_ours_key != root_theirs_key {
                tracing::debug!(
                    block_id,
                    ours_root_device = %root_ours_key.0,
                    ours_root_seq = root_ours_key.1,
                    theirs_root_device = %root_theirs_key.0,
                    theirs_root_seq = root_theirs_key.1,
                    "M-72: distinct create_block ops with identical content — \
                     using shared content as ancestor"
                );
            }
            root_ours_text
        }
    };

    // 3. Line-level three-way merge via diffy.
    //    Note: diffy splits on `\n` boundaries (line-level, NOT word-level).
    //    For single-line blocks, any concurrent edit produces a conflict.
    tracing::debug!(
        block_id,
        ancestor_len = text_ancestor.len(),
        ours_len = text_ours.len(),
        theirs_len = text_theirs.len(),
        "attempting three-way text merge"
    );
    // L-112: on a conflict, capture `conflict_text.len()` and a short
    // blake3 digest of the conflict-marker payload (which embeds
    // `<<<<<<< / =======/ >>>>>>>` markers with positional info from
    // diffy) before discarding it. The digest gives downstream
    // telemetry / regression tests a stable fingerprint for the *kind*
    // of conflict observed without leaking the underlying text.
    let result = match diffy::merge(&text_ancestor, &text_ours, &text_theirs) {
        Ok(merged) => {
            tracing::info!(block_id, clean = true, "text merge completed");
            MergeResult::Clean(merged)
        }
        Err(conflict_text) => {
            let conflict_len = conflict_text.len();
            // 16-char hex prefix of the blake3 digest is plenty for
            // telemetry triage without being an exact fingerprint of
            // the underlying user text.
            let conflict_digest: String = blake3::hash(conflict_text.as_bytes())
                .to_hex()
                .to_string()
                .chars()
                .take(16)
                .collect();
            tracing::info!(
                block_id,
                clean = false,
                conflict_len,
                %conflict_digest,
                "text merge produced conflict (L-112)",
            );
            MergeResult::Conflict {
                ours: text_ours,
                theirs: text_theirs,
                ancestor: text_ancestor,
            }
        }
    };
    Ok(result)
}

/// Walk an edit chain back to its `create_block` root.
///
/// Strategy:
/// 1. Walk `prev_edit` pointers from `op` through `op_log` until we hit a
///    `create_block`. Returns the create's `(device_id, seq)` key plus its
///    `content` field.
/// 2. If the chain ends mid-walk (an `edit_block` whose `prev_edit` is
///    `None`, modelling chain truncation due to compaction or corruption)
///    — fall back to [`lookup_unique_create_block`]. That side cannot
///    "trace to" any specific create on its own, but if op_log has
///    exactly one create_block for the same `block_id`, it is the only
///    candidate root and is safe to use.
///
/// Any other failure mode (cycle, iteration cap, unexpected op type,
/// missing op) returns `Err`.
async fn walk_to_create_block_root(
    pool: &SqlitePool,
    block_id: &str,
    op: &(String, i64),
) -> Result<((String, i64), String), AppError> {
    let mut current: Option<(String, i64)> = Some(op.clone());
    let mut iterations = 0usize;
    let mut visited_walk: HashSet<(String, i64)> = HashSet::new();
    while let Some(key) = current.take() {
        iterations += 1;
        if iterations > MAX_CHAIN_WALK_ITERATIONS {
            return Err(AppError::InvalidOperation(format!(
                "prev_edit chain for block '{}' exceeded {} iterations \
                 — possible cycle in corrupted data",
                block_id, MAX_CHAIN_WALK_ITERATIONS,
            )));
        }
        if !visited_walk.insert(key.clone()) {
            return Err(AppError::InvalidOperation(format!(
                "cycle detected in prev_edit chain for block '{}' at ({}, {})",
                block_id, key.0, key.1,
            )));
        }
        // I-Core-8: wrap to typed read-pool — caller is in write context
        let record = op_log::get_op_by_seq(&ReadPool(pool.clone()), &key.0, key.1).await?;
        match record.op_type.as_str() {
            "create_block" => {
                let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
                return Ok((key, payload.content));
            }
            "edit_block" => {
                let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
                current = payload.prev_edit;
            }
            _ => {
                return Err(AppError::InvalidOperation(format!(
                    "unexpected op type '{}' in edit chain for block '{}'",
                    record.op_type, block_id,
                )));
            }
        }
    }
    // The chain ended without reaching a `create_block` — a broken chain
    // (an `edit_block` had `prev_edit = null`). Fall back to a direct
    // lookup of the unique create_block for this block_id, if any.
    lookup_unique_create_block(pool, block_id).await
}

/// Look up the unique `create_block` op for a given `block_id` in `op_log`.
///
/// Used as the fallback when [`walk_to_create_block_root`]'s chain walk
/// terminates without reaching a `create_block` (e.g. because the chain
/// was truncated by op-log compaction).
///
/// Returns `Err` unless **exactly one** `create_block` exists for the
/// block. A count of zero means no recoverable root; a count of two or
/// more means the data is genuinely ambiguous and the caller cannot
/// safely pick one root without bias — exactly the M-72 hazard.
async fn lookup_unique_create_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<((String, i64), String), AppError> {
    // Migration 0030 added the indexed `block_id` column on `op_log`,
    // so this is an O(log N) seek rather than a JSON-extract scan.
    let creates = sqlx::query!(
        r#"SELECT device_id as "device_id!: String",
                  seq        as "seq!: i64",
                  payload    as "payload!: String"
           FROM op_log
           WHERE op_type = 'create_block'
             AND block_id = ?"#,
        block_id
    )
    .fetch_all(pool)
    .await?;

    match creates.len() {
        0 => Err(AppError::InvalidOperation(format!(
            "merge_text: prev_edit chain for block '{}' is broken and op_log \
             has no create_block for that block — no recoverable root",
            block_id
        ))),
        1 => {
            let only = &creates[0];
            let payload: CreateBlockPayload = serde_json::from_str(&only.payload)?;
            Ok(((only.device_id.clone(), only.seq), payload.content))
        }
        n => Err(AppError::InvalidOperation(format!(
            "merge_text: prev_edit chain for block '{}' is broken and op_log \
             has {} create_block ops for that block — cannot safely choose \
             ancestor without bias (M-72)",
            block_id, n
        ))),
    }
}

// =====================================================================
// M-72 regression tests
// =====================================================================
//
// These cover the no-LCA fallback's two-sided walk introduced for M-72:
// when `find_lca` returns `None`, both `op_ours` and `op_theirs` must
// resolve to the **same** create_block root. If they resolve to
// different create_blocks, `merge_text` returns `Err` instead of
// silently picking ours's root and producing a biased merge.

#[cfg(test)]
mod tests_m72 {
    use super::*;
    use crate::hash::compute_op_hash;
    use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload};
    use crate::op_log::{append_local_op_at, OpRecord};
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const FIXED_TS: &str = "2025-01-15T12:00:00Z";
    const DEV_A: &str = "device-A";
    const DEV_B: &str = "device-B";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = crate::db::init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn make_create(block_id: &str, content: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: content.into(),
        })
    }

    fn make_edit(block_id: &str, to_text: &str, prev_edit: Option<(String, i64)>) -> OpPayload {
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(block_id),
            to_text: to_text.into(),
            prev_edit,
        })
    }

    /// Build a remote `OpRecord` with a correct hash for `dag::insert_remote_op`.
    fn make_remote_record(
        device_id: &str,
        seq: i64,
        parent_seqs: Option<String>,
        op_type: &str,
        payload: &str,
    ) -> OpRecord {
        let hash = compute_op_hash(device_id, seq, parent_seqs.as_deref(), op_type, payload);
        // L-13: mirror the production `From<OpTransfer>` path — parse
        // the block_id once and cache it on the sidecar.
        let block_id = crate::op_log::extract_block_id_from_payload(payload);
        OpRecord {
            device_id: device_id.to_owned(),
            seq,
            parent_seqs,
            hash,
            op_type: op_type.to_owned(),
            payload: payload.to_owned(),
            created_at: FIXED_TS.to_owned(),
            block_id,
        }
    }

    /// M-72 happy path: `op_ours` and `op_theirs` both trace to the same
    /// `create_block` root, but `find_lca` returns `None` because each
    /// head has `prev_edit = null` (broken chain — ancestors purged by
    /// compaction). The two-sided walk falls back to the unique
    /// `create_block` for the block in op_log, both sides agree, and
    /// `merge_text` produces a three-way merge using that create's
    /// content as the ancestor.
    #[tokio::test]
    async fn merge_text_no_lca_walks_both_sides_same_root() {
        let (pool, _dir) = test_pool().await;

        // (A,1) create_block B1 with the canonical content.
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "shared\nbase\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // (A,2) edit_block B1 with `prev_edit = null` — chain truncated
        // (e.g. compaction purged the ancestor link).
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "shared\nbase\nfrom A\n", None),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // (B,1) edit_block B1 with `prev_edit = null` — same broken-chain
        // shape, on the remote side.
        let b_payload = r#"{"block_id":"B1","to_text":"shared\nbase\nfrom B\n","prev_edit":null}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // Sanity: with both heads having `prev_edit = null`, find_lca
        // really does return None, so we exercise the no-LCA fallback.
        let lca = crate::dag::find_lca(&pool, &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();
        assert!(
            lca.is_none(),
            "fixture must trigger the no-LCA fallback, got LCA = {lca:?}"
        );

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .expect(
                "M-72 happy path: both heads resolve to the same create_block (the \
                 unique create for B1), so merge_text must NOT return Err",
            );

        match result {
            MergeResult::Clean(merged) => {
                // Both add a different line at the end, on top of the
                // create's content. diffy may merge these cleanly...
                assert!(
                    merged.contains("shared") && merged.contains("base"),
                    "clean merge must preserve the create_block ancestor's content, got: {merged}"
                );
            }
            MergeResult::Conflict {
                ours,
                theirs,
                ancestor,
            } => {
                // ...or report a conflict, but the ancestor MUST be the
                // create_block's content (not one of the heads). That is
                // the precise behaviour M-72 protects: the ancestor is
                // chosen from the agreed-upon create root, not biased
                // toward `ours`.
                assert_eq!(
                    ancestor, "shared\nbase\n",
                    "ancestor must come from the unique create_block both sides agree on"
                );
                assert_eq!(ours, "shared\nbase\nfrom A\n");
                assert_eq!(theirs, "shared\nbase\nfrom B\n");
            }
        }
    }

    /// M-72 fix: when the two heads' `prev_edit` chains resolve to
    /// **different** `create_block` roots (the corrupted-chain hazard),
    /// `merge_text` must return `Err` rather than silently picking ours's
    /// root and producing a merge biased toward whichever side was
    /// walked.
    ///
    /// Fixture: two distinct `create_block` ops for the same `block_id`
    /// (a hand-built scenario mimicking compaction-induced chain
    /// truncation that lost the connection between the two creates).
    /// Each device's edit chain points at its own create, so both walks
    /// succeed but resolve to different roots.
    #[tokio::test]
    async fn merge_text_no_lca_divergent_roots_returns_err() {
        let (pool, _dir) = test_pool().await;

        // Device A's chain: create + edit, normal `prev_edit` link.
        append_local_op_at(&pool, DEV_A, make_create("B1", "ROOT-A\n"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "ROOT-A\nedit-from-A\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B's chain: a SECOND create_block for the same block_id
        // (corrupted chain — would not happen in well-formed data) plus
        // an edit pointing at it. Inserted as remote ops with valid
        // hashes so `dag::insert_remote_op` accepts them.
        let b_create_payload = r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"ROOT-B\n"}"#;
        let b_create = make_remote_record(DEV_B, 1, None, "create_block", b_create_payload);
        crate::dag::insert_remote_op(&pool, &b_create)
            .await
            .unwrap();

        let b_edit_payload =
            r#"{"block_id":"B1","to_text":"ROOT-B\nedit-from-B\n","prev_edit":["device-B",1]}"#;
        // parent_seqs for the edit references its own predecessor on
        // device-B (the rogue create at seq=1).
        let parent_seqs_json = r#"[["device-B",1]]"#.to_owned();
        let b_edit = make_remote_record(
            DEV_B,
            2,
            Some(parent_seqs_json),
            "edit_block",
            b_edit_payload,
        );
        crate::dag::insert_remote_op(&pool, &b_edit).await.unwrap();

        // Sanity: find_lca returns None because A's chain goes (A,2)->(A,1)
        // while B's chain goes (B,2)->(B,1) and they never intersect.
        let lca = crate::dag::find_lca(&pool, &(DEV_A.into(), 2), &(DEV_B.into(), 2))
            .await
            .unwrap();
        assert!(
            lca.is_none(),
            "fixture must trigger the no-LCA fallback, got LCA = {lca:?}"
        );

        // Sanity: each side genuinely walks back to its own (different)
        // create_block. Both helper calls succeed; the divergence comes
        // from the *comparison* in merge_text itself.
        let (root_ours, _) = walk_to_create_block_root(&pool, "B1", &(DEV_A.into(), 2))
            .await
            .unwrap();
        let (root_theirs, _) = walk_to_create_block_root(&pool, "B1", &(DEV_B.into(), 2))
            .await
            .unwrap();
        assert_eq!(root_ours, (DEV_A.to_owned(), 1));
        assert_eq!(root_theirs, (DEV_B.to_owned(), 1));
        assert_ne!(
            root_ours, root_theirs,
            "fixture is supposed to produce DIVERGENT create_block roots"
        );

        // The actual M-72 assertion: merge_text refuses to pick a side.
        let err = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 2))
            .await
            .expect_err(
                "M-72: divergent create_block roots must produce Err so the \
                 caller drops to the conflict-copy path; producing a merge \
                 here would be biased toward whichever side was walked",
            );

        let msg = err.to_string();
        assert!(
            msg.contains("different") || msg.contains("diverge"),
            "error message should mention divergent / different roots, got: {msg}"
        );
        assert!(
            msg.contains("B1"),
            "error message should mention the offending block_id, got: {msg}"
        );
    }
}
