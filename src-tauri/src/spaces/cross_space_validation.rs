//! Cross-space reference validation (Phase 2 enforcement).
//!
//! The two helpers below are called BEFORE emitting an op so a write
//! that would introduce a cross-space reference is rejected up front.
//! wired them into the single-block command paths:
//! `set_property` (ref-type values, `set_property_in_tx`), block create
//! (`create_block_in_tx`), and block edit (`edit_block_inner`).
//! `add_tag` enforces cross-space via its own inline guard.
//!
//! Bulk-import and sync-ingress are NOT write-time gated here: those ops
//! arrive already committed in the CRDT, so rejecting/skipping them would
//! diverge SQL from the authoritative engine state (links/tag-refs instead
//! carry a Phase-3 write-time cache filter on that path). The one
//! unfiltered synced surface — cross-space ref-type `block_properties`
//! (`value_ref`) landing in the source-of-truth table — is covered by
//! **detection**: the `audit_cross_space_refs` diagnostic's A5 category
//! (#436) reports exactly what [`validate_ref_property_cross_space`] would
//! reject. Write-time gating of the apply path remains a deferred design
//! decision (it needs a divergence-tolerant strategy, not a hard reject).
//!
//! - [`validate_content_cross_space_refs`] — scans block content for
//!   `[[ULID]]` / `((ULID))` / `#[ULID]` tokens; resolves each
//!   target's space via [`resolve_block_space`]; rejects if any
//!   target's space differs from the source block's space.
//!
//! - [`validate_ref_property_cross_space`] — checks that a ref-type
//!   property value (`value_ref`) targets a block in the same space
//!   as the source block.
//!
//! Both helpers take `&mut SqliteConnection` so they run on the
//! command's `BEGIN IMMEDIATE` transaction (the `&mut Transaction` /
//! `CommandTx` handle deref-coerces to it) without opening a fresh
//! connection. enforcement applies only
//! when BOTH the source and the target are assigned to a space — an
//! orphan (unassigned) block is not "cross-space" to anything, so it is
//! tolerated (mirrors the orphan-tag adoption in `add_tag`).

use crate::cache::{TAG_REF_RE, ULID_LINK_RE};
use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::space::{SpaceId, resolve_block_space};
use crate::ulid::BlockId;
use std::collections::HashMap;

/// Resolve the owning space of every block id in `ids` in one chunked
/// pass (P8, #346), replacing the former per-token
/// [`resolve_block_space`] N+1 in [`validate_content_cross_space_refs`].
///
/// Returns a map from input id → its resolved space (entries with no
/// space — orphan blocks — are simply absent from the map, mirroring
/// `resolve_block_space` returning `None`, which preserves the
/// orphan-tolerance contract).
///
/// The IN-list is chunked at [`MAX_SQL_PARAMS`] so a content block with
/// thousands of distinct reference tokens never exceeds SQLite's bound
/// parameter limit. Soft-delete filtering matches `resolve_block_space`
/// exactly (invariant #9): the input block must be live for its
/// `page_id` to flow through the COALESCE, and the block that *holds*
/// the `space` property must be live too.
async fn resolve_block_spaces_batch(
    conn: &mut sqlx::SqliteConnection,
    ids: &[&str],
) -> Result<HashMap<String, SpaceId>, AppError> {
    use sqlx::Row as _;

    let mut out: HashMap<String, SpaceId> = HashMap::new();
    for chunk in ids.chunks(MAX_SQL_PARAMS) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        // Per input block `b`, read its own `space_id` column (Phase 2:
        // every block carries its space directly — the page indirection
        // and the `block_properties(key='space')` join are gone). A live
        // block with no space yields NULL `space_id` and is dropped below.
        // The block must itself be live (soft-deleted blocks never
        // participate in space resolution, AGENTS.md invariant #9).
        let sql = format!(
            "SELECT b.id AS input_id, \
                    COALESCE(b.space_id, p.space_id) AS space_id \
               FROM blocks b \
               LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL \
              WHERE b.deleted_at IS NULL \
                AND b.id IN ({placeholders})"
        );
        // Only placeholder `?` and a literal column list are interpolated
        // (chunk len), never any caller value — every id is a bound param.
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q.bind(*id);
        }
        let rows = q.fetch_all(&mut *conn).await?;
        for row in rows {
            let input_id: String = row.try_get("input_id")?;
            let space_id: Option<String> = row.try_get("space_id")?;
            if let Some(space_id) = space_id {
                // value_ref came from a validated SetProperty(space, …);
                // skip re-parse (AGENTS.md invariant #8).
                out.insert(input_id, SpaceId::from_trusted(&space_id));
            }
        }
    }
    Ok(out)
}

