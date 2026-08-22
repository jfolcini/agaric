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
// #3325 — in-flight transfer temps live inside the GC's own walk root
// ============================================================================

/// A well-formed in-flight temp name for `storage_id`, matching what
/// `write_attachment_streaming` / `write_attachment_file` emit:
/// `<final name>.tmp-<32 lower-case hex>`.
fn transfer_temp_name(storage_id: &str, hex: &str) -> String {
    assert_eq!(hex.len(), 32, "the writers render a u128 as {{:032x}}");
    format!("{storage_id}.tmp-{hex}")
}

/// #3325 — a sync receive streaming into `attachments/<id>.tmp-<hex>` must
/// survive a GC pass that runs alongside it.
///
/// The temp is a sibling of the final path by necessity (the publishing
/// `rename` has to be same-filesystem), so it sits inside the walk root; and
/// it is unreferenced by construction, because the `attachments` row names the
/// final path and is only committed after the rename. Every check the pass
/// makes therefore votes "orphan". Unlinking it on Unix leaves the writer
/// filling an unreachable inode: the received bytes are discarded and
/// `TempAttachmentWriter::commit` fails, aborting the rest of the round.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_keeps_in_flight_transfer_temps_3325() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let temp = attachments.join(transfer_temp_name(
        "01JQ8ZC0DE5T0RAG31D",
        "0123456789abcdef0123456789abcdef",
    ));
    tokio::fs::write(&temp, b"first 5 MB frame of a large attachment")
        .await
        .unwrap();

    // A genuine orphan alongside it, so a pass that simply stopped working
    // could not make this test pass.
    let orphan = attachments.join("nobody-references-this.bin");
    tokio::fs::write(&orphan, b"junk").await.unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        temp.exists(),
        "#3325: the GC unlinked an in-flight transfer temp — the receiving \
         writer keeps filling an unreachable inode and its commit rename fails"
    );
    assert!(
        !orphan.exists(),
        "the temp exemption must not stop the GC collecting real orphans"
    );
}

/// #3325 companion — the exemption is an age gate, not an amnesty.
///
/// `TempAttachmentWriter::Drop` unlinks the temp on every ordinary exit path
/// but never on `SIGKILL` / OOM-kill / power loss, and nothing else on the
/// system reclaims one. A temp older than any live writer could hold is
/// therefore collected exactly like any other orphan.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_reclaims_abandoned_transfer_temps_3325() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let stranded = attachments.join(transfer_temp_name(
        "01JQ8ZC0DE5T0RAG31E",
        "fedcba9876543210fedcba9876543210",
    ));
    tokio::fs::write(&stranded, b"half a transfer, killed mid-flight")
        .await
        .unwrap();

    // Backdate it well past the reap threshold (20 × the 180 s RECV_TIMEOUT).
    let backdated = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
    std::fs::File::options()
        .write(true)
        .open(&stranded)
        .unwrap()
        .set_modified(backdated)
        .unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        !stranded.exists(),
        "a transfer temp older than any live writer must still be reclaimed, \
         or a process kill leaks it forever (#3325)"
    );
}

/// #3325 / #3519 — the exemption must be exact, not a loose `.tmp` test.
///
/// The GC's own quarantine files also end in `.tmp`, and #3519 relies on the
/// NEXT pass walking a quarantine file stranded by a crash or a failed restore
/// and reclaiming it as an orphan. Exempting it would turn that self-healing
/// property into a permanent leak.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_still_collects_stranded_quarantine_files_3325() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    // Freshly written, so only an exact name match can tell it apart from an
    // in-flight transfer temp.
    let stranded_quarantine = attachments.join(".agaric-gc-01JQ8ZC0DE5QUARANT1NE01.tmp");
    tokio::fs::write(&stranded_quarantine, b"bytes parked by a crashed pass")
        .await
        .unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    assert!(
        !stranded_quarantine.exists(),
        "#3519 depends on a stranded quarantine file being collected by the \
         next pass; the #3325 temp exemption must not swallow it"
    );
}

