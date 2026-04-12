//! Purge: `purge_block` and `is_safe_attachment_path`.

use sqlx::SqlitePool;

use crate::error::AppError;

/// Validate that an attachment `fs_path` is safe for file-system deletion.
fn is_safe_attachment_path(path: &str) -> bool {
    use std::path::Path;
    let p = Path::new(path);
    if p.is_absolute() {
        return false;
    }
    p.components()
        .all(|c| !matches!(c, std::path::Component::ParentDir))
}

/// Permanently delete a block and all its descendants (physical removal).
pub async fn purge_block(pool: &SqlitePool, block_id: &str) -> Result<u64, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR tag_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM descendants) \
            OR target_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    let attachment_rows = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         SELECT fs_path FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM blocks \
         WHERE id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();
    tx.commit().await?;

    for r in &attachment_rows {
        let path = &r.fs_path;
        if !is_safe_attachment_path(path) {
            tracing::warn!(path, "skipping attachment deletion: unsafe path");
            continue;
        }
        if let Err(e) = std::fs::remove_file(path) {
            tracing::warn!(path, error = %e, "failed to remove attachment file after purge");
        }
    }

    Ok(count)
}

// ---------------------------------------------------------------------------
// Tests: is_safe_attachment_path
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_path_accepts_simple_relative() {
        assert!(is_safe_attachment_path("attachments/photo.png"));
    }
    #[test]
    fn safe_path_accepts_nested_relative() {
        assert!(is_safe_attachment_path("attachments/2025/01/photo.png"));
    }
    #[test]
    fn safe_path_accepts_filename_only() {
        assert!(is_safe_attachment_path("photo.png"));
    }
    #[test]
    fn safe_path_rejects_absolute_unix() {
        assert!(!is_safe_attachment_path("/etc/passwd"));
    }
    #[test]
    fn safe_path_rejects_absolute_tmp() {
        assert!(!is_safe_attachment_path("/tmp/photo.png"));
    }
    #[test]
    fn safe_path_rejects_parent_traversal() {
        assert!(!is_safe_attachment_path("../../../etc/passwd"));
    }
    #[test]
    fn safe_path_rejects_embedded_parent_traversal() {
        assert!(!is_safe_attachment_path("attachments/../../secret.txt"));
    }
    #[test]
    fn safe_path_rejects_dot_dot_only() {
        assert!(!is_safe_attachment_path(".."));
    }
}
