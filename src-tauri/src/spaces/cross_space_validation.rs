//! Cross-space reference validation (PEND-15 Phase 2 enforcement).
//!
//! Every code path that could produce a cross-space reference calls
//! one of the two helpers below BEFORE emitting an op:
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
//! Both helpers are generic over [`sqlx::SqliteExecutor`] so they
//! work inside the command's `BEGIN IMMEDIATE` transaction without
//! opening a fresh connection.

use crate::cache::{TAG_REF_RE, ULID_LINK_RE};
use crate::error::AppError;
use crate::space::resolve_block_space;
use crate::ulid::BlockId;

/// Scan `content` for ULID tokens and validate every referenced block
/// belongs to the same space as `source_block_id`.
///
/// Returns `Ok(())` when the content is clean (or contains no tokens).
/// Returns `Err(AppError::Validation)` on the first cross-space token
/// found.
pub async fn validate_content_cross_space_refs(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    source_block_id: &BlockId,
    content: &str,
) -> Result<(), AppError> {
    let source_space = resolve_block_space(&mut **tx, source_block_id).await?;

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

    for target_str in targets {
        let target_id = BlockId::from_trusted(target_str);
        let target_space = resolve_block_space(&mut **tx, &target_id).await?;
        if target_space != source_space {
            return Err(AppError::Validation(format!(
                "cross-space reference: block '{}' (space {:?}) references '{}' (space {:?})",
                source_block_id.as_str(),
                source_space,
                target_str,
                target_space,
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
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
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

    let target_id = BlockId::from_trusted(target_str);
    let source_space = resolve_block_space(&mut **tx, source_block_id).await?;
    let target_space = resolve_block_space(&mut **tx, &target_id).await?;

    if target_space != source_space {
        return Err(AppError::Validation(format!(
            "cross-space ref property: '{}' target '{}' (space {:?}) differs from source '{}' (space {:?})",
            property_key,
            target_str,
            target_space,
            source_block_id.as_str(),
            source_space,
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
