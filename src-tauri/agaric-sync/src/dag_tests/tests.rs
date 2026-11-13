use super::*;
use agaric_core::hash::compute_op_hash;
use agaric_store::db::ReadPool;
use agaric_store::test_support::init_pool;
// #2621 (dag inversion): the op / op_log names these fixtures build on used to
// arrive through `super::*` from the pre-inversion `dag.rs` production imports.
// The core now lives in `agaric_engine::dag`, so import the store types the
// tests construct directly from their `crate::…` re-export paths.
use agaric_core::ulid::BlockId;
use agaric_store::op::*;
use agaric_store::op_log::{OpRecord, append_local_op_at, get_op_by_seq};
use std::path::PathBuf;
use tempfile::TempDir;

// ── Test fixture constants ──────────────────────────────────────────

const FIXED_TS: i64 = 1_736_942_400_000;
const DEV_A: &str = "device-A";
const DEV_B: &str = "device-B";

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
        prior_text: None,
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
    // Cache the parsed block_id on the sidecar, as a local append's record
    // carries it (`From<OpTransfer>` leaves it `None`). #2621: op_log's test-only
    // single-field `extract_block_id_from_payload` is no longer reachable
    // cross-crate now that op_log lives in `agaric-store`; use the equivalent
    // production single-pass extractor (its `.0` is the block_id).
    let (block_id, _) = agaric_store::op_log::extract_indexed_ids_from_payload(payload);
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

/// Ingest a record through the live audit path with the default origin.
async fn ingest(pool: &SqlitePool, record: &OpRecord) -> Result<bool, AppError> {
    ingest_replicated_record(pool, record, "user").await
}

// =====================================================================
// 1. ingest_replicated_record — the shared integrity checks
// =====================================================================

#[tokio::test]
async fn ingest_happy_path() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );

    ingest(&pool, &record).await.unwrap();

    // Verify it landed in the DB
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.device_id, "remote-dev");
    assert_eq!(fetched.seq, 1);
    assert_eq!(fetched.hash, record.hash);
    assert_eq!(fetched.op_type, "create_block");
}

/// #5371 — an ingested peer op moves its page up "Last edited": the ingest is
/// the one place this device's op log sees it, and the op is never applied.
#[tokio::test]
async fn an_ingested_peer_edit_raises_its_pages_last_edited_5371() {
    let (pool, _dir) = test_pool().await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, page_id) VALUES ('P5371', 'page', 'P', 'P5371')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
         VALUES ('C5371', 'content', 'c', 'P5371', 'P5371')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO pages_cache (page_id, title, updated_at) VALUES ('P5371', 'P', 0)")
        .execute(&pool)
        .await
        .unwrap();

    // As the audit ingest receives it: decoded off the wire, so without the
    // `block_id` sidecar (#6048).
    let transfer = crate::sync_protocol::OpTransfer::from(make_remote_record(
        "remote-dev",
        1,
        None,
        "edit_block",
        r#"{"block_id":"C5371","to_text":"peer","prev_edit":null}"#,
    ));
    assert!(
        insert_replicated_op(&pool, &transfer).await.unwrap(),
        "a new row"
    );

    let last_edited: i64 =
        sqlx::query_scalar("SELECT last_edited_ms FROM pages_cache WHERE page_id = 'P5371'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        last_edited, FIXED_TS,
        "the child's page moves to the op's time"
    );
}

