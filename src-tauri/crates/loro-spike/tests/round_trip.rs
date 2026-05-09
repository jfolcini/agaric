//! Day-1 integration test for `LoroEngine`.  Inserts a page + two
//! children, asserts read-back equality, and asserts that the exported
//! snapshot is non-empty.  The byte-size threshold is intentionally
//! loose (>0); tightening lands once we have measurements at 10K and
//! 100K blocks per the spike's perf criterion.

use loro_spike::{peer_id_from_device_id, BlockSnapshot, LoroEngine, TreeEngine};

#[test]
fn create_block_round_trips_through_loro() {
    let mut engine = LoroEngine::new();

    let page = "page-01";
    let child = "child-01";

    engine
        .apply_create_block(page, "page", "Hello", None, 0)
        .expect("create page");
    engine
        .apply_create_block(child, "text", "world", Some(page), 1_000)
        .expect("create child");

    let read_page = engine
        .read_block(page)
        .expect("read page")
        .expect("page exists");
    assert_eq!(
        read_page,
        BlockSnapshot {
            block_id: page.into(),
            block_type: "page".into(),
            content: "Hello".into(),
            parent_id: None,
            position: 0,
        }
    );

    let read_child = engine
        .read_block(child)
        .expect("read child")
        .expect("child exists");
    assert_eq!(
        read_child,
        BlockSnapshot {
            block_id: child.into(),
            block_type: "text".into(),
            content: "world".into(),
            parent_id: Some(page.into()),
            position: 1_000,
        }
    );

    assert!(
        engine
            .read_block("does-not-exist")
            .expect("read missing")
            .is_none(),
        "missing blocks should round-trip as None, not error"
    );

    let bytes = engine.export_snapshot().expect("export snapshot");
    assert!(!bytes.is_empty(), "snapshot bytes must be non-empty");
}

// ---------------------------------------------------------------------------
// Day-3 unit tests: cover each new LoroEngine method at least once before
// the parity_corpus tests start exercising them in concert.  Per the
// spike's "exercise the new API in isolation first" guideline.
// ---------------------------------------------------------------------------

#[test]
fn apply_edit_block_replaces_full_content() {
    let mut engine = LoroEngine::new();
    engine
        .apply_create_block("B1", "text", "hello world", None, 0)
        .expect("create");
    engine
        .apply_edit_block("B1", "goodbye world")
        .expect("edit_block");
    let block = engine.read_block("B1").expect("read").expect("present");
    assert_eq!(block.content, "goodbye world");
}

#[test]
fn apply_delete_block_marks_deleted() {
    let mut engine = LoroEngine::new();
    engine
        .apply_create_block("B1", "text", "hi", None, 0)
        .expect("create");
    assert!(!engine.read_deleted("B1").expect("read deleted"));
    engine.apply_delete_block("B1").expect("delete");
    assert!(engine.read_deleted("B1").expect("read deleted post"));
    // The block itself is still readable — soft delete only.
    let block = engine.read_block("B1").expect("read").expect("present");
    assert_eq!(block.content, "hi");
}

#[test]
fn apply_move_block_updates_parent_and_position() {
    let mut engine = LoroEngine::new();
    engine
        .apply_create_block("PAGE_A", "page", "A", None, 0)
        .expect("page A");
    engine
        .apply_create_block("PAGE_B", "page", "B", None, 1)
        .expect("page B");
    engine
        .apply_create_block("CHILD", "text", "child", Some("PAGE_A"), 100)
        .expect("child");

    engine
        .apply_move_block("CHILD", Some("PAGE_B"), 200)
        .expect("move");

    assert_eq!(
        engine.read_parent("CHILD").expect("read parent"),
        Some("PAGE_B".into())
    );
    assert_eq!(engine.read_position("CHILD").expect("read pos"), 200);
}

// ---------------------------------------------------------------------------
// Day-6 unit tests: peer-id derivation from device_id (Q7).
//
// Three checks per the day-6 deliverables list:
//   1. determinism (same device_id -> same peer_id, across instances);
//   2. spread (different device_ids -> different peer_ids);
//   3. with_peer_id engines exporting + importing each other's snapshots
//      converge to the same state — i.e. the chosen peer-id assignment
//      doesn't break sync.
// ---------------------------------------------------------------------------

const DEVICE_A: &str = "11111111-1111-4111-a111-111111111111";
const DEVICE_B: &str = "22222222-2222-4222-a222-222222222222";