/// Scan `content` for ULID tokens and validate every referenced block
/// belongs to the same space as `source_block_id`.
///
/// Returns `Ok(())` when the content is clean (or contains no tokens).
/// Returns `Err(AppError::Validation)` on the first cross-space token
/// found.
pub async fn validate_content_cross_space_refs(
    conn: &mut sqlx::SqliteConnection,
    source_block_id: &BlockId,
    content: &str,
) -> Result<(), AppError> {
    let source_space = resolve_block_space(&mut *conn, source_block_id).await?;
    // Only enforce when the source block is itself assigned to
    // a space. An unassigned (orphan) source — e.g. a freshly created
    // top-level block that has not yet inherited a page/space — has no
    // space to be "cross" to, so there is nothing to reject.
    let Some(source_space) = source_space else {
        return Ok(());
    };

    // Collect all ULIDs referenced in the content (both link and tag-ref forms)
    let mut targets: Vec<&str> = Vec::new();
    for cap in ULID_LINK_RE.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            targets.push(m.as_str());
        }
    }
    for cap in TAG_REF_RE.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            targets.push(m.as_str());
        }
    }

    // P8 (#346): resolve every target's space in one chunked pass instead
    // of a per-token `resolve_block_space` round-trip. A target absent from
    // the map is an orphan (no space) and is tolerated — not cross-space yet.
    let target_spaces = resolve_block_spaces_batch(&mut *conn, &targets).await?;
    for target_str in targets {
        // Only a target assigned to a DIFFERENT space is a violation.
        if let Some(target_space) = target_spaces.get(target_str)
            && *target_space != source_space
        {
            return Err(AppError::Validation(format!(
                "cross-space reference: block '{}' (space {}) references '{}' (space {})",
                source_block_id.as_str(),
                source_space.as_str(),
                target_str,
                target_space.as_str(),
            )));
        }
    }

    Ok(())
}

