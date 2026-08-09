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

/// #2032 — TOCTOU race regression. The background GC loads the referenced
/// `fs_path` set up front (here, from a SEPARATE read pool whose snapshot
/// does NOT contain the row, simulating a read-replica that lags the writer
/// or a foreground `AddAttachment` that commits after the bulk load). The
/// file is on disk and IS referenced by a row in the WRITE pool. The
/// per-file write-pool re-check before unlink must find that row and KEEP
/// the file — without the re-check it would be unlinked as a false orphan.
///
/// A second, genuinely orphaned file (referenced by NEITHER pool) must still
/// be removed, proving the re-check does not disable orphan collection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_write_pool_recheck_survives_lagging_read_snapshot_2032() {
    let dir = TempDir::new().unwrap();
    // Write pool over the real DB file; this is where the foreground apply
    // path commits, and where the per-file re-check reads.
    let write_db = dir.path().join("write.db");
    let write_pool = init_pool(&write_db).await.unwrap();
    // A DISTINCT read pool over a DIFFERENT, empty DB stands in for a
    // reference snapshot that lags the writer: it will NOT contain the row
    // we are about to add to the write pool, so the bulk-load membership
    // test misses it and the file looks like an orphan to the fast path.
    let read_db = dir.path().join("read.db");
    let read_pool = init_pool(&read_db).await.unwrap();

    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    // Referenced-in-write-pool-only file (the "just added, not yet in the
    // read snapshot" attachment).
    let rel_racing = "attachments/racing.dat".to_string();
    // Genuinely orphaned file (in neither pool).
    let rel_orphan = "attachments/orphan.dat".to_string();
    tokio::fs::write(dir.path().join(&rel_racing), b"racing")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join(&rel_orphan), b"orphan")
        .await
        .unwrap();

    // The row exists ONLY in the write pool — exactly the lag/race state.
    insert_attachment_row(&write_pool, "ATT_RACE", "BLK_RACE", &rel_racing).await;

    super::super::handlers::cleanup_orphaned_attachments(&write_pool, Some(&read_pool), dir.path())
        .await
        .unwrap();

    assert!(
        dir.path().join(&rel_racing).exists(),
        "a file referenced in the write pool but absent from the lagging read snapshot \
         must survive GC because the write-pool re-check finds its row (#2032)"
    );
    assert!(
        !dir.path().join(&rel_orphan).exists(),
        "a genuinely orphaned file (referenced by neither pool) must still be removed"
    );
}

