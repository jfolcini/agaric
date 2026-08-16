//! #3310 / #3998 — neither wholesale `op_log` wipe may restart the device's
//! `seq` allocator at 1.
//!
//! `op_log`'s identity is `PRIMARY KEY (device_id, seq)` with no epoch
//! column, and a peer's audit ingest is `INSERT OR IGNORE` on that composite
//! PK. So a device that re-issues `seq = 1, 2, 3 …` after its log was emptied
//! is not merely renumbering itself — it is minting addresses a paired peer
//! already holds for OTHER ops, and every such op is silently swallowed on
//! delivery. Each test below therefore asserts the harm end-to-end (the op
//! lands on a second, "peer" database) rather than only the seq number.
//!
//! The two wipes are tested as a PAIR on purpose: the floor-clause fix
//! sketched in #3310 (`AND seq < ?3` on `prune`'s DELETE) would pass
//! [`prune_to_empty_does_not_restart_seq`] while leaving
//! [`truncate_does_not_restart_seq`] — the RESET path, whose only production
//! caller is a live paired-peer catch-up — red.

use super::*;

/// A second vault standing in for the paired peer that holds this device's
/// ops as `is_replicated = 1` audit records.
///
/// Returns what the audit ingest returns: `true` when the record actually
/// landed, `false` when `INSERT OR IGNORE` treated it as a duplicate
/// delivery at an address the peer already holds — i.e. the op is dropped,
/// silently and permanently.
async fn peer_ingest(peer_pool: &SqlitePool, record: &OpRecord) -> bool {
    // allow-raw-tx: test-only peer stand-in
    let mut tx = peer_pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let inserted = ingest_remote_op_in_tx(&mut tx, record, "user", true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    inserted
}

/// Append `count` ops for `device_id` at `created_at`, mirroring each one
/// into the peer's audit copy. Panics if the peer rejects any of them (they
/// are its first sight of these addresses).
async fn author_and_replicate(
    pool: &SqlitePool,
    peer: &SqlitePool,
    device_id: &str,
    tags: &[&str],
    created_at: i64,
) -> Vec<OpRecord> {
    let mut records = Vec::new();
    for tag in tags {
        let record = append_local_op_at(pool, device_id, make_create_payload(tag), created_at)
            .await
            .unwrap();
        assert!(
            peer_ingest(peer, &record).await,
            "precondition: the peer must accept {device_id}'s pre-wipe op at seq {}",
            record.seq
        );
        records.push(record);
    }
    records
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!: i64" FROM op_log"#)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn high_water_of(pool: &SqlitePool, device_id: &str) -> Option<i64> {
    let mut conn = pool.acquire().await.unwrap();
    read_high_water(&mut conn, device_id).await.unwrap()
}

// ── #3310: the compaction (`prune`) path ────────────────────────────────

/// A vault whose newest op predates the retention window is pruned to ZERO
/// rows — the cutoff is newer than every op and the frontier covers all of
/// them, so neither of `prune`'s two bounds stops it. The next edit must
/// still get a fresh address.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prune_to_empty_does_not_restart_seq() {
    let (pool, _dir) = test_pool().await;
    let (peer, _peer_dir) = test_pool().await;

    let pre = author_and_replicate(
        &pool,
        &peer,
        TEST_DEVICE,
        &["BLK-HW-1", "BLK-HW-2", "BLK-HW-3"],
        FIXED_TS,
    )
    .await;
    assert_eq!(
        pre.iter().map(|r| r.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "precondition: the genesis history occupies seqs 1..=3"
    );

    // Compaction: cutoff one ms after the newest op, frontier = MAX(seq).
    // allow-raw-tx: test drives the prune directly
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let deleted = super::prune(&mut tx, FIXED_TS + 1, TEST_DEVICE, 3)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        deleted, 3,
        "precondition: every op is older than the cutoff"
    );
    assert_eq!(
        op_count(&pool).await,
        0,
        "precondition: the prune must have emptied the log"
    );

    let post = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-HW-4"),
        FIXED_TS + 2,
    )
    .await
    .unwrap();

    // The harm first, then the mechanism that causes it.
    assert!(
        peer_ingest(&peer, &post).await,
        "THE HARM: the post-compaction op must land on the peer. At a reused \
         address the peer's INSERT OR IGNORE swallows it as a duplicate \
         delivery and this device's post-compaction history never replicates."
    );
    assert_eq!(
        post.seq, 4,
        "the allocator must continue from the pre-compaction frontier, not restart at 1"
    );
    assert!(
        post.parent_seqs.is_some(),
        "a post-compaction op is not the device's genesis op; restarting at seq 1 \
         would also re-declare it parentless"
    );
    assert_eq!(
        high_water_of(&pool, TEST_DEVICE).await,
        Some(3),
        "prune must record the pre-delete frontier as the durable floor"
    );
}

