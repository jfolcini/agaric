use super::*;
use crate::db::{ReadPool, init_pool};
use crate::hash::compute_op_hash;
use crate::op_log::append_local_op_at;
use crate::ulid::BlockId;
use std::path::PathBuf;
use tempfile::TempDir;

// ── Test fixture constants ──────────────────────────────────────────

const FIXED_TS: i64 = 1_736_942_400_000;
const DEV_A: &str = "device-A";
const DEV_B: &str = "device-B";

/// Test-fixture constants for `find_lca_after_compaction_returns_clear_error`.
/// Extracted from inline SQL (TEST-26) to make schema/format changes easier
/// to track. Adjust here when the snapshot row schema or hash format changes.
const TEST_SNAPSHOT_ID: &str = "SNAP01";
const TEST_SNAPSHOT_HASH: &str = "fakehash";

// ── Helpers ─────────────────────────────────────────────────────────

/// Create a temp-file-backed SQLite pool with migrations applied.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Build a `CreateBlock` payload.
fn make_create(block_id: &str, content: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: content.into(),
    })
}

/// Build an `EditBlock` payload with a `prev_edit` pointer.
fn make_edit(block_id: &str, to_text: &str, prev_edit: Option<(String, i64)>) -> OpPayload {
    OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id(block_id),
        to_text: to_text.into(),
        prev_edit,
    })
}

/// Build a `DeleteBlock` payload.
fn make_delete(block_id: &str) -> OpPayload {
    OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::test_id(block_id),
    })
}

/// Build a valid remote `OpRecord` with a correct hash.
fn make_remote_record(
    device_id: &str,
    seq: i64,
    parent_seqs: Option<String>,
    op_type: &str,
    payload: &str,
) -> OpRecord {
    let hash = compute_op_hash(device_id, seq, parent_seqs.as_deref(), op_type, payload);
    // L-13: cache the parsed block_id on the sidecar (mirrors the
    // production `From<OpTransfer>` path).
    let block_id = crate::op_log::extract_block_id_from_payload(payload);
    OpRecord {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs,
        hash,
        op_type: op_type.to_owned(),
        payload: payload.to_owned(),
        created_at: FIXED_TS,
        block_id,
    }
}

// =====================================================================
// 1. insert_remote_op
// =====================================================================

#[tokio::test]
async fn insert_remote_op_happy_path() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );

    insert_remote_op(&pool, &record).await.unwrap();

    // Verify it landed in the DB
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.device_id, "remote-dev");
    assert_eq!(fetched.seq, 1);
    assert_eq!(fetched.hash, record.hash);
    assert_eq!(fetched.op_type, "create_block");
}

#[tokio::test]
async fn insert_remote_op_duplicate_is_ignored() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );

    // Insert twice — second should be silently ignored
    insert_remote_op(&pool, &record).await.unwrap();
    insert_remote_op(&pool, &record).await.unwrap();

    // Verify only one row exists
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.hash, record.hash);
}

/// #1572 — a second op at the SAME `(device_id, seq)` but with a
/// DIFFERENT hash (a fork, corruption, or device-id reuse) must be
/// REJECTED with an integrity error, not silently dropped as if it were
/// a benign idempotent re-delivery (which would return `Ok(false)`).
#[tokio::test]
async fn insert_remote_op_same_pk_different_hash_rejected() {
    let (pool, _dir) = test_pool().await;

    // First op lands cleanly.
    let first = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );
    insert_remote_op(&pool, &first).await.unwrap();

    // A diverging op at the SAME (device_id, seq) — different content
    // ⇒ different (still self-consistent) hash. This must NOT be treated
    // as a duplicate.
    let diverging = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"GOODBYE"}"#,
    );
    assert_ne!(
        first.hash, diverging.hash,
        "test fixture sanity: diverging op must have a different hash"
    );

    let err = insert_remote_op(&pool, &diverging).await;
    assert!(
        err.is_err(),
        "expected an integrity error on same-PK/different-hash, got Ok"
    );
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("divergence"),
        "expected op_log divergence error, got: {msg}"
    );

    // The original row must be untouched (the diverging content was rejected,
    // not written).
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.hash, first.hash);
}

#[tokio::test]
async fn insert_remote_op_hash_mismatch_rejected() {
    let (pool, _dir) = test_pool().await;

    let mut record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );
    // Tamper with the hash
    record.hash = "0".repeat(64);

    let err = insert_remote_op(&pool, &record).await;
    assert!(err.is_err());
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("hash mismatch"),
        "expected hash mismatch error, got: {msg}"
    );
}

/// #1600 — a remote op carrying a raw NUL byte in a hashed field must be
/// REJECTED gracefully with `AppError::InvalidOperation`, never panic.
///
/// The `\0` is the wire-format delimiter for the hash preimage
/// (`compute_op_hash`); a NUL inside a field makes the preimage
/// ambiguous. `compute_op_hash` enforces this only as a `debug_assert!`,
/// so the production ingest gate (`insert_remote_op`) must reject it
/// *before* hashing — otherwise a corrupt op would panic in release.
///
/// We build the `OpRecord` by hand (not via `make_remote_record`, which
/// would trip the same `debug_assert!` while computing the hash) so the
/// test drives the production-facing rejection on the foreground path.
#[tokio::test]
async fn insert_remote_op_rejects_null_byte_in_device_id() {
    let (pool, _dir) = test_pool().await;
    let record = OpRecord {
        device_id: "remote\0dev".to_owned(),
        seq: 1,
        parent_seqs: None,
        hash: "0".repeat(64),
        op_type: "create_block".to_owned(),
        payload: r#"{"block_id":"B1"}"#.to_owned(),
        created_at: FIXED_TS,
        block_id: None,
    };

    let err = insert_remote_op(&pool, &record).await;
    assert!(
        matches!(err, Err(AppError::InvalidOperation(_))),
        "NUL byte in device_id must be rejected with InvalidOperation, got: {err:?}"
    );
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("null byte"),
        "expected null-byte rejection, got: {msg}"
    );

    // Confirm nothing landed.
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote\0dev", 1).await;
    assert!(
        matches!(fetched, Err(AppError::NotFound(_))),
        "rejected op must not land in op_log"
    );
}

