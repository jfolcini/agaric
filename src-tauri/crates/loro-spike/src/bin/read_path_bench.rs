//! PEND-09 Phase 0 day-7 read-path benchmark (open question 8).
//!
//! The PEND-09 plan flags the materializer hot-path read cost from a Loro
//! doc as a risk: "If reads regress >10% vs current SQL-table reads,
//! redesign the read path before Phase 1 (e.g., keep SQL caches as the
//! materializer's read source, with Loro as the truth-of-state for sync
//! only)."
//!
//! Day-4's replay benchmark established Loro write throughput at
//! ~60K ops/sec.  The read-path question is independent: how fast can the
//! materializer **READ** from a populated Loro doc compared to SQL
//! indexed lookups?  This binary measures three read shapes against a
//! populated `LoroEngine` (~25K alive blocks, the same shape day-4
//! produced):
//!
//! - **(A) per-id `read_block` × 10K random ids.**  Single-block reads
//!   via the existing `LoroEngine::read_block` method.  Closest analogue
//!   to `SELECT … FROM blocks WHERE id = ?` — an O(log N) keyed lookup
//!   on the top-level `blocks` LoroMap.
//! - **(B) `list_children`-equivalent walk × 1K parents.**  For each of
//!   1K random parent ids, walk the blocks LoroMap and collect children
//!   whose `parent_id == requested`.  This is the **worst-case naïve
//!   query** because LoroMap doesn't index on `parent_id`; every walk
//!   visits all ~25K blocks.  Equivalent to `SELECT … FROM blocks WHERE
//!   parent_id = ?` without the `idx_blocks_parent_covering` index.
//! - **(C) property-key scan × 1K reads.**  For each of 1K random block
//!   ids, read a random property key.  Mirrors a property-table point
//!   lookup.
//!
//! Output: per-shape wall-clock total + average per-read.  No verdict
//! gate at run time — the comparison is qualitative because the spike
//! crate has no SQLite dep (and adding one would violate the spike's
//! "DO NOT pull in SQLite into the spike crate" constraint).  Results
//! are written into SPIKE-NOTES.md alongside the projected SQL band
//! (~10-100µs/read for indexed lookups based on the existing
//! `benches/pagination_bench.rs` shape).
//!
//! Constraints honoured:
//! - Loro stays at 1.12 (no Cargo.toml change).
//! - No production code touched.
//! - No SQLite dep added to the spike crate.
//! - Single-file bench (synthesis logic copied from replay_bench so the
//!   day-4 bench stays standalone — same convention all four benches
//!   follow).

use std::time::Instant;

use anyhow::{Context, Result};
use loro_spike::LoroEngine;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// Same seed as replay_bench so the bootstrapped doc is byte-identical
/// to the day-4 reference run (~25 145 alive blocks at 100K ops).
const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// 100K ops gets us to ~25K alive blocks — see day-4 SPIKE-NOTES.
const BOOTSTRAP_OPS: usize = 100_000;

/// Page-root pool size, matches replay_bench.
const PAGE_ROOTS: usize = 16;

/// Shape (A): `read_block` calls.
const READ_BLOCK_COUNT: usize = 10_000;

/// Shape (B): `list_children`-equivalent walks.  Each walk scans all
/// ~25K blocks; 1K walks at ~25K blocks/walk = ~25M visit operations.
const LIST_CHILDREN_COUNT: usize = 1_000;

/// Shape (C): property-key reads.
const READ_PROPERTY_COUNT: usize = 1_000;

/// Property keys that the synth path actually writes (see PROPERTY_KEYS
/// below).  Reads draw from this set so we hit existing keys often
/// enough to exercise the populated path.
const READ_PROPERTY_KEYS: &[&str] = &["priority", "todo_state", "due_date", "scheduled_date"];

// ---------------------------------------------------------------------------
// xorshift* — same generator as replay_bench so the bootstrap stream is
// reproducible.  The "different file lifecycle" rationale that
// commit_cadence_bench.rs called out for cloning still applies.
// ---------------------------------------------------------------------------

struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        let s = if seed == 0 {
            0xDEAD_BEEF_CAFE_BABE
        } else {
            seed
        };
        Self { state: s }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn next_index(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % (n as u64)) as usize
    }
}

// ---------------------------------------------------------------------------
// Op shape + workload — copied from replay_bench so this bench stays
// standalone (same convention as commit_cadence_bench).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Op {
    Create {
        block_id: String,
        parent_id: String,
        position: i64,
        content: String,
    },
    Edit {
        target: String,
        offset: usize,
        delete_len: usize,
        replacement: String,
    },
    SetProperty {
        target: String,
        key: &'static str,
        value: &'static str,
    },
    Move {
        target: String,
        new_parent: String,
        new_position: i64,
    },
    Delete {
        target: String,
    },
}

