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