/// #2032 — companion to the lagging-snapshot test using the single-pool
/// path: when the file IS referenced at unlink time per the write pool it
/// survives, and an unreferenced sibling is removed. This guards the
/// re-check on the common (no dedicated read pool) materializer wiring.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_recheck_keeps_referenced_single_pool_2032() {
    let (pool, dir) = test_pool().await;
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
    insert_attachment_row(&pool, "ATT_K2032", "BLK_K2032", &rel_keep).await;

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        dir.path().join(&rel_keep).exists(),
        "referenced file must survive GC (write-pool re-check)"
    );
    assert!(
        !dir.path().join(&rel_orphan).exists(),
        "unreferenced file must still be removed"
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

/// #3371 — the GC must destroy a blob MAPPING before it destroys the BYTES
/// that mapping points at, never the other way round.
///
/// `add_attachment` dedups fresh bytes onto an existing blob via
/// `SELECT on_disk_path FROM attachment_blobs WHERE content_hash = ?`. If the
/// GC unlinks the file first and prunes the row afterwards, a concurrent
/// re-add of the same bytes in between resolves that row, dedups onto the
/// path, and commits an `attachments` row pointing at a file that is already
/// gone. The reverse order is benign: a missing row while the file survives
/// only costs one redundant re-copy on the next ingest.
///
/// Driving the real interleaving from a test would be timing-dependent, so
/// this pins the ordering deterministically instead: a `BEFORE DELETE` trigger
/// on `attachment_blobs` makes the prune fail, freezing the mapping in place
/// for the whole pass. The GC may then NOT unlink the bytes — the post-state
/// "blob row present, file gone" is exactly the broken reference the ordering
/// exists to prevent, and it is unreachable only if the prune is attempted
/// before the unlink and gates it.
///
/// Phase 2 drops the trigger and re-runs so the assertion cannot pass merely
/// because the GC has stopped collecting: with the prune unblocked, both the
/// row and the bytes must go.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_never_unlinks_bytes_a_live_blob_row_maps_3371() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    // Unreferenced bytes: a file on disk plus the blob row that maps its
    // content hash to it. No `attachments` row references either, so the GC
    // regards the file as a collectable orphan.
    let rel = "attachments/dedup_target.bin".to_string();
    tokio::fs::write(dir.path().join(&rel), b"dedup me")
        .await
        .unwrap();
    insert_blob_row(&pool, "hash_3371", &rel).await;

    // Freeze the mapping: any DELETE that would remove a blob row aborts.
    // (A DELETE matching zero rows still succeeds — the trigger is per-row —
    // so this only fires when the GC actually tries to prune this mapping.)
    sqlx::query(
        "CREATE TRIGGER block_blob_prune_3371 BEFORE DELETE ON attachment_blobs \
         BEGIN SELECT RAISE(ABORT, 'blob prune blocked by test'); END",
    )
    .execute(&pool)
    .await
    .unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    // The mapping is still live (the trigger guaranteed it)…
    let blob_path: Option<String> =
        sqlx::query_scalar("SELECT on_disk_path FROM attachment_blobs WHERE content_hash = ?")
            .bind("hash_3371")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert_eq!(
        blob_path.as_deref(),
        Some(rel.as_str()),
        "test precondition: the trigger must have kept the blob mapping alive"
    );

    // …so the bytes it points at must NOT have been reclaimed. A concurrent
    // `add_attachment` for these bytes would dedup onto this very path.
    assert!(
        dir.path().join(&rel).exists(),
        "GC unlinked bytes while a live attachment_blobs row still maps a \
         content_hash onto them — a concurrent re-add would dedup onto this \
         deleted file (#3371)"
    );

    // Phase 2: unblock the prune. The same pass must now reclaim BOTH, proving
    // the assertion above is not passing because collection is simply off.
    sqlx::query("DROP TRIGGER block_blob_prune_3371")
        .execute(&pool)
        .await
        .unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    let blob_n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(blob_n, 0, "orphaned blob row must be pruned once unblocked");
    assert!(
        !dir.path().join(&rel).exists(),
        "orphaned bytes must be reclaimed once the mapping can be pruned"
    );
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

/// #3519 — a row committed in the gap between the write-pool orphan re-check
/// and the destruction of the bytes must not lose those bytes.
///
/// The window is microseconds wide in production, so this drives it directly:
/// the GC pauses at a test rendezvous placed immediately after it has decided
/// the file is an orphan and before any byte has moved, the test commits an
/// `attachments` row referencing that exact path — standing in for the two
/// writers that can still do this, a replicated peer `AddAttachment` and the
/// undo of a local `DeleteAttachment`, both of which insert an explicit
/// payload `fs_path` — and then releases the GC.
///
/// Pre-fix the GC unlinks straight through and the row is left pointing at
/// deleted bytes. Post-fix the bytes are quarantined rather than destroyed,
/// the post-quarantine confirmation sees the new row, and the bytes are handed
/// back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_restores_bytes_referenced_inside_the_unlink_window_3519() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    // An orphan by every measure the GC has: on disk, referenced by nothing.
    let rel = "attachments/raced.bin";
    tokio::fs::write(dir.path().join(rel), b"bytes worth keeping")
        .await
        .unwrap();

    let (hook_tx, mut hook_rx) = tokio::sync::mpsc::unbounded_channel();
    *super::super::handlers::GC_RACE_RENDEZVOUS.lock().unwrap() = Some(hook_tx);

    let gc = tokio::spawn({
        let pool = pool.clone();
        let root = dir.path().to_path_buf();
        async move { super::super::handlers::cleanup_orphaned_attachments(&pool, None, &root).await }
    });

    // The GC has classified `rel` as an orphan and has not touched it yet.
    let (paused_on, release) =
        tokio::time::timeout(std::time::Duration::from_secs(10), hook_rx.recv())
            .await
            .expect("GC never reached the in-window rendezvous")
            .expect("rendezvous channel closed before the GC reached it");
    assert_eq!(
        paused_on, rel,
        "the rendezvous must fire for the orphan under test"
    );

    // Commit the reference INSIDE the window.
    insert_attachment_row(&pool, "ATT_3519", "01HZ0000000000000000003519", rel).await;

    release
        .send(())
        .expect("GC stopped listening for the release");
    gc.await.expect("GC task panicked").expect("GC pass");

    *super::super::handlers::GC_RACE_RENDEZVOUS.lock().unwrap() = None;

    // The row is live…
    let referenced: Option<String> =
        sqlx::query_scalar("SELECT fs_path FROM attachments WHERE id = ?")
            .bind("ATT_3519")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert_eq!(
        referenced.as_deref(),
        Some(rel),
        "test precondition: the racing row must have committed"
    );

    // …so its bytes must still be there.
    assert!(
        dir.path().join(rel).exists(),
        "GC destroyed bytes a row committed inside the check-to-unlink window \
         references (#3519)"
    );

    // And nothing may be stranded under a quarantine name.
    let mut leftovers = Vec::new();
    let mut rd = tokio::fs::read_dir(&attachments).await.unwrap();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".agaric-gc-") {
            leftovers.push(name);
        }
    }
    assert!(
        leftovers.is_empty(),
        "restored bytes must return to their original path, not linger in quarantine: {leftovers:?}"
    );
}

