use super::*;

// ============================================================================
// C-3c — orphaned attachments GC tests
// ============================================================================

/// Helper: insert a row into `attachments` for the GC test.
async fn insert_attachment_row(
    pool: &SqlitePool,
    attachment_id: &str,
    block_id: &str,
    fs_path: &str,
) {
    // Make sure a parent block exists so the FK in `attachments` resolves.
    let _ = sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content) VALUES (?, 'content', '')",
    )
    .bind(block_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, 'application/octet-stream', 'f', 1, ?, 1735689600000)",
    )
    .bind(attachment_id)
    .bind(block_id)
    .bind(fs_path)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_dir_missing_is_noop() {
    // C-3c safety check: no `attachments/` subdirectory under
    // `app_data_dir` → handler returns Ok and touches nothing.
    let (pool, dir) = test_pool().await;
    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();
    assert!(
        !dir.path().join("attachments").exists(),
        "GC pass must not create the attachments directory"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_dir_empty_is_noop() {
    // C-3c safety check: empty `attachments/` → no-op.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();
    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();
    assert!(
        attachments.exists(),
        "empty attachments directory must remain after GC pass"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_all_referenced_keeps_files() {
    // C-3c happy path: every file in `attachments/` has a matching
    // row in the `attachments` table → no files removed.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    for i in 0..3 {
        let rel = format!("attachments/file_{i}.dat");
        let full = dir.path().join(&rel);
        tokio::fs::write(&full, b"data").await.unwrap();
        insert_attachment_row(&pool, &format!("ATT_{i}"), &format!("BLK_{i}"), &rel).await;
    }

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    for i in 0..3 {
        let full = dir.path().join(format!("attachments/file_{i}.dat"));
        assert!(
            full.exists(),
            "referenced attachment file must not be removed: {}",
            full.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_all_orphaned_are_removed() {
    // C-3c reconciliation path: 3 files on disk, 0 rows referencing
    // them → all 3 unlinked.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    for i in 0..3 {
        let full = attachments.join(format!("orphan_{i}.dat"));
        tokio::fs::write(&full, b"orphaned").await.unwrap();
    }

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    for i in 0..3 {
        let full = attachments.join(format!("orphan_{i}.dat"));
        assert!(
            !full.exists(),
            "orphan file must be removed: {}",
            full.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_mixed_referenced_and_orphaned() {
    // C-3c mixed case: 2 referenced files + 1 orphan → only the
    // orphan unlinked, references untouched.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let rel_a = "attachments/keep_a.dat".to_string();
    let rel_b = "attachments/keep_b.dat".to_string();
    let rel_orphan = "attachments/orphan.dat".to_string();

    tokio::fs::write(dir.path().join(&rel_a), b"a")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join(&rel_b), b"b")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join(&rel_orphan), b"o")
        .await
        .unwrap();

    insert_attachment_row(&pool, "ATT_A", "BLK_A", &rel_a).await;
    insert_attachment_row(&pool, "ATT_B", "BLK_B", &rel_b).await;

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        dir.path().join(&rel_a).exists(),
        "referenced file A must remain"
    );
    assert!(
        dir.path().join(&rel_b).exists(),
        "referenced file B must remain"
    );
    assert!(
        !dir.path().join(&rel_orphan).exists(),
        "orphan file must be removed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_uses_read_pool() {
    // #385: when a dedicated read pool is supplied, the referenced
    // fs_path set is loaded through it (not the write pool) and the
    // orphan/keep decision is byte-identical to the single-pool path.
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let write_pool = init_pool(&db_path).await.unwrap();
    // Second pool over the same DB file stands in for the reader pool.
    let read_pool = init_pool(&db_path).await.unwrap();

    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let rel_keep = "attachments/keep.dat".to_string();
    let rel_orphan = "attachments/orphan.dat".to_string();
    tokio::fs::write(dir.path().join(&rel_keep), b"k")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join(&rel_orphan), b"o")
        .await
        .unwrap();
    insert_attachment_row(&write_pool, "ATT_K", "BLK_K", &rel_keep).await;

    super::super::handlers::cleanup_orphaned_attachments(&write_pool, Some(&read_pool), dir.path())
        .await
        .unwrap();

    assert!(
        dir.path().join(&rel_keep).exists(),
        "referenced file must remain when set is loaded via the read pool"
    );
    assert!(
        !dir.path().join(&rel_orphan).exists(),
        "orphan file must be removed when set is loaded via the read pool"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_subdir_walk() {
    // C-3c subdirectory walk: a file under `attachments/sub/` must be
    // Walked into and removed if unreferenced. large-vault
    // layouts may organize attachments into subdirectories.
    let (pool, dir) = test_pool().await;
    let sub = dir.path().join("attachments").join("sub");
    tokio::fs::create_dir_all(&sub).await.unwrap();
    let nested = sub.join("x.dat");
    tokio::fs::write(&nested, b"nested orphan").await.unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        !nested.exists(),
        "nested orphan in subdirectory must be removed: {}",
        nested.display()
    );
}

/// Insert an `attachment_blobs` row for the dedup GC tests.
async fn insert_blob_row(pool: &SqlitePool, content_hash: &str, on_disk_path: &str) {
    sqlx::query(
        "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
         VALUES (?, ?, 1, 1735689600000)",
    )
    .bind(content_hash)
    .bind(on_disk_path)
    .execute(pool)
    .await
    .unwrap();
}

/// #1993 GC refcount: a blob file shared by TWO live attachment rows must
/// survive a GC pass (both rows still reference it). After one row is deleted
/// the file STILL survives (the other row references it). Only when BOTH rows
/// are gone does GC unlink the file AND prune the orphaned blob row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_keeps_shared_blob_until_last_ref_1993() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let rel = "attachments/shared.bin".to_string();
    tokio::fs::write(dir.path().join(&rel), b"shared bytes")
        .await
        .unwrap();

    // Two rows (different blocks) pointing at one file + one blob row.
    insert_attachment_row(&pool, "ATT_S1", "BLK_S1", &rel).await;
    insert_attachment_row(&pool, "ATT_S2", "BLK_S2", &rel).await;
    insert_blob_row(&pool, "hash_shared", &rel).await;

    // Pass 1: both rows reference it → file + blob row survive.
    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();
    assert!(
        dir.path().join(&rel).exists(),
        "shared file must survive while referenced"
    );
    let blob_n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(blob_n, 1, "blob row must survive while referenced");

    // Delete ONE row → the other still references the file.
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind("ATT_S1")
        .execute(&pool)
        .await
        .unwrap();
    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();
    assert!(
        dir.path().join(&rel).exists(),
        "file must survive while a sibling row still references it"
    );
    let blob_n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blob_n, 1,
        "blob row must survive while a sibling references it"
    );

    // Delete the LAST row → file + blob row are reclaimed.
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind("ATT_S2")
        .execute(&pool)
        .await
        .unwrap();
    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();
    assert!(
        !dir.path().join(&rel).exists(),
        "file must be unlinked once no row references it"
    );
    let blob_n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(blob_n, 0, "orphaned blob row must be pruned");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_unlink_error_is_non_fatal() {
    // C-3c robustness: when an unlink fails (e.g. parent directory is
    // read-only), the GC pass must still complete Ok and continue
    // processing other files. Skipped on Windows because Unix-style
    // chmod doesn't translate to a "remove blocked" semantic there.
    use std::os::unix::fs::PermissionsExt;

    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    let locked = attachments.join("locked");
    tokio::fs::create_dir_all(&locked).await.unwrap();

    // Place an orphan inside the read-only directory so `remove_file`
    // gets EACCES while the parent walk still succeeds (read perms
    // intact, write perms removed via 0o555).
    let orphan = locked.join("blocked.dat");
    tokio::fs::write(&orphan, b"can't unlink me").await.unwrap();

    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(&locked, perms).unwrap();

    // Also place an orphan in a normal directory so we can confirm the
    // pass continued past the failure.
    let removable = attachments.join("removable.dat");
    tokio::fs::write(&removable, b"orphan").await.unwrap();

    let result =
        super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path()).await;

    // Restore write perms so TempDir can clean up.
    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&locked, perms).unwrap();

    assert!(
        result.is_ok(),
        "GC pass must not propagate per-file unlink errors"
    );
    assert!(
        !removable.exists(),
        "removable orphan must still be unlinked even if another file failed",
    );
}
