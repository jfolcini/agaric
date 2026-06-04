//! Smoke tests for the Loro production scaffold. Prove that the
//! engine survives a create-then-read round-trip.

use super::engine::{BlockSnapshot, LoroEngine};

#[test]
fn create_block_round_trips_through_loro() {
    let mut engine = LoroEngine::new();
    let block_id = "page-01";

    engine
        .apply_create_block(block_id, "page", "Hello", None, 0)
        .expect("create block");

    let read = engine
        .read_block(block_id)
        .expect("read block")
        .expect("block exists");

    assert_eq!(
        read,
        BlockSnapshot {
            block_id: block_id.into(),
            block_type: "page".into(),
            content: "Hello".into(),
            parent_id: None,
            // #400: `position` is the dense 1-based rank among siblings, not the
            // legacy meta value — a sole root child is rank 1.
            position: 1,
        }
    );
}