/// The bounded (normal) compaction is unchanged: rows above the frontier
/// survive and the allocator still follows them. Guards against the fix
/// perturbing the common case or introducing an off-by-one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_prune_leaves_the_allocator_unchanged() {
    let (pool, _dir) = test_pool().await;
    let (peer, _peer_dir) = test_pool().await;

    author_and_replicate(
        &pool,
        &peer,
        TEST_DEVICE,
        &["BLK-PP-1", "BLK-PP-2", "BLK-PP-3"],
        FIXED_TS,
    )
    .await;

    // allow-raw-tx: test drives the prune directly
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let deleted = super::prune(&mut tx, FIXED_TS + 1, TEST_DEVICE, 2)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(deleted, 2, "only the two ops at or below the frontier go");
    assert_eq!(op_count(&pool).await, 1, "the seq-3 op survives");

    let post = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-PP-4"),
        FIXED_TS + 2,
    )
    .await
    .unwrap();
    assert_eq!(post.seq, 4, "a bounded prune must not shift the allocator");
}

/// The mark is monotone across repeated wipes: a second compaction that
/// starts from a SHORTER surviving history must not lower the floor the
/// first one established.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_prunes_keep_the_high_water_monotone() {
    let (pool, _dir) = test_pool().await;
    let (peer, _peer_dir) = test_pool().await;

    author_and_replicate(
        &pool,
        &peer,
        TEST_DEVICE,
        &["BLK-RP-1", "BLK-RP-2", "BLK-RP-3"],
        FIXED_TS,
    )
    .await;

    // allow-raw-tx: test drives the prune directly
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    super::prune(&mut tx, FIXED_TS + 1, TEST_DEVICE, 3)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let fourth = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-RP-4"),
        FIXED_TS + 2,
    )
    .await
    .unwrap();
    assert!(
        peer_ingest(&peer, &fourth).await,
        "THE HARM: the op authored after the FIRST compaction must land on the peer"
    );
    assert_eq!(fourth.seq, 4);

    // Second compaction, again to zero rows.
    // allow-raw-tx: test drives the prune directly
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    super::prune(&mut tx, FIXED_TS + 3, TEST_DEVICE, 4)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(op_count(&pool).await, 0);

    let fifth = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-RP-5"),
        FIXED_TS + 4,
    )
    .await
    .unwrap();
    assert!(
        peer_ingest(&peer, &fifth).await,
        "THE HARM: the op authored after the SECOND compaction must also land \
         on the peer"
    );
    assert_eq!(
        fifth.seq, 5,
        "the second wipe must raise the floor to 4, not reset it"
    );
    assert_eq!(high_water_of(&pool, TEST_DEVICE).await, Some(4));
}

// ── #3998: the snapshot-RESET (`truncate`) path ─────────────────────────