struct Workload {
    block_ids: Vec<String>,
    content_lens: Vec<Option<usize>>,
    page_roots: Vec<String>,
}

impl Workload {
    fn new(page_roots: Vec<String>) -> Self {
        Self {
            block_ids: Vec::with_capacity(BOOTSTRAP_OPS / 3),
            content_lens: Vec::with_capacity(BOOTSTRAP_OPS / 3),
            page_roots,
        }
    }

    fn pick_live(&self, rng: &mut XorShift64) -> Option<usize> {
        let n = self.block_ids.len();
        if n == 0 {
            return None;
        }
        let start = rng.next_index(n);
        for offset in 0..n {
            let idx = (start + offset) % n;
            if self.content_lens[idx].is_some() {
                return Some(idx);
            }
        }
        None
    }
}

const PROPERTY_KEYS: &[&str] = &["priority", "todo_state", "due_date", "scheduled_date"];
const PROPERTY_VALUES: &[&str] = &[
    "high",
    "medium",
    "low",
    "todo",
    "doing",
    "done",
    "2026-05-09",
    "2026-06-01",
];
const EDIT_REPLACEMENTS: &[&str] = &[
    "fix", "tweak ", "edit", "x", " more", " text ", "!", "TODO ", "ok", " note",
];

fn next_op(rng: &mut XorShift64, workload: &Workload, op_index: usize) -> Option<Op> {
    let dice = rng.next_index(100);
    let kind: u8 = if dice < 30 {
        0
    } else if dice < 80 {
        1
    } else if dice < 90 {
        2
    } else if dice < 95 {
        3
    } else {
        4
    };

    let kind = if kind != 0 && workload.pick_live(&mut XorShift64::new(0x1)).is_none() {
        0
    } else {
        kind
    };

    match kind {
        0 => {
            let block_id = format!("BLK_{:08}", op_index);
            let parent_idx = rng.next_index(workload.page_roots.len());
            let parent_id = workload.page_roots[parent_idx].clone();
            let position = rng.next_u64() as i64;
            let content = format!("block #{}", op_index);
            Some(Op::Create {
                block_id,
                parent_id,
                position,
                content,
            })
        }
        1 => {
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            let len = workload.content_lens[target_idx].expect("live block has Some(len)");
            let offset = if len == 0 { 0 } else { rng.next_index(len + 1) };
            let max_delete = (len - offset).min(4);
            let delete_len = if max_delete == 0 {
                0
            } else {
                rng.next_index(max_delete + 1)
            };
            let replacement =
                EDIT_REPLACEMENTS[rng.next_index(EDIT_REPLACEMENTS.len())].to_string();
            Some(Op::Edit {
                target,
                offset,
                delete_len,
                replacement,
            })
        }
        2 => {
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            let key = PROPERTY_KEYS[rng.next_index(PROPERTY_KEYS.len())];
            let value = PROPERTY_VALUES[rng.next_index(PROPERTY_VALUES.len())];
            Some(Op::SetProperty { target, key, value })
        }
        3 => {
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            let new_parent_idx = rng.next_index(workload.page_roots.len());
            let new_parent = workload.page_roots[new_parent_idx].clone();
            let new_position = rng.next_u64() as i64;
            Some(Op::Move {
                target,
                new_parent,
                new_position,
            })
        }
        4 => {
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            Some(Op::Delete { target })
        }
        _ => unreachable!(),
    }
}