/// #3325 — a directory holding nothing but in-flight temps must still get its
/// dangling `attachment_blobs` rows pruned.
///
/// The temp exemption gave the "nothing to walk" early return a second
/// entrance, and that return used to sit *above* the #3371 bulk blob sweep. So
/// a vault mid-transfer would skip the one piece of work it still had — and
/// the sweep's whole purpose is rows whose `on_disk_path` is not on disk at
/// all, which is exactly the state an empty walk describes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_prunes_blobs_when_only_temps_are_present_3325() {
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    // The only file present is a receive in progress, so the walk yields no
    // candidates and the pass takes the early return.
    let temp = attachments.join(transfer_temp_name(
        "01JQ8ZC0DE5T0RAG31F",
        "abcdef0123456789abcdef0123456789",
    ));
    tokio::fs::write(&temp, b"streaming right now")
        .await
        .unwrap();

    // A blob mapping whose bytes are long gone and which no `attachments` row
    // references — dangling, and reclaimable only by the bulk sweep.
    sqlx::query(
        "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
         VALUES ('deadbeef', 'attachments/vanished.bin', 4, 1735689600000)",
    )
    .execute(&pool)
    .await
    .unwrap();

    super::super::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
        .await
        .unwrap();

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "#3325: the dangling blob row survived because a directory of only \
         in-flight temps took the early return above the bulk prune"
    );
    assert!(
        temp.exists(),
        "and the in-flight temp must still be there afterwards"
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

// ============================================================================
// #3706 — the GC pass and the undo stack, together
// ============================================================================
//
// Since #1993/#3259 a `delete_attachment` removes only the ROW: the file and
// the `attachment_blobs` mapping are left to `cleanup_orphaned_attachments`,
// which is the sole reclaimer of attachment bytes. So the ordinary lifetime of
// a deleted attachment is: row gone → sweep runs → bytes gone. If the user
// then hits undo, `reverse_delete_attachment` reconstructs the original
// `AddAttachment` payload from the op log and the reverse-apply re-inserts the
// row with that payload's `fs_path` — a live reference over bytes that no
// longer exist, with no blob row left that could repoint it. That is not a
// race; it is what happens every time once the sweep has run.
//
// The tests below pin both arms of the fix: after a sweep the undo must refuse
// rather than commit such a row, and WITHOUT a sweep it must still hand the
// user their file back exactly as before.

/// Bytes the fixture attaches. Distinct content so the no-GC arm can prove the
/// undo restored a readable file and not merely a row.
const UNDO_GC_BYTES: &[u8] = b"the attachment the user took back";

/// Vault state shared by the #3706 tests: one block, one attachment ingested
/// through the real command path (so the file, the `attachments` row, the
/// `attachment_blobs` mapping and the `add_attachment` op all exist), plus the
/// `op_log` ref of whichever op the test will reverse.
struct UndoGcFixture {
    pool: SqlitePool,
    _dir: TempDir,
    mat: Materializer,
    app_data_dir: PathBuf,
    attachment_id: String,
    /// Absolute path of the attachment's bytes.
    full_path: PathBuf,
}

impl UndoGcFixture {
    async fn new() -> Self {
        let (pool, dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let app_data_dir = dir.path().to_path_buf();
        // Attachment paths are app-data-relative; wiring the dir onto the
        // Materializer is what keeps every file this test touches inside the
        // TempDir rather than a real vault.
        mat.set_app_data_dir(app_data_dir.clone());

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('ATTUNDOBLK', 'content', 'holder')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let row = crate::commands::add_attachment_with_bytes_inner(
            &pool,
            DEV,
            &mat,
            &app_data_dir,
            BlockId::from_trusted("ATTUNDOBLK"),
            "photo.png".into(),
            "image/png".into(),
            UNDO_GC_BYTES.to_vec(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let full_path = app_data_dir.join(&row.fs_path);
        Self {
            pool,
            _dir: dir,
            mat,
            app_data_dir,
            attachment_id: row.id.as_str().to_owned(),
            full_path,
        }
    }

    /// Delete the attachment through the production command and return the
    /// `op_log` ref of the `delete_attachment` op it appended — the op the
    /// user's undo will target.
    async fn delete_attachment(&self) -> agaric_store::op::OpRef {
        crate::commands::delete_attachment_inner(
            &self.pool,
            DEV,
            &self.mat,
            &self.app_data_dir,
            BlockId::from_trusted(&self.attachment_id),
        )
        .await
        .unwrap();
        self.mat.flush_background().await.unwrap();
        self.latest_op_ref("delete_attachment").await
    }

    async fn latest_op_ref(&self, op_type: &str) -> agaric_store::op::OpRef {
        let (device_id, seq): (String, i64) = sqlx::query_as(
            "SELECT device_id, seq FROM op_log WHERE op_type = ? ORDER BY created_at DESC, seq DESC LIMIT 1",
        )
        .bind(op_type)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        agaric_store::op::OpRef { device_id, seq }
    }

    /// Run the ordinary sweep — the same function boot, the 24 h tick and the
    /// post-purge enqueue all call — and confirm it reclaimed the bytes. By
    /// every measure available to the GC the file IS an orphan at this point,
    /// so this is the correct outcome, not the bug.
    async fn run_gc(&self) {
        super::super::handlers::cleanup_orphaned_attachments(&self.pool, None, &self.app_data_dir)
            .await
            .unwrap();
        assert!(
            !self.full_path.exists(),
            "the GC pass must reclaim a deleted attachment's unreferenced bytes; \
             without that the #3706 sequence is not set up at all"
        );
    }

    /// The `fs_path` of the live `attachments` row for this attachment, if any.
    async fn live_row_fs_path(&self) -> Option<String> {
        sqlx::query_scalar("SELECT fs_path FROM attachments WHERE id = ?")
            .bind(&self.attachment_id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
    }

    async fn op_log_len(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

/// The central sequence: add → delete → GC → undo.
///
/// The invariant under test is that a restored row never points at bytes that
/// do not exist. Since nothing can bring the bytes back, honouring it here
/// means the undo refuses — and refuses cleanly: the transaction rolls back,
/// so no reverse op is appended and the delete stays undoable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_delete_attachment_after_gc_refuses_rather_than_restoring_a_dangling_row_3706() {
    let f = UndoGcFixture::new().await;
    let delete_ref = f.delete_attachment().await;
    f.run_gc().await;

    let ops_before = f.op_log_len().await;

    let err = crate::commands::undo_op_inner(&f.pool, DEV, &f.mat, delete_ref)
        .await
        .expect_err(
            "undoing a delete_attachment whose bytes the GC has reclaimed must not \
             succeed — the row it would restore has nothing to point at (#3706)",
        );
    assert!(
        matches!(err, AppError::NonReversible { .. }),
        "the refusal must be classified as non-reversible (so a point-in-time \
         restore can skip the op rather than fail whole); got {err:?}"
    );

    assert_eq!(
        f.live_row_fs_path().await,
        None,
        "undo re-inserted an attachments row over bytes the GC destroyed — on a \
         single-device vault that attachment is unrecoverable (#3706)"
    );
    assert_eq!(
        f.op_log_len().await,
        ops_before,
        "the refused undo must roll its whole transaction back — an appended \
         reverse op with no applied effect would leave the delete looking undone"
    );

    f.mat.shutdown();
}

/// The symmetric arm: add → delete → undo, with no sweep in between.
///
/// The bytes are still on disk, so the undo must behave exactly as it always
/// did — the row comes back AND the file is readable through it. This is where
/// a heavy-handed fix (refusing every attachment undo, or making the GC the
/// only thing that may touch these bytes) would show up as a regression.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_delete_attachment_without_a_gc_pass_still_restores_the_attachment_3706() {
    let f = UndoGcFixture::new().await;
    let delete_ref = f.delete_attachment().await;

    let result = crate::commands::undo_op_inner(&f.pool, DEV, &f.mat, delete_ref)
        .await
        .expect("undo of a delete_attachment whose bytes are still on disk must succeed");
    assert_eq!(
        result.new_op_type, "add_attachment",
        "reversing delete_attachment must produce an add_attachment reverse op"
    );
    f.mat.flush_background().await.unwrap();

    let bytes = crate::commands::read_attachment_inner(
        &f.pool,
        &f.app_data_dir,
        BlockId::from_trusted(&f.attachment_id),
    )
    .await
    .expect("the restored row must resolve to a file that can actually be read");
    assert_eq!(
        bytes, UNDO_GC_BYTES,
        "an ordinary undo must give the user back the exact file they deleted"
    );

    f.mat.shutdown();
}

/// The false-refusal the guard is most likely to produce in a real vault, and
/// the reason it stats the FILE rather than consulting `attachment_blobs`.
///
/// #1993's content-addressed dedup points many `attachments` rows at ONE
/// on-disk file. Deleting one of them leaves the file alive — a sibling row
/// still references it, so the GC's membership test keeps it through every
/// sweep. Undoing that delete must therefore still succeed: the bytes never
/// went anywhere.
///
/// A guard keyed on "does an `attachment_blobs` row / a live row for THIS
/// attachment still exist?" would refuse here and destroy an undo that has
/// always worked. Nothing else in the suite pins that distinction.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_delete_attachment_succeeds_while_a_deduped_sibling_holds_the_bytes_3706() {
    let f = UndoGcFixture::new().await;

    // Same bytes → `persist_attachment` reuses the existing blob and points
    // the sibling row at the SAME `fs_path`.
    let sibling = crate::commands::add_attachment_with_bytes_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.app_data_dir,
        BlockId::from_trusted("ATTUNDOBLK"),
        "copy.png".into(),
        "image/png".into(),
        UNDO_GC_BYTES.to_vec(),
    )
    .await
    .unwrap();
    f.mat.flush_background().await.unwrap();
    assert_eq!(
        f.app_data_dir.join(&sibling.fs_path),
        f.full_path,
        "the fixture depends on #1993 dedup pointing both rows at one file; \
         without that this test is not exercising the shared-blob case at all"
    );

    let delete_ref = f.delete_attachment().await;

    // The sweep must KEEP the bytes — the sibling row still names them.
    super::super::handlers::cleanup_orphaned_attachments(&f.pool, None, &f.app_data_dir)
        .await
        .unwrap();
    assert!(
        f.full_path.exists(),
        "the GC must not reclaim a file a live sibling row still references"
    );

    crate::commands::undo_op_inner(&f.pool, DEV, &f.mat, delete_ref)
        .await
        .expect(
            "undoing a delete_attachment whose bytes a deduped sibling kept alive must \
             still succeed — the #3706 guard checks the file, not the attachment's own \
             blob bookkeeping",
        );
    f.mat.flush_background().await.unwrap();

    let bytes = crate::commands::read_attachment_inner(
        &f.pool,
        &f.app_data_dir,
        BlockId::from_trusted(&f.attachment_id),
    )
    .await
    .expect("the restored row must resolve to a readable file");
    assert_eq!(bytes, UNDO_GC_BYTES);

    f.mat.shutdown();
}

/// The same hazard reached from the other direction, and through the other
/// guard: add → undo (the row is hard-deleted, bytes deferred to the GC) →
/// GC → redo. `redo_page_op_inner` does not go through `revert_ops_in_tx`'s
/// preflight, so this is the path the check inside `apply_reverse_in_tx`
/// exists for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redo_of_an_undone_add_attachment_after_a_gc_pass_refuses_3706() {
    let f = UndoGcFixture::new().await;
    let add_ref = f.latest_op_ref("add_attachment").await;

    // Undo the add: the reverse hard-deletes the row and, like every other
    // delete since #3259, leaves the bytes for the sweep.
    let undo = crate::commands::undo_op_inner(&f.pool, DEV, &f.mat, add_ref)
        .await
        .expect("undo of add_attachment must succeed");
    f.mat.flush_background().await.unwrap();
    f.run_gc().await;

    let ops_before = f.op_log_len().await;

    let err = crate::commands::redo_page_op_inner(
        &f.pool,
        DEV,
        &f.mat,
        undo.new_op_ref.device_id.clone(),
        undo.new_op_ref.seq,
    )
    .await
    .expect_err(
        "redoing an undone add_attachment after the sweep must not resurrect the \
         row either — the bytes are just as gone (#3706)",
    );
    assert!(
        matches!(err, AppError::NonReversible { .. }),
        "expected a non-reversible classification; got {err:?}"
    );
    assert_eq!(
        f.live_row_fs_path().await,
        None,
        "redo re-inserted an attachments row over bytes the GC destroyed (#3706)"
    );
    // Op-log rollback is MORE load-bearing here than on the undo path:
    // `redo_page_op_inner` appends the redo op BEFORE calling
    // `apply_reverse_in_tx`, so between those two statements the log already
    // holds an `add_attachment` op whose effect was never applied. Only the
    // transaction rollback removes it. Were it to survive, the redo stack
    // would read as "the add is back" while no row exists — and a later
    // undo of that phantom op would try to delete a row that was never
    // restored. Falsified: with the error path made to commit instead of
    // roll back, this is the assertion that fails.
    assert_eq!(
        f.op_log_len().await,
        ops_before,
        "the refused redo appended its reverse op BEFORE applying it, so the \
         rollback is what keeps a never-applied add_attachment out of the log"
    );

    f.mat.shutdown();
}

/// Batch blast radius (#3706 review): one byte-less `delete_attachment` in an
/// `undo_ops` / `undo_page_group` / `revert_ops` batch aborts the WHOLE batch,
/// and the reverses already applied ahead of it are rolled back with it.
///
/// That is the historical interactive contract (`skip_non_reversible = false`)
/// and matches the `MoveBlock` precedent, but every other #3706 test drives a
/// single op, so nothing pinned what a batch does. The UX of the all-or-nothing
/// choice is #4249; this test pins the mechanics.
///
/// The batch is ordered so the refusal is NOT the first op processed —
/// `revert_ops_in_tx` applies reverses newest-first, so the newer op's reverse
/// is appended and applied before the older `delete_attachment` is even
/// preflighted. A rollback that did not reach it would leave exactly the
/// partial application this asserts against.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_undo_containing_a_byte_less_delete_attachment_aborts_the_whole_batch_3706() {
    let f = UndoGcFixture::new().await;
    let delete_ref = f.delete_attachment().await;
    f.run_gc().await;

    // A LATER op whose reverse is perfectly applicable: a second attachment
    // with different bytes, so it owns its own file and shares nothing with
    // the reclaimed one.
    let sibling = crate::commands::add_attachment_with_bytes_inner(
        &f.pool,
        DEV,
        &f.mat,
        &f.app_data_dir,
        BlockId::from_trusted("ATTUNDOBLK"),
        "notes.txt".into(),
        "text/plain".into(),
        b"a second attachment, untouched by any of this".to_vec(),
    )
    .await
    .unwrap();
    f.mat.flush_background().await.unwrap();
    let sibling_add_ref = f.latest_op_ref("add_attachment").await;
    let sibling_file = f.app_data_dir.join(&sibling.fs_path);

    let ops_before = f.op_log_len().await;

    let err =
        crate::commands::undo_ops_inner(&f.pool, DEV, &f.mat, vec![sibling_add_ref, delete_ref])
            .await
            .expect_err(
                "a batch containing a delete_attachment whose bytes are gone must fail \
         the whole batch, not silently drop that one op (#3706)",
            );
    assert!(
        matches!(err, AppError::NonReversible { .. }),
        "the whole-batch failure must carry the same non-reversible \
         classification the single-op path does; got {err:?}"
    );

    // Nothing applied: the sibling's reverse ran first inside the transaction
    // and must have been rolled back with it.
    let sibling_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = ?")
        .bind(sibling.id.as_str())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        sibling_rows, 1,
        "the aborted batch left the sibling attachment undone — a partial batch \
         undo is exactly what the all-or-nothing contract forbids"
    );
    assert!(
        sibling_file.exists(),
        "the aborted batch must not have disturbed the sibling's bytes either"
    );
    assert_eq!(
        f.live_row_fs_path().await,
        None,
        "the refused delete_attachment must not have restored its row"
    );
    // Nothing appended: `revert_ops_in_tx` appends each reverse op as it goes,
    // so the sibling's reverse was already in the log when the refusal hit.
    assert_eq!(
        f.op_log_len().await,
        ops_before,
        "the aborted batch must leave the op log untouched — a surviving reverse \
         op would make the sibling look undone in the history feed"
    );

    f.mat.shutdown();
}