#[test]
fn peer_id_from_device_id_is_deterministic_across_instances() {
    // Same device_id, two engines, same peer_id.
    let e1 = LoroEngine::with_peer_id(DEVICE_A);
    let e2 = LoroEngine::with_peer_id(DEVICE_A);
    assert_eq!(
        e1.peer_id(),
        e2.peer_id(),
        "two LoroEngine::with_peer_id instances built from the same device_id \
         must agree on the resulting peer_id"
    );

    // The free function is the source of truth — engines should match it.
    let raw = peer_id_from_device_id(DEVICE_A);
    assert_eq!(e1.peer_id(), raw);

    // TreeEngine variant — same expectation.
    let t1 = TreeEngine::with_peer_id(DEVICE_A);
    assert_eq!(t1.peer_id(), raw);
}

#[test]
fn peer_id_from_device_id_spreads_distinct_inputs() {
    let a = LoroEngine::with_peer_id(DEVICE_A).peer_id();
    let b = LoroEngine::with_peer_id(DEVICE_B).peer_id();
    assert_ne!(
        a, b,
        "two distinct device_ids should hash to distinct peer_ids \
         (collision at the {DEVICE_A} / {DEVICE_B} pair would mean either \
         the hash is broken or we've been astonishingly unlucky)"
    );
}

#[test]
fn with_peer_id_engines_round_trip_via_snapshot_swap() {
    // Two peers with stable peer_ids derived from production-shaped
    // device_ids.  Each writes a different block, then they exchange
    // snapshots and we assert both engines see both blocks identically.
    // This is the headline check that pinning peer_id doesn't break
    // Loro's sync semantics.
    let mut a = LoroEngine::with_peer_id(DEVICE_A);
    let mut b = LoroEngine::with_peer_id(DEVICE_B);

    a.apply_create_block("PAGE", "page", "Shared root", None, 0)
        .expect("A creates page");
    b.apply_create_block("PAGE", "page", "Shared root", None, 0)
        .expect("B creates page");

    // Bring both peers to a common starting state.
    let a_seed = a.export_snapshot().expect("A export seed");
    let b_seed = b.export_snapshot().expect("B export seed");
    a.import(&b_seed).expect("A import B seed");
    b.import(&a_seed).expect("B import A seed");

    // Each peer creates a different child.
    a.apply_create_block("BLK_A", "text", "from A", Some("PAGE"), 100)
        .expect("A creates BLK_A");
    b.apply_create_block("BLK_B", "text", "from B", Some("PAGE"), 200)
        .expect("B creates BLK_B");

    let a_export = a.export_snapshot().expect("A export");
    let b_export = b.export_snapshot().expect("B export");
    a.import(&b_export).expect("A import B");
    b.import(&a_export).expect("B import A");

    let a_blk_a = a.read_block("BLK_A").expect("A read BLK_A").unwrap();
    let b_blk_a = b.read_block("BLK_A").expect("B read BLK_A").unwrap();
    let a_blk_b = a.read_block("BLK_B").expect("A read BLK_B").unwrap();
    let b_blk_b = b.read_block("BLK_B").expect("B read BLK_B").unwrap();

    assert_eq!(a_blk_a, b_blk_a, "BLK_A must round-trip identically");
    assert_eq!(a_blk_b, b_blk_b, "BLK_B must round-trip identically");
    assert_eq!(a_blk_a.content, "from A");
    assert_eq!(b_blk_b.content, "from B");

    // And one more headline assertion: both engines produce
    // byte-identical snapshots after they've observed each other's
    // state.  Loro's CRDT property is strong enough that converged
    // peers' snapshots are byte-equal, not just semantically equal.
    let a_post = a.export_snapshot().expect("A re-export");
    let b_post = b.export_snapshot().expect("B re-export");
    assert_eq!(
        a_post, b_post,
        "post-merge snapshots from A and B must be byte-identical \
         (CRDT eventual-consistency property under stable peer ids)"
    );
}

#[test]
fn apply_set_property_writes_and_reads() {
    let mut engine = LoroEngine::new();
    engine
        .apply_create_block("B1", "text", "x", None, 0)
        .expect("create");

    // Unset key returns None.
    assert!(engine.read_property("B1", "priority").unwrap().is_none());

    // Set to "high" → Some(Some("high")).
    engine
        .apply_set_property("B1", "priority", Some("high"))
        .expect("set");
    assert_eq!(
        engine.read_property("B1", "priority").unwrap(),
        Some(Some("high".into()))
    );

    // Overwrite — LWW.
    engine
        .apply_set_property("B1", "priority", Some("low"))
        .expect("overwrite");
    assert_eq!(
        engine.read_property("B1", "priority").unwrap(),
        Some(Some("low".into()))
    );

    // Clear (explicit null).
    engine
        .apply_set_property("B1", "priority", None)
        .expect("clear");
    assert_eq!(
        engine.read_property("B1", "priority").unwrap(),
        Some(None),
        "explicit-null write should return Some(None), not None"
    );
}
