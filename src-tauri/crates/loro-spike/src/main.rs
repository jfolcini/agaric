//! PEND-09 Phase 0 spike — day-1 smoke binary.
//!
//! Runs `apply_create_block` for a page + two children, reads them back,
//! verifies field-by-field equality, then exports the doc as a snapshot
//! and prints its byte size.  No assertions on the byte size yet — the
//! point is to have a number we can watch as the spike grows.

use anyhow::{anyhow, Result};
use loro_spike::{BlockSnapshot, LoroEngine};

fn main() -> Result<()> {
    let mut engine = LoroEngine::new();

    // Three blocks: one page + two children pointing at it.  Mirrors the
    // shape the real materializer sees on first page-creation.
    let page_id = "01HQXAMPLEPAGE0000000000000";
    let child_a = "01HQXAMPLECHILD000000000001";
    let child_b = "01HQXAMPLECHILD000000000002";

    engine.apply_create_block(page_id, "page", "Spike Page", None, 0)?;
    engine.apply_create_block(child_a, "text", "first child line", Some(page_id), 1_000)?;
    engine.apply_create_block(child_b, "text", "second child line", Some(page_id), 2_000)?;

    let expected = [
        BlockSnapshot {
            block_id: page_id.to_string(),
            block_type: "page".into(),
            content: "Spike Page".into(),
            parent_id: None,
            position: 0,
        },
        BlockSnapshot {
            block_id: child_a.to_string(),
            block_type: "text".into(),
            content: "first child line".into(),
            parent_id: Some(page_id.to_string()),
            position: 1_000,
        },
        BlockSnapshot {
            block_id: child_b.to_string(),
            block_type: "text".into(),
            content: "second child line".into(),
            parent_id: Some(page_id.to_string()),
            position: 2_000,
        },
    ];

    for want in &expected {
        let got = engine
            .read_block(&want.block_id)?
            .ok_or_else(|| anyhow!("block {} not found after insert", want.block_id))?;
        if got != *want {
            return Err(anyhow!(
                "round-trip mismatch for {}:\n  want = {:?}\n  got  = {:?}",
                want.block_id,
                want,
                got
            ));
        }
    }

    let bytes = engine.export_snapshot()?;
    println!(
        "Phase 0 spike day 1: round-trip OK, doc size = {} bytes",
        bytes.len()
    );

    Ok(())
}