#[tokio::test]
async fn ingest_duplicate_is_ignored() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );

    // Insert twice — second should be silently ignored
    ingest(&pool, &record).await.unwrap();
    ingest(&pool, &record).await.unwrap();

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
async fn ingest_same_pk_different_hash_rejected() {
    let (pool, _dir) = test_pool().await;

    // First op lands cleanly.
    let first = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
    );
    ingest(&pool, &first).await.unwrap();

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

    let err = ingest(&pool, &diverging).await;
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
async fn ingest_hash_mismatch_rejected() {
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

    let err = ingest(&pool, &record).await;
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
/// so the production ingest gate must reject it
/// *before* hashing — otherwise a corrupt op would panic in release.
///
/// We build the `OpRecord` by hand (not via `make_remote_record`, which
/// would trip the same `debug_assert!` while computing the hash) so the
/// test drives the production-facing rejection on the foreground path.
#[tokio::test]
async fn ingest_rejects_null_byte_in_device_id() {
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

    let err = ingest(&pool, &record).await;
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
async fn ingest_rejects_null_byte_in_each_field() {
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
        let err = ingest(&pool, &record).await;
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
async fn ingest_accepts_clean_op_after_null_byte_gate() {
    let (pool, _dir) = test_pool().await;
    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"clean"}"#,
    );
    ingest(&pool, &record).await.unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.hash, record.hash);
}

#[tokio::test]
async fn ingest_with_parent_seqs() {
    let (pool, _dir) = test_pool().await;

    // First insert the genesis op
    let r1 = make_remote_record(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v1"}"#,
    );
    ingest(&pool, &r1).await.unwrap();

    // Then insert an op that references the first as parent
    let parent_seqs = Some(r#"[["remote-dev",1]]"#.to_owned());
    let r2 = make_remote_record(
        "remote-dev",
        2,
        parent_seqs.clone(),
        "edit_block",
        r#"{"block_id":"B1","to_text":"v2","prev_edit":["remote-dev",1]}"#,
    );
    ingest(&pool, &r2).await.unwrap();

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
async fn ingest_preserves_bytes_but_canonicalizes_on_read() {
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
    ingest(&pool, &pa).await.unwrap();
    ingest(&pool, &pb).await.unwrap();

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
    ingest(&pool, &merge).await.unwrap();

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

/// Issue #112 sub-item 3: the batched existence check (one query via
/// `(device_id, seq) IN (json_each(?))`) accepts multi-parent records.
#[tokio::test]
async fn ingest_accepts_multiple_resolved_parent_seqs() {
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
        ingest(&pool, &r).await.unwrap();
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
    ingest(&pool, &merger).await.unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev-c", 1)
        .await
        .unwrap();
    assert_eq!(fetched.parent_seqs, parent_seqs);
}

// ── #2026: remote ingest enforces validate_set_property ─────────────
//
// The local append path runs every SetProperty payload through
// `op::validate_set_property` (key format, exactly-one-value, finite
// num, non-empty strings) before it can land. Before #2026,
// remote ingest validated only null-bytes / hash / parents, so a
// hash-valid SetProperty from a peer or a buggy/older client could land
// with an invalid key, an empty value, or multiple value fields — all
// rejected locally — and then flow into `engine_apply` + downstream
// (e.g. agenda ISO-date parsing). These tests mirror the local rejects.

/// A valid remote SetProperty (exactly one value, well-formed key) still
/// inserts — the new gate must not regress the happy path.
#[tokio::test]
async fn ingest_accepts_valid_set_property() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "set_property",
        r#"{"block_id":"B1","key":"status","value_text":"done","value_num":null,"value_date":null,"value_ref":null,"value_bool":null}"#,
    );

    ingest(&pool, &record).await.unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(fetched.op_type, "set_property");
    assert_eq!(fetched.hash, record.hash);
}

/// A hash-valid remote SetProperty with an INVALID key (special chars,
/// outside the `[A-Za-z0-9_-]` alphabet `validate_set_property` enforces)
/// must be REJECTED — mirrors the local `validate_set_property` reject.
#[tokio::test]
async fn ingest_rejects_set_property_invalid_key() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "set_property",
        r#"{"block_id":"B1","key":"bad key!","value_text":"x","value_num":null,"value_date":null,"value_ref":null,"value_bool":null}"#,
    );

    let err = ingest(&pool, &record).await;
    assert!(
        matches!(err, Err(AppError::Validation { .. })),
        "invalid SetProperty key must be rejected, got: {err:?}"
    );

    // The op must NOT have landed.
    assert!(
        get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
            .await
            .is_err(),
        "rejected SetProperty must not be written to op_log"
    );
}