/// Validate that a ref-type property value targets a block in the
/// same space as `source_block_id`.
///
/// No-op when `value_ref` is `None` (the property is being cleared).
///
/// # `space` key exemption
///
/// The `space` property itself is intentionally allowed to change —
/// this is how pages move between spaces (e.g. the Personal→Work
/// migration in `migrate_personal_pages_to_work`). The enforcement
/// gate only applies to user-defined ref properties (`linked_page`,
/// `project`, etc.).
pub async fn validate_ref_property_cross_space(
    conn: &mut sqlx::SqliteConnection,
    source_block_id: &BlockId,
    value_ref: Option<&str>,
    property_key: &str,
) -> Result<(), AppError> {
    let Some(target_str) = value_ref else {
        return Ok(());
    };

    // The `space` property itself is exempt — this is how pages
    // move between spaces. Every other ref property is gated.
    if property_key == crate::op::SPACE_PROPERTY_KEY {
        return Ok(());
    }

    let source_space = resolve_block_space(&mut *conn, source_block_id).await?;
    // Orphan source — no space to be "cross" to, nothing to enforce.
    let Some(source_space) = source_space else {
        return Ok(());
    };
    let target_id = BlockId::from_trusted(target_str);
    let target_space = resolve_block_space(&mut *conn, &target_id).await?;

    // Tolerate an orphan target; only a different assigned space violates.
    if let Some(target_space) = target_space
        && target_space != source_space
    {
        return Err(AppError::Validation(format!(
            "cross-space ref property: '{}' target '{}' (space {}) differs from source '{}' (space {})",
            property_key,
            target_str,
            target_space.as_str(),
            source_block_id.as_str(),
            source_space.as_str(),
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tests::common::test_pool;
    use crate::spaces::bootstrap::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
    use sqlx::SqlitePool;

    async fn seed_spaces(pool: &SqlitePool) {
        for (id, name) in [(SPACE_PERSONAL_ULID, "Personal"), (SPACE_WORK_ULID, "Work")] {
            sqlx::query!(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id)                  VALUES (?, 'page', ?, NULL, 1, ?)",
                id, name, id,
            )
            .execute(pool).await.unwrap();
            // #708: register in the `spaces` table — `blocks.space_id`
            // REFERENCES spaces(id) since migration 0089 (production
            // registers via the is_space property -> trigger).
            sqlx::query!("INSERT OR IGNORE INTO spaces (id) VALUES (?)", id)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    async fn seed_page(pool: &SqlitePool, page_id: &str, space_id: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id)              VALUES (?, 'page', 'Test', NULL, 1, ?, ?)",
            page_id, page_id, space_id,
        )
        .execute(pool).await.unwrap();
    }

    async fn seed_content(pool: &SqlitePool, block_id: &str, page_id: &str, content: &str) {
        // Content inherits its owning page's space (Phase 2: every block
        // carries `space_id` on its own row). Copy the page's column; NULL
        // when the page is itself unscoped (orphan-source/target tests).
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id)              SELECT ?, 'content', ?, ?, 1, ?, (SELECT space_id FROM blocks WHERE id = ?)",
            block_id, content, page_id, page_id, page_id,
        )
        .execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn content_scan_accepts_same_space_link() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let target = BlockId::new().to_string();
        seed_page(&pool, &page, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page, "").await;
        seed_content(&pool, &target, &page, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("see [[{target}]] for details");
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&blk), &content)
                .await;
        assert!(
            result.is_ok(),
            "same-space link should pass: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn content_scan_rejects_cross_space_link() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page_p = BlockId::new().to_string();
        let page_w = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let target = BlockId::new().to_string();
        seed_page(&pool, &page_p, SPACE_PERSONAL_ULID).await;
        seed_page(&pool, &page_w, SPACE_WORK_ULID).await;
        seed_content(&pool, &blk, &page_p, "").await;
        seed_content(&pool, &target, &page_w, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("see [[{target}]] for details");
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&blk), &content)
                .await;
        assert!(result.is_err(), "cross-space link should be rejected");
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("cross-space"),
            "error should mention cross-space: {msg}"
        );
    }

    #[tokio::test]
    async fn content_scan_orphan_source_is_noop() {
        // A source block with no space (orphan) has no space to
        // be "cross" to, so any reference passes.
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page_w = BlockId::new().to_string();
        let orphan = BlockId::new().to_string();
        let target = BlockId::new().to_string();
        seed_page(&pool, &page_w, SPACE_WORK_ULID).await;
        seed_content(&pool, &target, &page_w, "").await;
        seed_content(&pool, &orphan, &orphan, "").await; // orphan: no space prop

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("ref [[{target}]]");
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&orphan), &content)
                .await;
        assert!(
            result.is_ok(),
            "orphan source must be a no-op: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn content_scan_orphan_target_is_tolerated() {
        // A reference to an orphan (unassigned) target is
        // tolerated — it is not cross-space yet.
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page_p = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let orphan_target = BlockId::new().to_string();
        seed_page(&pool, &page_p, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page_p, "").await;
        seed_content(&pool, &orphan_target, &orphan_target, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("ref [[{orphan_target}]]");
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&blk), &content)
                .await;
        assert!(
            result.is_ok(),
            "orphan target must be tolerated: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn content_scan_accepts_same_space_tag_ref() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let tag = BlockId::new().to_string();
        seed_page(&pool, &page, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page, "").await;
        sqlx::query!("INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id)                       VALUES (?, 'tag', 't', NULL, 1, NULL, ?)", tag, SPACE_PERSONAL_ULID)
            .execute(&pool).await.unwrap();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("tagged with #[{tag}]");
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&blk), &content)
                .await;
        assert!(
            result.is_ok(),
            "same-space tag ref should pass: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn content_scan_rejects_cross_space_tag_ref() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let tag = BlockId::new().to_string();
        seed_page(&pool, &page, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page, "").await;
        sqlx::query!("INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id)                       VALUES (?, 'tag', 't', NULL, 1, NULL, ?)", tag, SPACE_WORK_ULID)
            .execute(&pool).await.unwrap();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("tagged with #[{tag}]");
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&blk), &content)
                .await;
        assert!(result.is_err(), "cross-space tag ref should be rejected");
    }

    #[tokio::test]
    async fn content_scan_empty_content_passes() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        seed_page(&pool, &page, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let result =
            validate_content_cross_space_refs(&mut tx, &BlockId::from_trusted(&blk), "hello world")
                .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn ref_property_accepts_same_space() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let target = BlockId::new().to_string();
        seed_page(&pool, &page, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page, "").await;
        seed_content(&pool, &target, &page, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let result = validate_ref_property_cross_space(
            &mut tx,
            &BlockId::from_trusted(&blk),
            Some(&target),
            "linked_page",
        )
        .await;
        assert!(
            result.is_ok(),
            "same-space ref property should pass: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn ref_property_rejects_cross_space() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page_p = BlockId::new().to_string();
        let page_w = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        let target = BlockId::new().to_string();
        seed_page(&pool, &page_p, SPACE_PERSONAL_ULID).await;
        seed_page(&pool, &page_w, SPACE_WORK_ULID).await;
        seed_content(&pool, &blk, &page_p, "").await;
        seed_content(&pool, &target, &page_w, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let result = validate_ref_property_cross_space(
            &mut tx,
            &BlockId::from_trusted(&blk),
            Some(&target),
            "linked_page",
        )
        .await;
        assert!(
            result.is_err(),
            "cross-space ref property should be rejected"
        );
    }

    #[tokio::test]
    async fn ref_property_none_is_noop() {
        let (pool, _dir) = test_pool().await;
        seed_spaces(&pool).await;
        let page = BlockId::new().to_string();
        let blk = BlockId::new().to_string();
        seed_page(&pool, &page, SPACE_PERSONAL_ULID).await;
        seed_content(&pool, &blk, &page, "").await;

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let result = validate_ref_property_cross_space(
            &mut tx,
            &BlockId::from_trusted(&blk),
            None,
            "linked_page",
        )
        .await;
        assert!(result.is_ok());
    }
}