/// #3519 companion — the quarantine detour must not make the GC stop
/// collecting. Same rendezvous, but the test commits nothing while the GC is
/// paused, so the confirmation still finds no reference and the bytes go.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_still_collects_when_nothing_races_3519() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let rel = "attachments/uncontested.bin";
    tokio::fs::write(dir.path().join(rel), b"nobody wants these")
        .await
        .unwrap();

    let (hook_tx, mut hook_rx) = tokio::sync::mpsc::unbounded_channel();
    *super::super::handlers::GC_RACE_RENDEZVOUS.lock().unwrap() = Some(hook_tx);

    let gc = tokio::spawn({
        let pool = pool.clone();
        let root = dir.path().to_path_buf();
        async move { super::super::handlers::cleanup_orphaned_attachments(&pool, None, &root).await }
    });

    let (_paused_on, release) =
        tokio::time::timeout(std::time::Duration::from_secs(10), hook_rx.recv())
            .await
            .expect("GC never reached the in-window rendezvous")
            .expect("rendezvous channel closed before the GC reached it");
    release
        .send(())
        .expect("GC stopped listening for the release");
    gc.await.expect("GC task panicked").expect("GC pass");

    *super::super::handlers::GC_RACE_RENDEZVOUS.lock().unwrap() = None;

    assert!(
        !dir.path().join(rel).exists(),
        "an uncontested orphan must still be reclaimed through the quarantine path"
    );
    let mut rd = tokio::fs::read_dir(&attachments).await.unwrap();
    let mut remaining = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        remaining.push(entry.file_name().to_string_lossy().into_owned());
    }
    assert!(
        remaining.is_empty(),
        "the quarantined copy must be destroyed too, leaving nothing behind: {remaining:?}"
    );
}

// ============================================================================
// #3370 — a peer-supplied `fs_path` must reach the row already canonical
// ============================================================================

/// Apply a replicated `AddAttachment` through the production apply path, the
/// way sync's op-apply does, and hand back what actually landed in the row.
async fn apply_peer_add_attachment(
    pool: &SqlitePool,
    attachment_id: &str,
    fs_path: &str,
) -> String {
    const BLK: &str = "01HZ3370000000000000000BLK";
    sqlx::query("INSERT OR IGNORE INTO blocks (id, block_type, content) VALUES (?, 'content', '')")
        .bind(BLK)
        .execute(pool)
        .await
        .unwrap();

    let mut conn = pool.acquire().await.unwrap();
    agaric_engine::apply::attachments::apply_add_attachment_tx(
        &mut conn,
        AddAttachmentPayload {
            attachment_id: BlockId::from(attachment_id),
            block_id: BlockId::from(BLK),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 5,
            fs_path: fs_path.to_owned(),
        },
        FIXED_TS,
    )
    .await
    .expect("apply must never reject a replicated op");
    drop(conn);

    sqlx::query_scalar::<_, String>("SELECT fs_path FROM attachments WHERE id = ?")
        .bind(attachment_id)
        .fetch_one(pool)
        .await
        .expect("the replicated row must exist")
}

/// #3370 — the GC decides what to unlink by testing its walk-derived path
/// string (`attachments/photo.png`) for membership in the set of stored
/// `fs_path` strings. A peer that spells the same file `attachments/./photo.png`
/// misses that set, and the GC destroys the bytes of the very row that
/// references them — silent data loss on a live attachment, on a path where a
/// hard reject is not available because it would wedge the apply pipeline.
///
/// So the apply path must canonicalize before the value is stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replicated_non_canonical_fs_path_keeps_its_bytes_through_a_gc_pass_3370() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();
    // The bytes live where every resolver puts them; only the *spelling* the
    // peer used differs.
    let full = attachments.join("photo.png");
    tokio::fs::write(&full, b"bytes").await.unwrap();

    let stored = apply_peer_add_attachment(
        &pool,
        "01HZ3370000000000000000AT1",
        "attachments/./photo.png",
    )
    .await;
    assert_eq!(
        stored, "attachments/photo.png",
        "the row must hold the spelling the GC's directory walk produces"
    );

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        full.exists(),
        "the GC destroyed the bytes of a live, referenced attachment because the \
         row spelled the path non-canonically (#3370)"
    );
}