/// #1600 — NUL byte anywhere in the four hashed fields is rejected.
#[tokio::test]
async fn insert_remote_op_rejects_null_byte_in_each_field() {
    let (pool, _dir) = test_pool().await;

    // (field-under-test, record builder) — each carries exactly one NUL.
    let cases: Vec<(&str, OpRecord)> = vec![
        (
            "parent_seqs",
            OpRecord {
                device_id: "remote-dev".to_owned(),
                seq: 2,
                parent_seqs: Some("[[\"a\",1]]\0".to_owned()),
                hash: "0".repeat(64),
                op_type: "edit_block".to_owned(),
                payload: r#"{"block_id":"B1"}"#.to_owned(),
                created_at: FIXED_TS,
                block_id: None,
            },
        ),
        (
            "op_type",
            OpRecord {
                device_id: "remote-dev".to_owned(),
                seq: 3,
                parent_seqs: None,
                hash: "0".repeat(64),
                op_type: "create\0block".to_owned(),
                payload: r#"{"block_id":"B1"}"#.to_owned(),
                created_at: FIXED_TS,
                block_id: None,
            },
        ),
        (
            "payload",
            OpRecord {
                device_id: "remote-dev".to_owned(),
                seq: 4,
                parent_seqs: None,
                hash: "0".repeat(64),
                op_type: "create_block".to_owned(),
                payload: "{\"block_id\":\"B1\0\"}".to_owned(),
                created_at: FIXED_TS,
                block_id: None,
            },
        ),
    ];

    for (field, record) in cases {
        let err = insert_remote_op(&pool, &record).await;
        assert!(
            matches!(err, Err(AppError::InvalidOperation(_))),
            "NUL byte in {field} must be rejected with InvalidOperation, got: {err:?}"
        );
        assert!(
            err.unwrap_err().to_string().contains("null byte"),
            "expected null-byte rejection for {field}"
        );
    }
}

/// #1600 — a NUL-byte-free op with a correct hash still verifies and
/// lands. Guards against the rejection gate accidentally tripping on
/// valid content. Pairs with the `compute_op_hash` known-vector
/// regression in `hash.rs` confirming the hash value is unchanged.
#[tokio::test]
async fn insert_remote_op_accepts_clean_op_after_null_byte_gate() {
    let (pool, _dir) = test_pool().await;
    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"clean"}"#,
    );
    insert_remote_op(&pool, &record).await.unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.hash, record.hash);
}

#[tokio::test]
async fn insert_remote_op_with_parent_seqs() {
    let (pool, _dir) = test_pool().await;

    // First insert the genesis op
    let r1 = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v1"}"#,
    );
    insert_remote_op(&pool, &r1).await.unwrap();

    // Then insert an op that references the first as parent
    let parent_seqs = Some(r#"[["remote-dev",1]]"#.to_owned());
    let r2 = make_remote_record(
        "remote-dev",
        2,
        parent_seqs.clone(),
        "edit_block",
        r#"{"block_id":"B1","to_text":"v2","prev_edit":["remote-dev",1]}"#,
    );
    insert_remote_op(&pool, &r2).await.unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 2)
        .await
        .unwrap();
    assert_eq!(fetched.parent_seqs, parent_seqs);
}

/// #1552 — `parse_parent_seqs_canonical` re-sorts the parsed `Vec` into the
/// writer's canonical lexicographic order regardless of the on-disk byte
/// order, and leaves an already-canonical array untouched.
///
/// A peer running older/bugged writer code can land a hash-valid but
/// non-canonically-ordered `parent_seqs` array (the hash is recomputed over
/// the stored string, so any self-consistent ordering verifies). Readers
/// must not inherit that ordering — they canonicalize on read.
#[test]
fn parse_parent_seqs_canonical_sorts_non_canonical_order() {
    // Stored bytes are NON-canonical: device-B before device-A.
    let non_canonical = r#"[["device-B",2],["device-A",1]]"#;
    let parsed = parse_parent_seqs_canonical(non_canonical).unwrap();
    assert_eq!(
        parsed,
        vec![("device-A".to_owned(), 1), ("device-B".to_owned(), 2)],
        "non-canonical stored order must be re-sorted to canonical order on read"
    );

    // Already-canonical input round-trips unchanged.
    let canonical = r#"[["device-A",1],["device-B",2]]"#;
    let parsed_canonical = parse_parent_seqs_canonical(canonical).unwrap();
    assert_eq!(
        parsed_canonical,
        vec![("device-A".to_owned(), 1), ("device-B".to_owned(), 2)],
        "already-canonical input must be unchanged"
    );

    // Both orderings canonicalize to the same Vec — the read-side invariant.
    assert_eq!(parsed, parsed_canonical);
}

/// #1552 — a remote merge op whose `parent_seqs` is hash-valid but stored
/// in NON-canonical order lands successfully (its stored bytes are preserved
/// verbatim so the hash stays valid), yet canonicalizing the fetched row on
/// read yields the writer's canonical order. Proves storage is left
/// untouched while readers see a deterministic ordering.
#[tokio::test]
async fn insert_remote_op_preserves_bytes_but_canonicalizes_on_read() {
    let (pool, _dir) = test_pool().await;

    // Land two genesis parents so the existence check resolves.
    let pa = make_remote_record(
        DEV_A,
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"a"}"#,
    );
    let pb = make_remote_record(
        DEV_B,
        2,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"b"}"#,
    );
    insert_remote_op(&pool, &pa).await.unwrap();
    insert_remote_op(&pool, &pb).await.unwrap();

    // A merge op with parent_seqs stored in NON-canonical order (B before A).
    // make_remote_record hashes over this exact string, so the row is
    // hash-valid despite the non-canonical ordering.
    let non_canonical = r#"[["device-B",2],["device-A",1]]"#.to_owned();
    let merge = make_remote_record(
        DEV_A,
        2,
        Some(non_canonical.clone()),
        "edit_block",
        r#"{"block_id":"B1","to_text":"merge","prev_edit":["device-A",1]}"#,
    );
    insert_remote_op(&pool, &merge).await.unwrap();

    // The stored bytes are preserved verbatim — re-sorting them would have
    // broken the hash chain.
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), DEV_A, 2)
        .await
        .unwrap();
    assert_eq!(
        fetched.parent_seqs,
        Some(non_canonical),
        "stored parent_seqs bytes must be preserved verbatim (hash validity)"
    );

    // But canonicalizing on read yields the writer's canonical order.
    let canonical = parse_parent_seqs_canonical(fetched.parent_seqs.as_deref().unwrap()).unwrap();
    assert_eq!(
        canonical,
        vec![(DEV_A.to_owned(), 1), (DEV_B.to_owned(), 2)],
        "reader must canonicalize the parsed parent_seqs to lexicographic order"
    );
}