/// The RESET path. `apply_snapshot` wipes `op_log` wholesale; its only
/// production caller is a live paired-peer snapshot catch-up, so the peer
/// demonstrably holds this device's pre-RESET ops — the aliasing is
/// reachable by construction, not hypothetically.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn truncate_does_not_restart_seq() {
    let (pool, _dir) = test_pool().await;
    let (peer, _peer_dir) = test_pool().await;

    let pre = author_and_replicate(
        &pool,
        &peer,
        TEST_DEVICE,
        &["BLK-TR-1", "BLK-TR-2", "BLK-TR-3"],
        FIXED_TS,
    )
    .await;
    assert_eq!(pre.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2, 3]);

    // The RESET wipe, exactly as `apply_snapshot` performs it.
    // allow-raw-tx: test drives the truncate directly
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    super::truncate(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        op_count(&pool).await,
        0,
        "precondition: the RESET empties the log"
    );

    let post = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-TR-4"),
        FIXED_TS + 2,
    )
    .await
    .unwrap();

    // The harm first, then the mechanism that causes it.
    assert!(
        peer_ingest(&peer, &post).await,
        "THE HARM: at a reused address the peer's INSERT OR IGNORE swallows \
         this device's post-RESET history — silently and permanently, since \
         the frontier the peer advertises for it already sits above 1."
    );
    assert_eq!(
        post.seq, 4,
        "the allocator must continue from the pre-RESET frontier, not restart at 1"
    );
    assert!(
        post.parent_seqs.is_some(),
        "a post-RESET op is not the device's genesis op"
    );
    assert_eq!(
        high_water_of(&pool, TEST_DEVICE).await,
        Some(3),
        "truncate must record the pre-delete frontier as the durable floor"
    );
}

/// `truncate` is unbounded — it drops every device's rows, including the
/// audit rows of peers — so it must record a mark per device, not just for
/// whichever one happens to be first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn truncate_records_a_mark_for_every_device() {
    let (pool, _dir) = test_pool().await;
    const OTHER_DEVICE: &str = "other-device";

    for tag in ["BLK-MD-A1", "BLK-MD-A2"] {
        append_local_op_at(&pool, TEST_DEVICE, make_create_payload(tag), FIXED_TS)
            .await
            .unwrap();
    }
    for tag in ["BLK-MD-B1", "BLK-MD-B2", "BLK-MD-B3"] {
        append_local_op_at(&pool, OTHER_DEVICE, make_create_payload(tag), FIXED_TS)
            .await
            .unwrap();
    }

    // allow-raw-tx: test drives the truncate directly
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    super::truncate(&mut tx).await.unwrap();
    tx.commit().await.unwrap();

    assert_eq!(high_water_of(&pool, TEST_DEVICE).await, Some(2));
    assert_eq!(high_water_of(&pool, OTHER_DEVICE).await, Some(3));

    let a = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-MD-A3"),
        FIXED_TS + 1,
    )
    .await
    .unwrap();
    let b = append_local_op_at(
        &pool,
        OTHER_DEVICE,
        make_create_payload("BLK-MD-B4"),
        FIXED_TS + 1,
    )
    .await
    .unwrap();
    assert_eq!(a.seq, 3, "each device resumes from its OWN frontier");
    assert_eq!(b.seq, 4, "each device resumes from its OWN frontier");
}

// ── The mark itself ─────────────────────────────────────────────────────

/// A vault that has never been wiped carries no mark, and the allocator is
/// then exactly the pre-#3310 `MAX(seq) + 1` — upgrading must not perturb a
/// healthy device.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_mark_leaves_the_allocator_at_max_seq_plus_one() {
    let (pool, _dir) = test_pool().await;

    assert_eq!(
        high_water_of(&pool, TEST_DEVICE).await,
        None,
        "no wipe has happened, so no mark exists"
    );
    let first = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-FR-1"),
        FIXED_TS,
    )
    .await
    .unwrap();
    assert_eq!(first.seq, 1);
    assert!(
        first.parent_seqs.is_none(),
        "the genuine genesis op is still parentless"
    );

    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(
        next_seq_for_device(&mut conn, TEST_DEVICE).await.unwrap(),
        2
    );
}

/// The key is namespaced per device so two devices cannot share a floor.
#[test]
fn high_water_key_is_namespaced_per_device() {
    assert_eq!(high_water_key("dev-a"), "op_log.high_water.dev-a");
    assert_ne!(high_water_key("dev-a"), high_water_key("dev-b"));
}
