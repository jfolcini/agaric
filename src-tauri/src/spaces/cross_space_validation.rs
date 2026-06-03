//! Cross-space reference validation (PEND-15 Phase 2 enforcement).
//!
//! The two helpers below are called BEFORE emitting an op so a write
//! that would introduce a cross-space reference is rejected up front.
//! PEND-76 F5 wired them into the single-block command paths:
//! `set_property` (ref-type values, `set_property_in_tx`), block create
//! (`create_block_in_tx`), and block edit (`edit_block_inner`).
//! `add_tag` enforces cross-space via its own inline guard. (Bulk-import
//! and sync-ingress are not yet gated — a follow-up.)
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
//! connection. PEND-76 F5: enforcement applies only
//! when BOTH the source and the target are assigned to a space — an
//! orphan (unassigned) block is not "cross-space" to anything, so it is
//! tolerated (mirrors the orphan-tag adoption in `add_tag`).

use crate::cache::{TAG_REF_RE, ULID_LINK_RE};
use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::space::{resolve_block_space, SpaceId};
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
        // Per input block `b`, resolve its owning page via
        // `COALESCE(page_id, id)` (both soft-delete filtered) then read
        // that page's `space` property. A block with no `space` row
        // yields a NULL `space_id` and is dropped below.
        let sql = format!(
            "SELECT b.id AS input_id, bp.value_ref AS space_id \
               FROM blocks b \
               LEFT JOIN block_properties bp \
                 ON bp.block_id = COALESCE( \
                      (SELECT page_id FROM blocks \
                        WHERE id = b.id AND deleted_at IS NULL), \
                      b.id) \
                AND bp.key = 'space' \
                AND EXISTS (SELECT 1 FROM blocks tgt \
                             WHERE tgt.id = bp.block_id \
                               AND tgt.deleted_at IS NULL) \
              WHERE b.id IN ({placeholders})"
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
    // PEND-76 F5: only enforce when the source block is itself assigned to
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
        if let Some(target_space) = target_spaces.get(target_str) {
            if *target_space != source_space {
                return Err(AppError::Validation(format!(
                    "cross-space reference: block '{}' (space {}) references '{}' (space {})",
                    source_block_id.as_str(),
                    source_space.as_str(),
                    target_str,
                    target_space.as_str(),
                )));
            }
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
    if property_key == "space" {
        return Ok(());
    }

    let source_space = resolve_block_space(&mut *conn, source_block_id).await?;
    // PEND-76 F5: orphan source — no space to be "cross" to, nothing to enforce.
    let Some(source_space) = source_space else {
        return Ok(());
    };
    let target_id = BlockId::from_trusted(target_str);
    let target_space = resolve_block_space(&mut *conn, &target_id).await?;

    // Tolerate an orphan target; only a different assigned space violates.
    if let Some(target_space) = target_space {
        if target_space != source_space {
            return Err(AppError::Validation(format!(
                "cross-space ref property: '{}' target '{}' (space {}) differs from source '{}' (space {})",
                property_key,
                target_str,
                target_space.as_str(),
                source_block_id.as_str(),
                source_space.as_str(),
            )));
        }
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
        }
    }

    async fn seed_page(pool: &SqlitePool, page_id: &str, space_id: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id)              VALUES (?, 'page', 'Test', NULL, 1, ?)",
            page_id, page_id,
        )
        .execute(pool).await.unwrap();
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref)              VALUES (?, 'space', NULL, NULL, NULL, ?)",
            page_id, space_id,
        )
        .execute(pool).await.unwrap();
    }

    async fn seed_content(pool: &SqlitePool, block_id: &str, page_id: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id)              VALUES (?, 'content', ?, ?, 1, ?)",
            block_id, content, page_id, page_id,
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
        let content = format!("see [[{}]] for details", target);
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
        let content = format!("see [[{}]] for details", target);
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
        // PEND-76 F5: a source block with no space (orphan) has no space to
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
        let content = format!("ref [[{}]]", target);
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
        // PEND-76 F5: a reference to an orphan (unassigned) target is
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
        let content = format!("ref [[{}]]", orphan_target);
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
        sqlx::query!("INSERT INTO blocks (id, block_type, content, parent_id, position, page_id)                       VALUES (?, 'tag', 't', NULL, 1, NULL)", tag)
            .execute(&pool).await.unwrap();
        sqlx::query!("INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref)                       VALUES (?, 'space', NULL, NULL, NULL, ?)", tag, SPACE_PERSONAL_ULID)
            .execute(&pool).await.unwrap();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("tagged with #[{}]", tag);
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
        sqlx::query!("INSERT INTO blocks (id, block_type, content, parent_id, position, page_id)                       VALUES (?, 'tag', 't', NULL, 1, NULL)", tag)
            .execute(&pool).await.unwrap();
        sqlx::query!("INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref)                       VALUES (?, 'space', NULL, NULL, NULL, ?)", tag, SPACE_WORK_ULID)
            .execute(&pool).await.unwrap();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let content = format!("tagged with #[{}]", tag);
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