/// A hash-valid remote SetProperty whose single value field is an empty
/// string (`value_text == ""`) must be REJECTED — the empty/whitespace
/// guard in `validate_set_property` (which prevents downstream parse
/// failures like agenda's ISO-8601 `value_date` parse).
#[tokio::test]
async fn ingest_rejects_set_property_empty_value() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "set_property",
        r#"{"block_id":"B1","key":"status","value_text":"","value_num":null,"value_date":null,"value_ref":null,"value_bool":null}"#,
    );

    let err = ingest(&pool, &record).await;
    assert!(
        matches!(err, Err(AppError::Validation { .. })),
        "empty-string SetProperty value must be rejected, got: {err:?}"
    );
    assert!(
        get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
            .await
            .is_err(),
        "rejected SetProperty must not be written to op_log"
    );
}

/// A hash-valid remote SetProperty with MORE THAN ONE value field set
/// (the exact "exactly one value" invariant the local path enforces) must
/// be REJECTED at ingest, before it can reach `engine_apply` and be
/// silently coerced by precedence.
#[tokio::test]
async fn ingest_rejects_set_property_multiple_values() {
    let (pool, _dir) = test_pool().await;

    let record = make_remote_record(
        "remote-dev",
        1,
        None,
        "set_property",
        r#"{"block_id":"B1","key":"status","value_text":"x","value_num":1.0,"value_date":null,"value_ref":null,"value_bool":null}"#,
    );

    let err = ingest(&pool, &record).await;
    assert!(
        matches!(err, Err(AppError::Validation { .. })),
        "multi-value SetProperty must be rejected, got: {err:?}"
    );
    assert!(
        get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
            .await
            .is_err(),
        "rejected SetProperty must not be written to op_log"
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
    ingest(&pool, &b_record).await.unwrap();

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

// =====================================================================
// insert_replicated_op — #2481 phase 1 audit-only op-log replication
// =====================================================================

use crate::sync_protocol::types::OpTransfer;

/// Build a valid replicated `OpTransfer` with a correct hash and a
/// caller-chosen `origin`.
fn make_transfer(
    device_id: &str,
    seq: i64,
    parent_seqs: Option<String>,
    op_type: &str,
    payload: &str,
    origin: &str,
) -> OpTransfer {
    let hash = compute_op_hash(device_id, seq, parent_seqs.as_deref(), op_type, payload);
    OpTransfer {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs,
        hash,
        op_type: op_type.to_owned(),
        payload: payload.to_owned(),
        created_at: FIXED_TS,
        origin: origin.to_owned(),
    }
}

/// Happy path: a valid replicated op lands verbatim, its `origin`
/// attribution travels and is stored, and the row is stamped
/// `is_replicated = 1`. Duplicate delivery is idempotent.
#[tokio::test]
async fn insert_replicated_op_stores_verbatim_with_origin_and_marker() {
    let (pool, _dir) = test_pool().await;
    let payload =
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v1"}"#;
    let t = make_transfer(
        "remote-dev",
        1,
        None,
        "create_block",
        payload,
        "agent:codex",
    );

    let inserted = insert_replicated_op(&pool, &t).await.unwrap();
    assert!(inserted, "a fresh replicated op must insert");

    // Stored verbatim; hash preserved.
    let rec = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(
        rec.hash, t.hash,
        "stored hash must equal the replicated hash"
    );
    assert_eq!(rec.payload, t.payload, "payload stored verbatim");
    assert_eq!(rec.op_type, "create_block");

    // origin travelled + is_replicated stamped.
    let row = sqlx::query!(
        r#"SELECT origin as "origin!: String", is_replicated as "is_replicated!: i64"
           FROM op_log WHERE device_id = ? AND seq = ?"#,
        "remote-dev",
        1i64,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.origin, "agent:codex",
        "origin attribution must travel and be stored verbatim (#2481)"
    );
    assert_eq!(
        row.is_replicated, 1,
        "replicated audit rows must be stamped is_replicated=1"
    );

    // Idempotent re-delivery.
    let again = insert_replicated_op(&pool, &t).await.unwrap();
    assert!(!again, "duplicate delivery of the same op is a no-op");
}

/// A hash-invalid replicated record is rejected loudly and nothing lands.
#[tokio::test]
async fn insert_replicated_op_rejects_hash_mismatch_loudly() {
    let (pool, _dir) = test_pool().await;
    let mut t = make_transfer(
        "remote-dev",
        1,
        None,
        "create_block",
        r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v1"}"#,
        "user",
    );
    t.hash = "0".repeat(64); // tamper: no longer matches the preimage

    let err = insert_replicated_op(&pool, &t).await;
    assert!(
        err.is_err(),
        "a hash-invalid replicated op must be rejected"
    );
    assert!(
        err.unwrap_err().to_string().contains("hash mismatch"),
        "rejection must be the loud hash-mismatch error"
    );

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1).await;
    assert!(
        matches!(fetched, Err(AppError::NotFound(_))),
        "a rejected replicated op must not land in op_log"
    );
}

/// #2481 audit-mode parent-gap relaxation: an unresolved `parent_seqs`
/// pointer (the peer compacted its own early history) must LAND with a
/// breadcrumb instead of being rejected.
#[tokio::test]
async fn insert_replicated_op_lands_unresolved_parent_gap() {
    let (pool, _dir) = test_pool().await;

    // References (remote-dev, 99), which does not exist locally (compacted peer).
    let parent_seqs = Some(r#"[["remote-dev",99]]"#.to_owned());
    let t = make_transfer(
        "remote-dev",
        1,
        parent_seqs,
        "edit_block",
        r#"{"block_id":"B1","to_text":"post-compaction","prev_edit":["remote-dev",99]}"#,
        "user",
    );

    // Audit profile lands it (breadcrumb, not rejection).
    let inserted = insert_replicated_op(&pool, &t).await.unwrap();
    assert!(
        inserted,
        "#2481 audit profile lands an unresolved-parent op instead of rejecting it"
    );
    let rec = get_op_by_seq(&ReadPool(pool.clone()), "remote-dev", 1)
        .await
        .unwrap();
    assert_eq!(rec.hash, t.hash, "the landed audit row is stored verbatim");
}

/// A replicated audit op coexists in op_log without leaking into boot
/// replay: it does NOT trip the #412 multi-device guard, is NOT applied to
/// the materializer, and never becomes SQL state — while the locally-authored
/// op materializes normally.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replicated_op_is_inert_for_boot_replay_and_sql_state() {
    use crate::recovery::replay::replay_unmaterialized_ops;
    use agaric_engine::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // One locally-authored op (DEV_A) — appended only, not yet materialized.
    append_local_op_at(&pool, DEV_A, make_create("LOCALBLK", "local"), FIXED_TS)
        .await
        .unwrap();

    // One replicated foreign audit op (DEV_B).
    let foreign = make_transfer(
        DEV_B,
        1,
        None,
        "create_block",
        r#"{"block_id":"FGNBLK","block_type":"content","parent_id":null,"position":0,"content":"foreign"}"#,
        "user",
    );
    insert_replicated_op(&pool, &foreign).await.unwrap();

    // Boot replay must NOT abort on the multi-device guard (the foreign row is
    // is_replicated=1) and must replay ONLY the locally-authored op.
    let report = replay_unmaterialized_ops(&pool, &mat).await.unwrap();
    assert_eq!(
        report.ops_replayed, 1,
        "only the locally-authored op is replayed; the replicated audit op is inert"
    );
    assert!(
        report.replay_errors.is_empty(),
        "a replicated foreign device must not trip the #412 multi-device replay guard, got {:?}",
        report.replay_errors,
    );

    // Exactly one block was projected into SQL — the local one. The foreign
    // audit op never became state.
    let block_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        block_count, 1,
        "the replicated audit op must never be projected into SQL state"
    );

    mat.shutdown();
}