/// M-5: an op whose `parent_seqs` references a `(device_id, seq)` that
/// has not yet landed in the op_log must be rejected with
/// `AppError::InvalidOperation("dag.parent_seqs.unresolved")`.
///
/// Without the check, the dangling parent silently lands on disk and
/// later DAG walks (`find_lca`, history reconstruction) surface as
/// inscrutable `NotFound` errors.  Fail fast on insert instead.
#[tokio::test]
async fn insert_remote_op_rejects_unresolved_parent_seqs() {
    let (pool, _dir) = test_pool().await;

    // No prior op exists — `(remote-dev, 99)` does not resolve.
    let parent_seqs = Some(r#"[["remote-dev",99]]"#.to_owned());
    let record = make_remote_record(
        "remote-dev",
        1,
        parent_seqs,
        "edit_block",
        r#"{"block_id":"B1","to_text":"orphan","prev_edit":["remote-dev",99]}"#,
    );

    let err = insert_remote_op(&pool, &record).await;
    assert!(
        err.is_err(),
        "op with unresolved parent_seqs must be rejected"
    );
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("dag.parent_seqs.unresolved"),
        "expected dag.parent_seqs.unresolved error, got: {msg}"
    );

    // Confirm nothing was inserted.
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1).await;
    assert!(
        matches!(fetched, Err(AppError::NotFound(_))),
        "rejected op must not land in op_log"
    );
}

/// M-5: an op whose `parent_seqs` lists multiple parents must reject
/// when *any* parent is unresolved, even if some parents do exist.
#[tokio::test]
async fn insert_remote_op_rejects_partial_unresolved_parent_seqs() {
    let (pool, _dir) = test_pool().await;

    // Land one parent into op_log.
    let r1 = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v1"}"#,
    );
    insert_remote_op(&pool, &r1).await.unwrap();

    // Reference both the resolved parent and a missing one.
    let parent_seqs = Some(r#"[["remote-dev",1],["other-dev",42]]"#.to_owned());
    let record = make_remote_record(
        "remote-dev",
        2,
        parent_seqs,
        "edit_block",
        r#"{"block_id":"B1","to_text":"merged","prev_edit":["remote-dev",1]}"#,
    );

    let err = insert_remote_op(&pool, &record).await;
    assert!(err.is_err(), "partial-unresolved must reject");
    assert!(
        err.unwrap_err()
            .to_string()
            .contains("dag.parent_seqs.unresolved")
    );
}

/// Issue #112 sub-item 3: the batched existence check (one query via
/// `(device_id, seq) IN (json_each(?))`) must still accept multi-parent
/// records when every entry resolves. Phase-1 has N=1 today, but this
/// pins the shape for phase-4 multi-parent merges.
#[tokio::test]
async fn insert_remote_op_accepts_multiple_resolved_parent_seqs() {
    let (pool, _dir) = test_pool().await;

    // Land two parents into op_log on two different remote devices.
    for (dev, seq, payload) in [
        (
            "remote-dev-a",
            1,
            r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"a"}"#,
        ),
        (
            "remote-dev-b",
            3,
            r#"{"block_id":"B2","block_type":"content","parent_id":null,"position":0,"content":"b"}"#,
        ),
    ] {
        let r = make_remote_record(dev, seq, None, "create_block", payload);
        insert_remote_op(&pool, &r).await.unwrap();
    }

    // Reference both parents in the new op's parent_seqs.
    let parent_seqs = Some(r#"[["remote-dev-a",1],["remote-dev-b",3]]"#.to_owned());
    let merger = make_remote_record(
        "remote-dev-c",
        1,
        parent_seqs.clone(),
        "edit_block",
        r#"{"block_id":"B1","to_text":"merged","prev_edit":["remote-dev-a",1]}"#,
    );
    insert_remote_op(&pool, &merger).await.unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev-c", 1)
        .await
        .unwrap();
    assert_eq!(fetched.parent_seqs, parent_seqs);
}

// =====================================================================
// 2. append_merge_op
// =====================================================================

#[tokio::test]
async fn append_merge_op_creates_multi_parent_op() {
    let (pool, _dir) = test_pool().await;

    // Set up some prior ops so the local device has a seq
    append_local_op_at(&pool, DEV_A, make_create("B1", "hello"), FIXED_TS)
        .await
        .unwrap();

    let merge_payload = make_edit("B1", "merged text", None);
    let parents = vec![(DEV_A.to_owned(), 1), (DEV_B.to_owned(), 3)];

    let record = append_merge_op(&pool, DEV_A, merge_payload, parents)
        .await
        .unwrap();

    // seq should be 2 (after the create at seq 1)
    assert_eq!(record.seq, 2);
    assert_eq!(record.device_id, DEV_A);
    assert_eq!(record.op_type, "edit_block");

    // parent_seqs should be sorted and contain both entries
    let parent_seqs = record.parsed_parent_seqs().unwrap().unwrap();
    assert_eq!(parent_seqs.len(), 2);
    // Sorted lexicographically: device-A < device-B
    assert_eq!(parent_seqs[0], (DEV_A.to_owned(), 1));
    assert_eq!(parent_seqs[1], (DEV_B.to_owned(), 3));
}

#[tokio::test]
async fn append_merge_op_sorts_parents_deterministically() {
    let (pool, _dir) = test_pool().await;

    let merge_payload = make_edit("B1", "merged", None);
    // Pass parents in reverse order
    let parents = vec![("zzz-device".to_owned(), 5), ("aaa-device".to_owned(), 10)];

    let record = append_merge_op(&pool, "local", merge_payload, parents)
        .await
        .unwrap();

    let parent_seqs = record.parsed_parent_seqs().unwrap().unwrap();
    // Must be sorted: aaa < zzz
    assert_eq!(parent_seqs[0].0, "aaa-device");
    assert_eq!(parent_seqs[1].0, "zzz-device");
}

#[tokio::test]
async fn append_merge_op_rejects_fewer_than_2_parents() {
    let (pool, _dir) = test_pool().await;

    let payload = make_edit("B1", "text", None);
    let err = append_merge_op(&pool, DEV_A, payload, vec![(DEV_A.to_owned(), 1)]).await;

    assert!(err.is_err());
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("at least 2"),
        "expected 'at least 2' error, got: {msg}"
    );
}

#[tokio::test]
async fn append_merge_op_rejects_empty_parents() {
    let (pool, _dir) = test_pool().await;

    let payload = make_edit("B1", "text", None);
    let err = append_merge_op(&pool, DEV_A, payload, vec![]).await;

    assert!(
        matches!(err, Err(AppError::InvalidOperation(_))),
        "append_merge_op with empty parents should return AppError::InvalidOperation, got {err:?}"
    );
}

// PEND-24 M5 — `append_merge_op` now dedups `parent_entries` after the
// canonical sort, before hashing, so a buggy caller that hands in
// duplicate `(device_id, seq)` pairs cannot construct an op with a
// degenerate parent set. The two tests below pin both halves of the
// fix: (1) duplicates collapse but the op is still well-formed when
// at least 2 distinct parents survive; (2) post-dedup count is
// re-validated, so an input that collapses below the 2-parent floor
// is rejected even if its pre-dedup `len()` looked legal.

