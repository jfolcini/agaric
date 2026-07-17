//! SQL-only apply fallbacks (`apply_*_sql_only`): the projection
//! path used when the Loro engine is unavailable / space unresolved.

// #2621 (THE INVERSION): the `apply_*_sql_only` fallbacks moved DOWN into
// `agaric_engine::apply::sql_only`. This shim re-exports them so callers
// keep the `crate::materializer::handlers::apply_*_sql_only` paths. App-side
// these fallbacks are reached only by the engine-path convergence tests (the
// moved kernel calls them INSIDE the engine), so the re-export is `#[cfg(test)]`.
#[cfg(test)]
pub(crate) use agaric_engine::apply::sql_only::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::CreateBlockPayload;
    use crate::ulid::BlockId;
    use tempfile::TempDir;

    const PAGE_ID: &str = "01HZ00000000000000000000P1";
    const CONTENT_ID: &str = "01HZ00000000000000000000C1";

    fn create_block_payload(block_id: &str, block_type: &str) -> CreateBlockPayload {
        CreateBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            block_type: block_type.to_string(),
            parent_id: None,
            position: None,
            index: Some(0),
            content: String::new(),
        }
    }

    /// #1324: the engine-less fallback must stamp `page_id = id` for a page
    /// block. Before the fix this INSERT left `page_id` NULL (the CHECK accepts
    /// NULL), and the deferred `SetBlockPageId` task is skipped for pages, so a
    /// replayed / space-unresolved page create stayed NULL-owned.
    #[tokio::test]
    async fn sql_only_create_page_block_stamps_page_id_self() {
        let dir = TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("sql_only.db"))
            .await
            .expect("init_pool");

        let mut conn = pool.acquire().await.expect("acquire");
        apply_create_block_sql_only(&mut conn, create_block_payload(PAGE_ID, "page"))
            .await
            .expect("page fallback must satisfy the page_id CHECK, not trip it");
        drop(conn);

        let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(PAGE_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(page_id.as_deref(), Some(PAGE_ID));
    }

    /// A non-page block keeps NULL `page_id`; the deferred `SetBlockPageId`
    /// task fills it from the parent.
    #[tokio::test]
    async fn sql_only_create_non_page_block_keeps_null_page_id() {
        let dir = TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("sql_only.db"))
            .await
            .expect("init_pool");

        let mut conn = pool.acquire().await.expect("acquire");
        apply_create_block_sql_only(&mut conn, create_block_payload(CONTENT_ID, "content"))
            .await
            .expect("project");
        drop(conn);

        let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(CONTENT_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(page_id, None);
    }
}