fn apply_op(engine: &mut LoroEngine, workload: &mut Workload, op: &Op) -> Result<()> {
    match op {
        Op::Create {
            block_id,
            parent_id,
            position,
            content,
        } => {
            engine
                .apply_create_block(block_id, "text", content, Some(parent_id), *position)
                .with_context(|| format!("create {block_id}"))?;
            workload.block_ids.push(block_id.clone());
            workload.content_lens.push(Some(content.chars().count()));
            Ok(())
        }
        Op::Edit {
            target,
            offset,
            delete_len,
            replacement,
        } => {
            engine
                .apply_edit_content(target, *offset, *delete_len, replacement)
                .with_context(|| format!("edit {target}"))?;
            if let Some(pos) = workload.block_ids.iter().position(|id| id == target) {
                if let Some(len_slot) = workload.content_lens.get_mut(pos) {
                    if let Some(len) = len_slot {
                        let new_len = *len - *delete_len + replacement.chars().count();
                        *len = new_len;
                    }
                }
            }
            Ok(())
        }
        Op::SetProperty { target, key, value } => {
            engine
                .apply_set_property(target, key, Some(value))
                .with_context(|| format!("set_property {target}/{key}"))?;
            Ok(())
        }
        Op::Move {
            target,
            new_parent,
            new_position,
        } => {
            engine
                .apply_move_block(target, Some(new_parent), *new_position)
                .with_context(|| format!("move {target}"))?;
            Ok(())
        }
        Op::Delete { target } => {
            engine
                .apply_delete_block(target)
                .with_context(|| format!("delete {target}"))?;
            if let Some(pos) = workload.block_ids.iter().position(|id| id == target) {
                if let Some(len_slot) = workload.content_lens.get_mut(pos) {
                    *len_slot = None;
                }
            }
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    let overall_start = Instant::now();

    println!("PEND-09 Phase 0 day-7 read-path benchmark");
    println!("==========================================");
    println!("seed                = 0x{:016x}", SEED);
    println!("bootstrap ops       = {BOOTSTRAP_OPS}");
    println!("page roots          = {PAGE_ROOTS}");
    println!("shape A (read_block)        = {READ_BLOCK_COUNT} reads");
    println!("shape B (list_children)     = {LIST_CHILDREN_COUNT} parent walks");
    println!("shape C (read_property)     = {READ_PROPERTY_COUNT} reads");
    println!();

    // 1. Bootstrap: 16 page roots + 100K-op replay = ~25K alive blocks.
    //    Identical shape to day-4 replay_bench so the populated doc is
    //    byte-comparable to the day-4 reference run.
    let bootstrap_start = Instant::now();
    let mut engine = LoroEngine::new();
    let mut page_roots = Vec::with_capacity(PAGE_ROOTS);
    for i in 0..PAGE_ROOTS {
        let id = format!("PAGE_{:04}", i);
        engine
            .apply_create_block(&id, "page", &format!("Page {i}"), None, i as i64 * 10_000)
            .with_context(|| format!("bootstrap page {id}"))?;
        page_roots.push(id);
    }

    let mut rng = XorShift64::new(SEED);
    let mut workload = Workload::new(page_roots.clone());
    let mut created_ids: Vec<String> = Vec::new();
    for op_index in 0..BOOTSTRAP_OPS {
        let op = match next_op(&mut rng, &workload, op_index) {
            Some(o) => o,
            None => continue,
        };
        if let Op::Create { block_id, .. } = &op {
            created_ids.push(block_id.clone());
        }
        apply_op(&mut engine, &mut workload, &op)
            .with_context(|| format!("apply op #{op_index}"))?;
    }
    let bootstrap_elapsed = bootstrap_start.elapsed();
    let alive = engine.count_alive_blocks()?;
    println!(
        "bootstrap done: {} ops applied in {:.3}s, alive blocks = {alive}, created ids = {}",
        BOOTSTRAP_OPS,
        bootstrap_elapsed.as_secs_f64(),
        created_ids.len(),
    );
    println!();

    // ---- Shape A: read_block × 10K -------------------------------------
    //
    // Pre-pick the sample so the timed region contains only Loro reads,
    // not RNG draws + Vec indexing.  The same RNG strategy as the
    // verification phase in replay_bench: separate RNG seed so the read
    // sample is reproducible without coupling to the bootstrap stream.
    let mut sample_rng = XorShift64::new(SEED ^ 0xA77E_AD7E_AD7E_AD7E);
    let read_block_targets: Vec<String> = (0..READ_BLOCK_COUNT)
        .map(|_| {
            let idx = sample_rng.next_index(created_ids.len());
            created_ids[idx].clone()
        })
        .collect();

    let shape_a_start = Instant::now();
    let mut shape_a_hits = 0usize;
    let mut shape_a_misses = 0usize;
    for id in &read_block_targets {
        match engine.read_block(id)? {
            Some(_) => shape_a_hits += 1,
            None => shape_a_misses += 1,
        }
    }
    let shape_a_elapsed = shape_a_start.elapsed();
    let shape_a_per = shape_a_elapsed / READ_BLOCK_COUNT as u32;
    println!("---- shape (A): read_block × {READ_BLOCK_COUNT} ----");
    println!(
        "  total elapsed = {:.3}s   ({:>7.2} µs/read)",
        shape_a_elapsed.as_secs_f64(),
        shape_a_per.as_secs_f64() * 1_000_000.0,
    );
    println!(
        "  hits = {shape_a_hits}, misses = {shape_a_misses} (some sampled ids may have been deleted)"
    );
    println!();

    // ---- Shape B: list_children-equivalent walk × 1K parents -----------
    //
    // Walk the LoroMap once per parent_id, filtering by parent_id +
    // deleted_at.  Pre-pick the parent ids the same way; mostly the
    // PAGE_ROOT pool because that's what the synthesizer uses as parents
    // for nearly every create.  Mixing in a few BLK_ ids tests the
    // empty-result path (synthesizer never reparents under a BLK_ id).
    let parent_targets: Vec<String> = (0..LIST_CHILDREN_COUNT)
        .map(|_| {
            // Roughly 90% page roots, 10% BLK_ to get a mix.
            if sample_rng.next_index(10) == 0 && !created_ids.is_empty() {
                let idx = sample_rng.next_index(created_ids.len());
                created_ids[idx].clone()
            } else {
                let idx = sample_rng.next_index(page_roots.len());
                page_roots[idx].clone()
            }
        })
        .collect();

    let shape_b_start = Instant::now();
    let mut shape_b_total_children = 0usize;
    for parent in &parent_targets {
        let children = engine.list_children_walk(parent)?;
        shape_b_total_children += children.len();
    }
    let shape_b_elapsed = shape_b_start.elapsed();
    let shape_b_per = shape_b_elapsed / LIST_CHILDREN_COUNT as u32;
    println!("---- shape (B): list_children-walk × {LIST_CHILDREN_COUNT} parents ----");
    println!(
        "  total elapsed = {:.3}s   ({:>7.2} ms/walk = {:>7.2} µs/walk)",
        shape_b_elapsed.as_secs_f64(),
        shape_b_per.as_secs_f64() * 1_000.0,
        shape_b_per.as_secs_f64() * 1_000_000.0,
    );
    println!(
        "  total children visited = {shape_b_total_children} (avg {:.1} children/parent)",
        shape_b_total_children as f64 / LIST_CHILDREN_COUNT as f64,
    );
    println!();

    // ---- Shape C: read_property × 1K ----------------------------------
    let property_targets: Vec<(String, &'static str)> = (0..READ_PROPERTY_COUNT)
        .map(|_| {
            let idx = sample_rng.next_index(created_ids.len());
            let key = READ_PROPERTY_KEYS[sample_rng.next_index(READ_PROPERTY_KEYS.len())];
            (created_ids[idx].clone(), key)
        })
        .collect();

    let shape_c_start = Instant::now();
    let mut shape_c_set = 0usize;
    let mut shape_c_unset = 0usize;
    let mut shape_c_explicit_null = 0usize;
    for (block_id, key) in &property_targets {
        match engine.read_property(block_id, key)? {
            None => shape_c_unset += 1,
            Some(None) => shape_c_explicit_null += 1,
            Some(Some(_)) => shape_c_set += 1,
        }
    }
    let shape_c_elapsed = shape_c_start.elapsed();
    let shape_c_per = shape_c_elapsed / READ_PROPERTY_COUNT as u32;
    println!("---- shape (C): read_property × {READ_PROPERTY_COUNT} ----");
    println!(
        "  total elapsed = {:.3}s   ({:>7.2} µs/read)",
        shape_c_elapsed.as_secs_f64(),
        shape_c_per.as_secs_f64() * 1_000_000.0,
    );
    println!(
        "  set = {shape_c_set}, explicit-null = {shape_c_explicit_null}, unset = {shape_c_unset}"
    );
    println!();

    // ---- Headline summary ---------------------------------------------------
    println!("---- summary table ----");
    println!("| shape                              | reads   | total       | per-read     |");
    println!("| ---------------------------------- | ------- | ----------- | ------------ |");
    println!(
        "| (A) read_block (single id)         | {:>7} | {:>7.3}s    | {:>7.2} µs   |",
        READ_BLOCK_COUNT,
        shape_a_elapsed.as_secs_f64(),
        shape_a_per.as_secs_f64() * 1_000_000.0,
    );
    println!(
        "| (B) list_children-walk (per parent)| {:>7} | {:>7.3}s    | {:>7.2} ms   |",
        LIST_CHILDREN_COUNT,
        shape_b_elapsed.as_secs_f64(),
        shape_b_per.as_secs_f64() * 1_000.0,
    );
    println!(
        "| (C) read_property (block_id,key)   | {:>7} | {:>7.3}s    | {:>7.2} µs   |",
        READ_PROPERTY_COUNT,
        shape_c_elapsed.as_secs_f64(),
        shape_c_per.as_secs_f64() * 1_000_000.0,
    );
    println!();

    println!("---- comparison band (qualitative) ----");
    println!("Indexed SQL reads on a warm SQLite WAL-mode pool (existing");
    println!("`benches/pagination_bench.rs` shape): typically 10-100µs per row");
    println!("for `SELECT … WHERE id = ?` and `SELECT … WHERE parent_id = ?`");
    println!("with the `idx_blocks_parent_covering` index.  Property table");
    println!("point lookups land in the same band.  Absolute SQL numbers are");
    println!("not measured from this spike crate (no SQLite dep, by design).");
    println!();

    println!(
        "total wall-clock (incl. bootstrap) = {:.3}s",
        overall_start.elapsed().as_secs_f64()
    );

    Ok(())
}