#[tokio::test]
async fn append_merge_op_rejects_duplicate_parents() {
    let (pool, _dir) = test_pool().await;

    // A duplicate (A, 1) plus a distinct (B, 1) — three pre-dedup
    // entries collapse to two distinct ones. The op must still
    // succeed and its `parent_seqs` must contain exactly the two
    // distinct entries (sorted).
    let payload = make_edit("B1", "merged", None);
    let parents = vec![
        (DEV_A.to_owned(), 1),
        (DEV_A.to_owned(), 1),
        (DEV_B.to_owned(), 1),
    ];

    let record = append_merge_op(&pool, "local", payload, parents)
        .await
        .expect("dedup must keep the op valid when 2 distinct parents survive");

    let parent_seqs = record.parsed_parent_seqs().unwrap().unwrap();
    assert_eq!(
        parent_seqs.len(),
        2,
        "duplicate parent entries must collapse; got {parent_seqs:?}"
    );
    assert_eq!(
        parent_seqs[0],
        (DEV_A.to_owned(), 1),
        "first parent (sorted) should be device-A"
    );
    assert_eq!(
        parent_seqs[1],
        (DEV_B.to_owned(), 1),
        "second parent (sorted) should be device-B"
    );
}

#[tokio::test]
async fn append_merge_op_dedups_then_rejects_if_under_two() {
    let (pool, _dir) = test_pool().await;

    // Pre-dedup len = 2 (looks legal), post-dedup len = 1 — the
    // re-check after `sorted_parents.dedup()` must catch this.
    let payload = make_edit("B1", "text", None);
    let err = append_merge_op(
        &pool,
        DEV_A,
        payload,
        vec![(DEV_A.to_owned(), 1), (DEV_A.to_owned(), 1)],
    )
    .await;

    assert!(
        matches!(err, Err(AppError::InvalidOperation(_))),
        "duplicate-only parent_entries should collapse to <2 distinct \
         entries and fail with InvalidOperation; got {err:?}"
    );
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("at least 2"),
        "expected 'at least 2' error after dedup, got: {msg}"
    );
}

#[tokio::test]
async fn append_merge_op_hash_verifies() {
    let (pool, _dir) = test_pool().await;

    let payload = make_edit("B1", "merged", None);
    let parents = vec![(DEV_A.to_owned(), 1), (DEV_B.to_owned(), 2)];

    let record = append_merge_op(&pool, DEV_A, payload, parents)
        .await
        .unwrap();

    // Recompute hash and verify
    let recomputed = compute_op_hash(
        &record.device_id,
        record.seq,
        record.parent_seqs.as_deref(),
        &record.op_type,
        &record.payload,
    );
    assert_eq!(record.hash, recomputed);
}

/// `has_merge_for_heads` must do a *structural* membership test over
/// `parent_seqs`, not a substring scan. Regression guard for #1595: the
/// old `instr(parent_seqs, ?)` form was vulnerable to prefix/substring
/// false positives once identifiers stopped being JSON-safe UUIDs with a
/// single decimal `seq`. With parent `["dev",5]` present:
///   - (dev, 5)  → true  (exact structural match)
///   - (dev, 50) → false (seq `5` is a digit-prefix of `50`)
///   - (de,  5)  → false (device `de` is a prefix of `dev`)
#[tokio::test]
async fn has_merge_for_heads_is_structural_not_substring() {
    let (pool, _dir) = test_pool().await;

    // Merge op on block "B1" whose parent_seqs contains ["dev",5].
    // The second parent only satisfies append_merge_op's >=2-entries rule.
    let merge_payload = make_edit("B1", "merged", None);
    let parents = vec![("dev".to_owned(), 5), ("other".to_owned(), 9)];
    append_merge_op(&pool, DEV_A, merge_payload, parents)
        .await
        .unwrap();

    // Exact structural match → true.
    assert!(
        has_merge_for_heads(&pool, "B1", &("dev".to_owned(), 5))
            .await
            .unwrap(),
        "exact parent (dev, 5) must be found"
    );

    // seq 5 is a digit-prefix of 50 — the old instr() needle `[\"dev\",5]`
    // would NOT match `[\"dev\",50]`, but a needle for (dev, 50) here must
    // also be false because no such parent exists. The danger direction is
    // the reverse: ensure (dev, 5) does not match an op that only contains
    // (dev, 50). Verify both seq-substring directions are clean.
    assert!(
        !has_merge_for_heads(&pool, "B1", &("dev".to_owned(), 50))
            .await
            .unwrap(),
        "(dev, 50) must NOT match parent (dev, 5)"
    );

    // device `de` is a string-prefix of `dev` — a substring scan for the
    // tuple `[\"de\",5]` could be tricked by `[\"dev\",5...]` once device
    // ids are no longer fixed-width UUIDs. Structurally it must be false.
    assert!(
        !has_merge_for_heads(&pool, "B1", &("de".to_owned(), 5))
            .await
            .unwrap(),
        "device prefix (de, 5) must NOT match parent (dev, 5)"
    );

    // Sanity: a wholly absent head is false.
    assert!(
        !has_merge_for_heads(&pool, "B1", &("nope".to_owned(), 1))
            .await
            .unwrap(),
        "absent head must be false"
    );
}

/// Companion to the above covering the seq-substring direction where the
/// stored parent is the *longer* number: parent `["dev",50]` must not be
/// reported as a merge for head (dev, 5).
#[tokio::test]
async fn has_merge_for_heads_seq_is_not_substring_matched() {
    let (pool, _dir) = test_pool().await;

    let merge_payload = make_edit("B1", "merged", None);
    let parents = vec![("dev".to_owned(), 50), ("other".to_owned(), 9)];
    append_merge_op(&pool, DEV_A, merge_payload, parents)
        .await
        .unwrap();

    assert!(
        has_merge_for_heads(&pool, "B1", &("dev".to_owned(), 50))
            .await
            .unwrap(),
        "exact parent (dev, 50) must be found"
    );
    assert!(
        !has_merge_for_heads(&pool, "B1", &("dev".to_owned(), 5))
            .await
            .unwrap(),
        "(dev, 5) must NOT match parent (dev, 50) — no substring scan"
    );
}

// =====================================================================
// 3. find_lca
// =====================================================================

/// Two edits diverge from the same create.
///
/// ```text
/// (A,1) create_block B1
///   ├── (A,2) edit_block B1, prev_edit=(A,1)
///   └── (B,1) edit_block B1, prev_edit=(A,1)
/// ```
///
/// LCA of (A,2) and (B,1) should be (A,1).
#[tokio::test]
async fn find_lca_two_edits_diverge_from_create() {
    let (pool, _dir) = test_pool().await;

    // Device A: create B1
    append_local_op_at(&pool, DEV_A, make_create("B1", "initial"), FIXED_TS)
        .await
        .unwrap();

    // Device A: edit B1 with prev_edit pointing to the create
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "edit-A", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Device B: edit B1 also pointing to (A,1) as prev_edit
    // Insert as remote op since it's a different device
    let b_edit_payload = r#"{"block_id":"B1","to_text":"edit-B","prev_edit":["device-A",1]}"#;
    let b_record = make_remote_record(
        DEV_B,
        1,
        None, // genesis for device B
        "edit_block",
        b_edit_payload,
    );
    insert_remote_op(&pool, &b_record).await.unwrap();

    let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_B.into(), 1))
        .await
        .unwrap();

    assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
}

