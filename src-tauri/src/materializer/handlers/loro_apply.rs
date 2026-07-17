//! Engine-routed apply handlers (`apply_*_via_loro`) plus the SQL
//! purge cascade. Each fn applies an op through the per-space Loro
//! engine then projects the result to SQL.

// #2621 (THE INVERSION): the engine-routed apply handlers moved DOWN into
// `agaric_engine::apply::loro_apply`. This shim re-exports them so the
// materializer coordinator + LOCAL command paths keep calling
// `crate::materializer::handlers::apply_*_via_loro` (and the test-only
// `purge_block_sql_cascade`) unchanged. App-side these handlers are reached only
// by the engine-path convergence tests (the moved kernel calls them INSIDE the
// engine), so the re-export is `#[cfg(test)]`.
#[cfg(test)]
pub(crate) use agaric_engine::apply::loro_apply::*;

#[cfg(test)]
mod purge_derived_tables_tests {
    use crate::db::init_pool;
    use crate::op::PurgeBlockPayload;
    use crate::ulid::BlockId;

    /// #1583: `purge_block_sql_cascade` must EXPLICITLY clear
    /// `block_tag_refs` and `page_link_cache` for the purged subtree
    /// rather than relying on FK `ON DELETE CASCADE`. Seed a block with
    /// an inline tag-ref row and a page-link edge, purge it, and assert
    /// both derived tables hold zero rows referencing the purged block.
    #[tokio::test]
    async fn purge_clears_block_tag_refs_and_page_link_cache() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let db_path = dir.path().join("purge_derived.db");
        let pool = init_pool(&db_path).await.expect("init_pool");

        const SRC: &str = "01HZ00000000000000000000S1";
        const TAG: &str = "01HZ00000000000000000000T1";
        const TGT: &str = "01HZ00000000000000000000P2";

        // Seed three plain blocks: the source we will purge, a tag block
        // it inline-references, and a target page it links to.
        for id in [SRC, TAG, TGT] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'seed', NULL, 0)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .expect("insert block");
        }

        // Inline tag reference: SRC content references TAG.
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
            .bind(SRC)
            .bind(TAG)
            .execute(&pool)
            .await
            .expect("insert block_tag_refs");
        // Page-link edge: SRC -> TGT.
        sqlx::query(
            "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES (?, ?, 1)",
        )
        .bind(SRC)
        .bind(TGT)
        .execute(&pool)
        .await
        .expect("insert page_link_cache");

        // Sanity: both derived rows exist pre-purge.
        let pre_refs: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ?")
                .bind(SRC)
                .fetch_one(&pool)
                .await
                .expect("pre count refs");
        let pre_links: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM page_link_cache WHERE source_page_id = ?")
                .bind(SRC)
                .fetch_one(&pool)
                .await
                .expect("pre count links");
        assert_eq!(pre_refs.0, 1, "seed: block_tag_refs row must exist");
        assert_eq!(pre_links.0, 1, "seed: page_link_cache row must exist");

        // Purge the source block via the SQL cascade under test.
        //
        // GUARD STRENGTH: `block_tag_refs` and `page_link_cache` both carry
        // FK `ON DELETE CASCADE` into `blocks(id)`, and `init_pool` enables
        // `PRAGMA foreign_keys = ON`. If we left FK enforcement on, the
        // final `DELETE FROM blocks` would clean these rows via the cascade
        // EVEN IF the explicit DELETEs in `purge_block_sql_cascade` were
        // removed — making this test a non-guard (it passed under a mutation
        // that deleted both explicit statements). Disable FK enforcement on
        // THIS connection so the cascade cannot fire: the only path that can
        // clear the rows is the explicit `DELETE FROM block_tag_refs` /
        // `DELETE FROM page_link_cache` under test. (`defer_foreign_keys`,
        // set inside the cascade, is a no-op when `foreign_keys = OFF`.)
        let mut conn = pool.acquire().await.expect("acquire");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .expect("disable fk enforcement on purge connection");
        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SRC),
        };
        super::purge_block_sql_cascade(&mut conn, &payload)
            .await
            .expect("purge_block_sql_cascade");
        drop(conn);

        // Both derived tables must be empty for the purged block —
        // proving the EXPLICIT DELETEs ran (not just an implicit FK
        // cascade).
        let post_refs: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? OR tag_id = ?")
                .bind(SRC)
                .bind(SRC)
                .fetch_one(&pool)
                .await
                .expect("post count refs");
        let post_links: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM page_link_cache \
             WHERE source_page_id = ? OR target_page_id = ?",
        )
        .bind(SRC)
        .bind(SRC)
        .fetch_one(&pool)
        .await
        .expect("post count links");
        assert_eq!(post_refs.0, 0, "purge must clear block_tag_refs rows");
        assert_eq!(post_links.0, 0, "purge must clear page_link_cache rows");
    }

    /// #1993 cascade safety: purging a block whose attachment shares a
    /// content-addressed blob with ANOTHER block must NOT unlink the blob
    /// bytes. `purge_block_sql_cascade` deletes only the attachment ROW; the
    /// refcount-aware GC then keeps the file because the sibling block's row
    /// still references it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_keeps_shared_blob_for_sibling_block_1993() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("purge_blob.db"))
            .await
            .expect("init_pool");

        const BLK_A: &str = "01HZ0000000000000000000PA1";
        const BLK_B: &str = "01HZ0000000000000000000PB1";
        let rel = "attachments/shared.bin";
        std::fs::create_dir_all(dir.path().join("attachments")).unwrap();
        std::fs::write(dir.path().join(rel), b"shared purge bytes").unwrap();

        for id in [BLK_A, BLK_B] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'seed', NULL, 0)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .expect("insert block");
        }
        // Two attachment rows (one per block) sharing one blob file.
        for (att, blk) in [("ATT_PA", BLK_A), ("ATT_PB", BLK_B)] {
            sqlx::query(
                "INSERT INTO attachments \
                 (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
                 VALUES (?, ?, 'application/zip', 'f.bin', 18, ?, 1735689600000, 'hash_shared')",
            )
            .bind(att)
            .bind(blk)
            .bind(rel)
            .execute(&pool)
            .await
            .expect("insert attachment");
        }
        sqlx::query(
            "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
             VALUES ('hash_shared', ?, 18, 1735689600000)",
        )
        .bind(rel)
        .execute(&pool)
        .await
        .expect("insert blob");

        // Purge block A (deletes only its attachment ROW — never the file).
        let mut conn = pool.acquire().await.expect("acquire");
        let payload = crate::op::PurgeBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLK_A),
        };
        super::purge_block_sql_cascade(&mut conn, &payload)
            .await
            .expect("purge");
        drop(conn);

        // GC must NOT unlink the file: block B's row still references it.
        crate::materializer::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
            .await
            .expect("gc");

        assert!(
            dir.path().join(rel).exists(),
            "shared blob file must survive purge while sibling block references it"
        );
        let blob_n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            blob_n, 1,
            "blob row must survive while a sibling references it"
        );
        // Block B's row is intact.
        let b_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE block_id = ?")
            .bind(BLK_B)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(b_rows, 1, "sibling block's attachment row must be intact");
    }
}
