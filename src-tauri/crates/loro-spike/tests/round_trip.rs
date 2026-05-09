//! Day-1 integration test for `LoroEngine`.  Inserts a page + two
//! children, asserts read-back equality, and asserts that the exported
//! snapshot is non-empty.  The byte-size threshold is intentionally
//! loose (>0); tightening lands once we have measurements at 10K and
//! 100K blocks per the spike's perf criterion.

use loro_spike::{BlockSnapshot, LoroEngine};

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