/// Linear chain: A creates, then edits twice.
///
/// ```text
/// (A,1) create → (A,2) edit → (A,3) edit
/// ```
///
/// LCA of (A,2) and (A,3) is (A,2).
#[tokio::test]
async fn find_lca_linear_chain() {
    let (pool, _dir) = test_pool().await;

    // create
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    // edit 1
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();
    // edit 2
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v2", Some((DEV_A.into(), 2))),
        FIXED_TS,
    )
    .await
    .unwrap();

    let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 3))
        .await
        .unwrap();
    assert_eq!(lca, Some((DEV_A.to_owned(), 2)));
}

/// Divergent edits from a common edit (not the create).
///
/// ```text
/// (A,1) create → (A,2) edit
///                  ├── (A,3) edit, prev_edit=(A,2)
///                  └── (B,1) edit, prev_edit=(A,2)
/// ```
///
/// LCA of (A,3) and (B,1) is (A,2).
#[tokio::test]
async fn find_lca_divergent_from_common_edit() {
    let (pool, _dir) = test_pool().await;

    // create
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    // edit 1
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();
    // edit 2 (continues on A)
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v2-A", Some((DEV_A.into(), 2))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Device B diverges from (A,2)
    let b_payload = r#"{"block_id":"B1","to_text":"v2-B","prev_edit":["device-A",2]}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
    insert_remote_op(&pool, &b_record).await.unwrap();

    let lca = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_B.into(), 1))
        .await
        .unwrap();
    assert_eq!(lca, Some((DEV_A.to_owned(), 2)));
}

/// Edge case: LCA of an op with itself.
#[tokio::test]
async fn find_lca_same_op() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 2))
        .await
        .unwrap();
    assert_eq!(lca, Some((DEV_A.to_owned(), 2)));
}

/// Edge case: find_lca with only the create_block (no edits).
/// Both ops point to the same create.
#[tokio::test]
async fn find_lca_only_create_block() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    let lca = find_lca(&pool, &(DEV_A.into(), 1), &(DEV_A.into(), 1))
        .await
        .unwrap();
    assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
}

/// Edge case: op_a is a `create_block` and op_b is an `edit_block`
/// whose chain traces back to that create.
///
/// ```text
/// (A,1) create_block B1
///   └── (A,2) edit_block B1, prev_edit=(A,1)
/// ```
///
/// LCA of (A,1) and (A,2) should be (A,1).
#[tokio::test]
async fn find_lca_op_a_is_create_block() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // op_a is create, op_b is edit
    let lca = find_lca(&pool, &(DEV_A.into(), 1), &(DEV_A.into(), 2))
        .await
        .unwrap();
    assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
}

/// Edge case: op_b is a `create_block` and op_a is an `edit_block`.
/// Mirror of the above — ensures B-chain handling is correct for creates.
///
/// LCA of (A,2) and (A,1) should be (A,1).
#[tokio::test]
async fn find_lca_op_b_is_create_block() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // op_a is edit, op_b is create
    let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 1))
        .await
        .unwrap();
    assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
}

/// M-4: a chain longer than `MAX_LCA_STEPS` (10,000) must trip the
/// step-cap and return `AppError::InvalidOperation` with a clear
/// message — even when the chain is *acyclic* and would otherwise walk
/// to completion.  Without the cap, a corrupted op log with a
/// pathologically long chain can issue an unbounded number of
/// `get_op_by_seq` writer-pool acquires.
///
/// Built via raw SQL inside a single transaction so the 10,001 inserts
/// take ~hundreds of ms instead of tens of seconds.
#[tokio::test]
async fn find_lca_chain_exceeds_max_steps_returns_error() {
    let (pool, _dir) = test_pool().await;

    // (A,1) create_block plus (A,2)..(A,10001) edit_block ops, each
    // pointing one step back.  Chain depth = 10001 → 10000 prev_edit
    // edges.  With the cap configured as `>=` against MAX_LCA_STEPS =
    // 10_000, the 10000th edge walked trips the limit.
    let mut tx = pool.begin().await.unwrap();

    let create_payload =
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v0"}"#;
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, 1, NULL, ?, 'create_block', ?, ?)",
    )
    .bind(DEV_A)
    .bind("hash_create_1")
    .bind(create_payload)
    .bind(FIXED_TS)
    .execute(&mut *tx)
    .await
    .unwrap();

    for seq in 2_i64..=10_001 {
        let prev = seq - 1;
        let payload =
            format!(r#"{{"block_id":"B1","to_text":"v{seq}","prev_edit":["device-A",{prev}]}}"#);
        let hash = format!("hash_edit_{seq:06}");
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
        )
        .bind(DEV_A)
        .bind(seq)
        .bind(&hash)
        .bind(&payload)
        .bind(FIXED_TS)
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    tx.commit().await.unwrap();

    // find_lca(head, head) walks chain A entirely before checking op_b
    // against the visited set, so the long-chain walk is exercised
    // before any short-circuit.  The cap fires once steps_a >= 10_000.
    let result = find_lca(&pool, &(DEV_A.into(), 10_001), &(DEV_A.into(), 10_001)).await;
    assert!(
        result.is_err(),
        "10001-deep chain must trip the find_lca step cap, got: {result:?}"
    );
    let msg = result.unwrap_err().to_string();
    assert!(
        msg.contains("exceeded max steps"),
        "error must mention exceeded max steps, got: {msg}"
    );
}

// =====================================================================
// 4. text_at
// =====================================================================

#[tokio::test]
async fn text_at_returns_content_from_create_block() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "hello world"), FIXED_TS)
        .await
        .unwrap();

    let text = text_at(&pool, DEV_A, 1).await.unwrap();
    assert_eq!(text, "hello world");
}

#[tokio::test]
async fn text_at_returns_to_text_from_edit_block() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "updated text", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    let text = text_at(&pool, DEV_A, 2).await.unwrap();
    assert_eq!(text, "updated text");
}

#[tokio::test]
async fn text_at_rejects_delete_block() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_delete("B1"), FIXED_TS)
        .await
        .unwrap();

    let err = text_at(&pool, DEV_A, 1).await;
    assert!(err.is_err());
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("content-producing"),
        "expected 'content-producing' error, got: {msg}"
    );
}