/// #3370 — the hostile case. `app_data_dir` holds the SQLite database itself,
/// so a peer-supplied *relative* path outside `attachments/` names a
/// non-attachment file. The old shape check accepted any relative path, and the
/// file-receive path writes the peer's bytes at whatever the row says.
///
/// The row must never hold such a value in the first place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replicated_fs_path_naming_the_database_file_never_reaches_the_row_3370() {
    let (pool, dir) = test_pool().await;

    let stored = apply_peer_add_attachment(&pool, "01HZ3370000000000000000AT2", "notes.db").await;

    assert_eq!(
        stored, "attachments/01HZ3370000000000000000AT2",
        "an unusable peer path must be replaced by this device's own path, not stored"
    );
    // And the replacement is a value the resolvers will accept, so the
    // attachment stays fetchable rather than being wedged by its own fix.
    agaric_sync::sync_files::validate_attachment_fs_path(dir.path(), &stored)
        .expect("the coerced path must resolve");
}

/// #3370 — traversal spellings that the *old* shape check already refused at
/// use time were still stored verbatim by apply, leaving a row no resolver
/// could ever read. They are coerced now, on the same path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replicated_traversal_fs_path_never_reaches_the_row_3370() {
    let (pool, _dir) = test_pool().await;

    let stored = apply_peer_add_attachment(
        &pool,
        "01HZ3370000000000000000AT3",
        "attachments/../../../etc/passwd",
    )
    .await;

    assert_eq!(stored, "attachments/01HZ3370000000000000000AT3");
    assert!(!stored.contains(".."), "no `..` may survive into the row");
}

// ============================================================================
// #3370 review — the coercion fallback must itself be storable
// ============================================================================

/// The fallback path is built from `attachment_id`, which is as peer-supplied
/// as `fs_path` is: `BlockId`'s `Deserialize` falls back to a plain
/// ASCII-uppercase for any non-ULID string with no error, and nothing
/// constrains `attachments.id` to a ULID.
///
/// So an id can carry a character `parse` refuses. `sanitize_attachment_filename`
/// neutralizes separators and control characters — it has no reason to care
/// about `:`, which is a drive / NTFS-stream separator and which `parse` and
/// migration 0108 both reject. The fallback then produced a path that could not
/// be stored, the INSERT aborted on the trigger, and `apply_add_attachment_tx`
/// propagated with `?` — one crafted op wedging the apply transaction on every
/// retry, which is exactly the reject-in-apply DoS coercion exists to avoid.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hostile_attachment_id_cannot_wedge_the_apply_path_3370() {
    let (pool, dir) = test_pool().await;

    // `C:X` survives `BlockId`'s non-ULID fallback verbatim and survives the
    // display-name sanitizer verbatim, so it reaches the path unchanged.
    let stored = apply_peer_add_attachment(&pool, "C:X", "notes.db").await;

    assert!(
        agaric_core::attachment_path::AttachmentFsPath::parse(&stored).is_ok(),
        "the coerced path {stored:?} must be one `parse` accepts — an apply that \
         stores a path the resolvers refuse is the failure this coercion exists \
         to prevent"
    );
    agaric_sync::sync_files::validate_attachment_fs_path(dir.path(), &stored)
        .expect("the coerced path must resolve");
}

/// #3370 review — Windows strips a trailing dot (and trailing spaces) from a
/// path component at create time, so a row spelled `attachments/photo.png.`
/// has its bytes land at `attachments\photo.png`. The GC walk then derives
/// `attachments/photo.png`, misses the stored string, and destroys the bytes —
/// the same membership-test failure as `attachments/./photo.png`, reached by a
/// spelling `parse` was still accepting verbatim.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_trailing_dot_spelling_keeps_its_bytes_through_a_gc_pass_3370() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();
    // Where the bytes land under the platform's own name folding, and where
    // the GC's directory walk will find them.
    let full = attachments.join("photo.png");
    tokio::fs::write(&full, b"bytes").await.unwrap();

    let stored = apply_peer_add_attachment(
        &pool,
        "01HZ3370000000000000000AT4",
        "attachments/photo.png.",
    )
    .await;
    assert_eq!(
        stored, "attachments/photo.png",
        "a trailing dot must be folded away before the row is written, or the \
         GC's walk-derived string cannot match it"
    );

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        full.exists(),
        "the GC destroyed the bytes of a live, referenced attachment because the \
         row carried a trailing-dot spelling (#3370 review)"
    );
}
