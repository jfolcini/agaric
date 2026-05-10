//! Phase-1 day-1 smoke tests for the Loro production scaffold.
//!
//! Phase 3 day-9 retired the `loro-shadow` feature gate; these tests
//! now run as part of the default `cargo nextest run -p agaric` suite.
//!
//! Today's coverage is intentionally minimal: prove that the engine
//! survives a create-then-read round-trip.  The full corpus port
//! (~5 integration shapes from `merge/tests.rs`) and the proptest
//! augmentation are scheduled for later Phase-1 days per
//! SPIKE-REPORT.md §6 items 7-8.

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
            position: 0,
        }
    );
}