#[tokio::test]
async fn text_at_not_found_for_missing_op() {
    let (pool, _dir) = test_pool().await;

    let err = text_at(&pool, DEV_A, 999).await;
    assert!(err.is_err());
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("Not found"),
        "expected NotFound error, got: {msg}"
    );
}

// =====================================================================
// 5. get_block_edit_heads
// =====================================================================

#[tokio::test]
async fn get_block_edit_heads_single_device() {
    let (pool, _dir) = test_pool().await;

    // create block
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    // two edits
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v2", Some((DEV_A.into(), 2))),
        FIXED_TS,
    )
    .await
    .unwrap();

    let heads = get_block_edit_heads(&pool, "B1").await.unwrap();
    assert_eq!(heads.len(), 1, "single device should have 1 head");
    assert_eq!(heads[0], (DEV_A.to_owned(), 3));
}

#[tokio::test]
async fn get_block_edit_heads_multiple_devices() {
    let (pool, _dir) = test_pool().await;

    // Device A: create + edit
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1-A", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Device B: edit (inserted as remote)
    let b_payload = r#"{"block_id":"B1","to_text":"v1-B","prev_edit":["device-A",1]}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
    insert_remote_op(&pool, &b_record).await.unwrap();

    let heads = get_block_edit_heads(&pool, "B1").await.unwrap();
    assert_eq!(heads.len(), 2, "two devices should have 2 heads");
    // Sorted by device_id: device-A < device-B
    assert_eq!(heads[0], (DEV_A.to_owned(), 2));
    assert_eq!(heads[1], (DEV_B.to_owned(), 1));
}

#[tokio::test]
async fn get_block_edit_heads_no_edits() {
    let (pool, _dir) = test_pool().await;

    // Only a create, no edits
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    let heads = get_block_edit_heads(&pool, "B1").await.unwrap();
    assert!(heads.is_empty(), "no edits means no heads");
}

#[tokio::test]
async fn get_block_edit_heads_different_blocks_isolated() {
    let (pool, _dir) = test_pool().await;

    // Edits for B1
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Edits for B2
    append_local_op_at(&pool, DEV_A, make_create("B2", "other"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B2", "other-v1", Some((DEV_A.into(), 3))),
        FIXED_TS,
    )
    .await
    .unwrap();

    let heads_b1 = get_block_edit_heads(&pool, "B1").await.unwrap();
    assert_eq!(heads_b1.len(), 1);
    assert_eq!(heads_b1[0], (DEV_A.to_owned(), 2));

    let heads_b2 = get_block_edit_heads(&pool, "B2").await.unwrap();
    assert_eq!(heads_b2.len(), 1);
    assert_eq!(heads_b2[0], (DEV_A.to_owned(), 4));
}

#[tokio::test]
async fn get_block_edit_heads_nonexistent_block() {
    let (pool, _dir) = test_pool().await;

    let heads = get_block_edit_heads(&pool, "nonexistent").await.unwrap();
    assert!(heads.is_empty());
}

// ── F15: find_lca after compaction (ops purged from chain) ──────────

/// When historical ops have been purged by compaction, `find_lca` should
/// return `AppError::InvalidOperation` with a clear message mentioning
/// compaction (snapshots exist, so the guard detects the broken chain).
#[tokio::test]
async fn find_lca_after_compaction_returns_invalid_operation() {
    use crate::snapshot::compact_op_log;

    let (pool, _dir) = test_pool().await;

    // Insert block into blocks table (needed for snapshot collection)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
         VALUES ('B1', 'content', 'v1', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Old create_block op (200 days ago)
    let _create = append_local_op_at(
        &pool,
        DEV_A,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("B1"),
            block_type: "content".to_owned(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "v1".to_owned(),
        }),
        1_704_067_200_000,
    )
    .await
    .unwrap();

    // Old edit (also 200 days ago) with prev_edit pointing to seq 1
    let _edit1 = append_local_op_at(
        &pool,
        DEV_A,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("B1"),
            prev_edit: Some((DEV_A.to_owned(), 1)),
            to_text: "v2".to_owned(),
        }),
        1_704_067_260_000,
    )
    .await
    .unwrap();

    // Recent edit (now) with prev_edit pointing to seq 2
    let now = crate::db::now_ms();
    let edit2 = append_local_op_at(
        &pool,
        DEV_A,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("B1"),
            prev_edit: Some((DEV_A.to_owned(), 2)),
            to_text: "v3".to_owned(),
        }),
        now,
    )
    .await
    .unwrap();

    // Compact with 90-day retention → purges seq 1 and 2 (old), keeps seq 3
    compact_op_log(&pool, DEV_A, 90).await.unwrap();

    // Verify seq 3 survived
    assert_eq!(edit2.seq, 3);
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1, "only the recent op should survive");

    // find_lca with seq 3 (recent) should fail because it tries to walk
    // the prev_edit chain to seq 2 which was purged.
    let result = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_A.into(), 3)).await;
    assert!(
        result.is_err(),
        "find_lca should fail when chain walk hits purged ops"
    );

    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::InvalidOperation(_)),
        "expected AppError::InvalidOperation, got: {err:?}"
    );
    let msg = err.to_string();
    assert!(
        msg.to_lowercase().contains("compaction"),
        "expected InvalidOperation mentioning compaction, got: {msg}"
    );
}

/// Dedicated test: set up two ops, create a snapshot, delete the
/// intermediate op from op_log, call find_lca, verify it returns
/// `AppError::InvalidOperation` containing "compaction".
#[tokio::test]
async fn find_lca_after_compaction_returns_clear_error() {
    let (pool, _dir) = test_pool().await;

    // Create block
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    // Edit pointing back to create
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Simulate compaction: insert a snapshot row then delete seq 1
    sqlx::query(
        "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
         VALUES (?, 'complete', ?, '{\"device-A\":1}', X'00')",
    )
    .bind(TEST_SNAPSHOT_ID)
    .bind(TEST_SNAPSHOT_HASH)
    .execute(&pool)
    .await
    .unwrap();

    // H-13: op_log mutations now require the compaction bypass.
    let mut tx = pool.begin().await.unwrap();
    crate::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM op_log WHERE device_id = ? AND seq = 1")
        .bind(DEV_A)
        .execute(&mut *tx)
        .await
        .unwrap();
    crate::op_log::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // find_lca walks from (A,2), follows prev_edit to (A,1) which is
    // missing → should return InvalidOperation mentioning compaction
    let result = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 2)).await;
    assert!(result.is_err(), "find_lca should fail on broken chain");

    let err = result.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.to_lowercase().contains("compaction"),
        "error should mention compaction, got: {msg}"
    );
    assert!(
        msg.contains("edit chain broken"),
        "error should mention broken chain, got: {msg}"
    );
}

// =====================================================================
// extract_prev_edit: unexpected op_type
// =====================================================================