/// The false refusal that a guard keyed on the ORIGINAL `add_attachment`
/// payload produces, and the reason the reverse now adopts the path the row
/// held **at delete time** (#3706 review).
///
/// Three production paths repoint a live `attachments` row onto a shared
/// content-addressed blob — `recovery::attachment_blob_backfill`,
/// `sync_files::maybe_link_local_blob`, and the `FileOffer` skip path — after
/// which the row's ORIGINAL path is referenced by nothing and the ordinary
/// sweep reclaims it, while the bytes stay alive under the blob. Reconstructing
/// the undo from the original payload then names a file that is gone: it would
/// refuse an undo whose bytes are right there (and, before the guard existed,
/// restore a row pointing at the reclaimed path instead of the live one).
///
/// `DeleteAttachmentPayload::fs_path` is captured from the LIVE row inside the
/// delete's own transaction, so it is the post-repoint value by construction.
/// Both halves matter and are asserted here: the undo must SUCCEED, and the
/// restored row must NAME the blob — checking one path while storing the other
/// would pass a guard and still commit a dangling row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_delete_attachment_restores_the_path_the_row_held_at_delete_time_3706() {
    let f = UndoGcFixture::new().await;

    // Repoint the live row onto a shared blob file — the same
    // `UPDATE attachments SET fs_path = ? WHERE id = ?` all three production
    // repointers issue.
    const BLOB_PATH: &str = "attachments/SHAREDBLOB.png";
    let blob_full = f.app_data_dir.join(BLOB_PATH);
    tokio::fs::write(&blob_full, UNDO_GC_BYTES).await.unwrap();
    sqlx::query("UPDATE attachments SET fs_path = ? WHERE id = ?")
        .bind(BLOB_PATH)
        .bind(&f.attachment_id)
        .execute(&f.pool)
        .await
        .unwrap();

    // Nothing references the original path any more, so the ordinary sweep
    // reclaims it. This is the GC behaving correctly — the file IS an orphan.
    super::super::handlers::cleanup_orphaned_attachments(&f.pool, None, &f.app_data_dir)
        .await
        .unwrap();
    assert!(
        !f.full_path.exists(),
        "the sweep must reclaim the path the repoint orphaned; without that this \
         test is not exercising the stale-original-path case at all"
    );
    assert!(
        blob_full.exists(),
        "the sweep must keep the blob the live row now references"
    );

    let delete_ref = f.delete_attachment().await;

    crate::commands::undo_op_inner(&f.pool, DEV, &f.mat, delete_ref)
        .await
        .expect(
            "undoing a delete_attachment whose bytes are present at the path the row \
             held when it was deleted must succeed — refusing here is a false refusal \
             over a file that never went anywhere (#3706 review)",
        );
    f.mat.flush_background().await.unwrap();

    assert_eq!(
        f.live_row_fs_path().await.as_deref(),
        Some(BLOB_PATH),
        "the restored row must name the path the row held at DELETE time, not the \
         one it was created with — otherwise the guard passes on bytes that exist \
         while the row is written pointing at the reclaimed path"
    );
    let bytes = crate::commands::read_attachment_inner(
        &f.pool,
        &f.app_data_dir,
        BlockId::from_trusted(&f.attachment_id),
    )
    .await
    .expect("the restored row must resolve to a file that can actually be read");
    assert_eq!(
        bytes, UNDO_GC_BYTES,
        "the restored attachment must be the user's file, byte for byte"
    );

    f.mat.shutdown();
}