/// `extract_prev_edit` returns `AppError::InvalidOperation` when the
/// `OpRecord` has an op_type other than "edit_block" or "create_block".
#[test]
fn extract_prev_edit_unexpected_op_type_returns_error() {
    let payload = r#"{"block_id":"B1","tag_id":"T1"}"#;
    let hash = compute_op_hash("dev-test", 1, None, "delete_block", payload);
    let record = OpRecord {
        device_id: "dev-test".to_owned(),
        seq: 1,
        parent_seqs: None,
        hash,
        op_type: "delete_block".to_owned(),
        payload: payload.to_owned(),
        created_at: FIXED_TS,
        block_id: Some("B1".to_owned()),
    };

    let result = extract_prev_edit(&record);
    assert!(
        result.is_err(),
        "extract_prev_edit should error on delete_block op_type"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string()
            .contains("expected edit_block or create_block"),
        "error should mention expected types, got: {err}"
    );
}

/// `extract_prev_edit` returns `Ok(None)` for `create_block` ops.
#[test]
fn extract_prev_edit_create_block_returns_none() {
    let payload = r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#;
    let hash = compute_op_hash("dev-test", 1, None, "create_block", payload);
    let record = OpRecord {
        device_id: "dev-test".to_owned(),
        seq: 1,
        parent_seqs: None,
        hash,
        op_type: "create_block".to_owned(),
        payload: payload.to_owned(),
        created_at: FIXED_TS,
        block_id: Some("B1".to_owned()),
    };

    let result = extract_prev_edit(&record).unwrap();
    assert!(result.is_none(), "create_block should have no prev_edit");
}

/// `extract_prev_edit` returns the `prev_edit` pointer for `edit_block` ops.
#[test]
fn extract_prev_edit_edit_block_returns_prev_edit() {
    let payload = r#"{"block_id":"B1","to_text":"updated","prev_edit":["device-A",1]}"#;
    let hash = compute_op_hash("dev-test", 2, None, "edit_block", payload);
    let record = OpRecord {
        device_id: "dev-test".to_owned(),
        seq: 2,
        parent_seqs: None,
        hash,
        op_type: "edit_block".to_owned(),
        payload: payload.to_owned(),
        created_at: FIXED_TS,
        block_id: Some("B1".to_owned()),
    };

    let result = extract_prev_edit(&record).unwrap();
    assert_eq!(
        result,
        Some(("device-A".to_owned(), 1)),
        "edit_block should return its prev_edit"
    );
}

// =====================================================================
// find_lca: cycle detection in prev_edit chain
// =====================================================================

/// Create a cyclic prev_edit chain via raw SQL and verify that
/// `find_lca` terminates gracefully (returns `Ok(None)` because the
/// cycle-break `visited.insert` check stops the walk before it can
/// loop forever).
///
/// ```text
/// (A,1) create_block B1
/// (A,2) edit_block B1, prev_edit=(A,3)  ←── cycle
/// (A,3) edit_block B1, prev_edit=(A,2)  ←── cycle
/// (B,1) edit_block B1, prev_edit=(A,1)      (divergent)
/// ```
#[tokio::test]
async fn find_lca_detects_cycle_in_chain() {
    let (pool, _dir) = test_pool().await;

    // (A,1) create_block B1 — normal op
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    // (A,2) edit_block with prev_edit pointing FORWARD to (A,3) — forms cycle
    let payload2 = r#"{"block_id":"B1","to_text":"v2","prev_edit":["device-A",3]}"#;
    let hash2 = compute_op_hash(DEV_A, 2, None, "edit_block", payload2);
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
    )
    .bind(DEV_A)
    .bind(2_i64)
    .bind(&hash2)
    .bind(payload2)
    .bind(FIXED_TS)
    .execute(&pool)
    .await
    .unwrap();

    // (A,3) edit_block with prev_edit pointing back to (A,2) — completes the cycle
    let payload3 = r#"{"block_id":"B1","to_text":"v3","prev_edit":["device-A",2]}"#;
    let hash3 = compute_op_hash(DEV_A, 3, None, "edit_block", payload3);
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
    )
    .bind(DEV_A)
    .bind(3_i64)
    .bind(&hash3)
    .bind(payload3)
    .bind(FIXED_TS)
    .execute(&pool)
    .await
    .unwrap();

    // (B,1) edit_block divergent from (A,1) — normal chain
    let b_payload = r#"{"block_id":"B1","to_text":"v-B","prev_edit":["device-A",1]}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
    insert_remote_op(&pool, &b_record).await.unwrap();

    // find_lca between the cyclic chain head (A,3) and the divergent (B,1).
    // Chain A: (A,3)→(A,2)→(A,3) cycle — visited set breaks the loop.
    // Chain B: (B,1)→(A,1) = create_block — terminates normally.
    // The cycle prevents chain A from ever reaching (A,1), so no common
    // ancestor is found. find_lca should return Ok(None), proving the
    // cycle was detected and didn't cause an infinite loop.
    let result = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_B.into(), 1)).await;

    assert!(
        result.is_ok(),
        "find_lca should not hang or error on cycle — it should break via visited set, got: {:?}",
        result
    );
    assert_eq!(
        result.unwrap(),
        None,
        "cyclic chain A never reaches (A,1), so no LCA with chain B"
    );
}

// =====================================================================
// find_lca: HashSet-based cycle detection — self-loop
// =====================================================================

/// An op whose prev_edit points to itself forms a self-loop.
/// The visited HashSet should detect this on the very first step
/// and break immediately without hanging.
///
/// ```text
/// (A,1) create_block B1
/// (A,2) edit_block B1, prev_edit=(A,2)  ←── self-loop
/// (B,1) edit_block B1, prev_edit=(A,1)      (divergent)
/// ```
#[tokio::test]
async fn find_lca_detects_self_loop() {
    let (pool, _dir) = test_pool().await;

    // (A,1) create_block B1
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    // (A,2) edit_block with prev_edit pointing to itself — self-loop
    let payload_self = r#"{"block_id":"B1","to_text":"v-self","prev_edit":["device-A",2]}"#;
    let hash_self = compute_op_hash(DEV_A, 2, None, "edit_block", payload_self);
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
    )
    .bind(DEV_A)
    .bind(2_i64)
    .bind(&hash_self)
    .bind(payload_self)
    .bind(FIXED_TS)
    .execute(&pool)
    .await
    .unwrap();

    // (B,1) normal divergent edit from create
    let b_payload = r#"{"block_id":"B1","to_text":"v-B","prev_edit":["device-A",1]}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
    insert_remote_op(&pool, &b_record).await.unwrap();

    // Chain A: (A,2) → prev_edit is (A,2) — self-loop detected immediately.
    // Chain B: (B,1) → (A,1) = create_block.
    // No LCA because chain A never gets past its self-loop.
    let result = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_B.into(), 1)).await;
    assert!(
        result.is_ok(),
        "find_lca should not hang on self-loop, got: {:?}",
        result
    );
    assert_eq!(
        result.unwrap(),
        None,
        "self-loop in chain A prevents reaching (A,1), so no LCA"
    );
}

/// Verify that find_lca still correctly finds the LCA when both
/// chains converge, confirming the HashSet optimization preserves
/// correct behavior.
///
/// ```text
/// (A,1) create_block B1
/// (A,2) edit_block B1, prev_edit=(A,1)
/// (A,3) edit_block B1, prev_edit=(A,2)   ← chain A head
/// (B,1) edit_block B1, prev_edit=(A,2)   ← chain B head
/// ```
/// LCA should be (A,2).
#[tokio::test]
async fn find_lca_with_hashset_finds_correct_ancestor() {
    let (pool, _dir) = test_pool().await;

    // (A,1) create_block B1
    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    // (A,2) edit_block prev_edit=(A,1)
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // (A,3) edit_block prev_edit=(A,2)
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v2", Some((DEV_A.into(), 2))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // (B,1) edit_block prev_edit=(A,2) — diverges from (A,2)
    let b_payload = r#"{"block_id":"B1","to_text":"v-B","prev_edit":["device-A",2]}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
    insert_remote_op(&pool, &b_record).await.unwrap();

    let result = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_B.into(), 1)).await;
    assert!(result.is_ok(), "find_lca should succeed");
    let lca = result.unwrap();
    assert_eq!(
        lca,
        Some((DEV_A.into(), 2)),
        "LCA should be (device-A, 2) where both chains diverge"
    );
}

// =====================================================================
// I-Core-2: CTE-driven `find_lca` vs the `#[cfg(test)]` Rust-walk oracle
// =====================================================================
//
// `find_lca` (production) uses a single recursive CTE per chain; the
// N+1 Rust walk is preserved as `find_lca_oracle` so these tests can
// assert byte-for-byte agreement across the chain topologies that the
// merge hot path exercises in production.

/// Shared scenario runner: after the fixture is built, call both
/// `find_lca` (CTE) and `find_lca_oracle` (Rust walk) with identical
/// arguments and assert the results match — and, when specified, match
/// an `expected` LCA as well.
async fn assert_cte_matches_oracle(
    pool: &sqlx::SqlitePool,
    op_a: (String, i64),
    op_b: (String, i64),
    expected: Option<(String, i64)>,
) {
    let prod = super::find_lca(pool, &op_a, &op_b).await.unwrap();
    let oracle = super::find_lca_oracle(pool, &op_a, &op_b).await.unwrap();
    assert_eq!(
        prod, oracle,
        "CTE `find_lca` and `find_lca_oracle` must agree for \
         op_a={op_a:?} op_b={op_b:?}"
    );
    assert_eq!(
        prod, expected,
        "LCA mismatch for op_a={op_a:?} op_b={op_b:?}"
    );
}

/// Linear chain (A,1)→(A,2)→(A,3): LCA of (A,3) with itself is (A,3);
/// LCA of (A,2) and (A,3) is (A,2).
#[tokio::test]
async fn cte_oracle_linear_chain() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v2", Some((DEV_A.into(), 2))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Self-LCA (head with itself) — short-circuit path.
    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 3),
        (DEV_A.into(), 3),
        Some((DEV_A.into(), 3)),
    )
    .await;

    // op_b sits inside chain A: LCA = op_b.
    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 3),
        (DEV_A.into(), 2),
        Some((DEV_A.into(), 2)),
    )
    .await;

    // Mirror: op_a inside chain B.
    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 2),
        (DEV_A.into(), 3),
        Some((DEV_A.into(), 2)),
    )
    .await;
}

/// Diverging chains: A creates, A edits, then both A and B branch off
/// that edit. LCA of (A,3) and (B,1) must be (A,2).
#[tokio::test]
async fn cte_oracle_diverging_chains() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v2-A", Some((DEV_A.into(), 2))),
        FIXED_TS,
    )
    .await
    .unwrap();

    let b_payload = r#"{"block_id":"B1","to_text":"v2-B","prev_edit":["device-A",2]}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
    insert_remote_op(&pool, &b_record).await.unwrap();

    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 3),
        (DEV_B.into(), 1),
        Some((DEV_A.into(), 2)),
    )
    .await;

    // Also at the create: two edits both diverging off (A,1).
    let c_payload = r#"{"block_id":"B1","to_text":"edit-from-C","prev_edit":["device-A",1]}"#;
    let c_record = make_remote_record("device-C", 1, None, "edit_block", c_payload);
    insert_remote_op(&pool, &c_record).await.unwrap();

    assert_cte_matches_oracle(
        &pool,
        (DEV_B.into(), 1),
        ("device-C".into(), 1),
        Some((DEV_A.into(), 1)),
    )
    .await;
}

/// Genesis edit: a single `create_block` with no subsequent edits.
/// LCA of the create with itself is the create.
#[tokio::test]
async fn cte_oracle_genesis_edit() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();

    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 1),
        (DEV_A.into(), 1),
        Some((DEV_A.into(), 1)),
    )
    .await;
}

/// Two-op chain where the LCA is the genesis. create_block at (A,1),
/// one edit at (A,2). LCA of (A,2) and (A,1) is (A,1).
#[tokio::test]
async fn cte_oracle_two_op_chain_lca_is_genesis() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v1", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // (A,2) vs (A,1): op_b is the ancestor create.
    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 2),
        (DEV_A.into(), 1),
        Some((DEV_A.into(), 1)),
    )
    .await;

    // Mirror: (A,1) vs (A,2).
    assert_cte_matches_oracle(
        &pool,
        (DEV_A.into(), 1),
        (DEV_A.into(), 2),
        Some((DEV_A.into(), 1)),
    )
    .await;
}

/// Disjoint chains (M-72 shape): two independent create_block ops for
/// the same block_id — chains never overlap. Both implementations must
/// return `None`.
#[tokio::test]
async fn cte_oracle_disjoint_chains_return_none() {
    let (pool, _dir) = test_pool().await;

    // Device A: create + edit.
    append_local_op_at(&pool, DEV_A, make_create("B1", "v-A"), FIXED_TS)
        .await
        .unwrap();
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit("B1", "v-A'", Some((DEV_A.into(), 1))),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Device B: independent create for the same block_id.
    let b_create =
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v-B"}"#;
    let b_record = make_remote_record(DEV_B, 1, None, "create_block", b_create);
    insert_remote_op(&pool, &b_record).await.unwrap();

    assert_cte_matches_oracle(&pool, (DEV_A.into(), 2), (DEV_B.into(), 1), None).await;
}
