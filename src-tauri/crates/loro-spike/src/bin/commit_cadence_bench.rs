//! PEND-09 Phase 0 day-6 commit-cadence benchmark (open question 6).
//!
//! Day-1's `apply_*` methods all call `doc.commit()` after every op.
//! Day-4's replay benchmark inherited that and the K=1000 batching layer
//! it tried to add was a no-op (because Loro had nothing pending — the
//! per-op `apply_*` already flushed).  Day 6 measures the actual
//! commit-cadence trade-off by going through the new `apply_*_no_commit`
//! helpers and driving `LoroEngine::commit()` from the bench loop.
//!
//! Workload: same xorshift*-driven 30/50/10/5/5 op mix as the day-4
//! replay bench, but at 10K ops (not 100K — the question is qualitative;
//! 10K is plenty to surface a multi-x cadence delta if there is one).
//!
//! Cadences measured (`COMMIT_EVERY` aka K):
//!
//! | K | Description |
//! | -------- | ------- |
//! | 1 | Per-op commit (today's default behaviour) |
//! | 10 | One commit every 10 ops |
//! | 1000 | Coarse batching |
//! | 10000 | One single commit at the end |
//!
//! Output: 4-row table with wall-clock + final snapshot bytes for each.
//!
//! Constraints: Loro stays at 1.12, no production code touched, no new
//! deps, single-file bench.
//!
//! See SPIKE-NOTES.md ("Day 6 / Commit cadence") for the trade-off
//! discussion + recommendation.

use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use loro_spike::LoroEngine;

const SEED: u64 = 0x9E37_79B9_7F4A_7C15;
const TOTAL_OPS: usize = 10_000;
const PAGE_ROOTS: usize = 16;

const CADENCES: &[usize] = &[1, 10, 1_000, 10_000];

// ---------------------------------------------------------------------------
// xorshift* RNG — cloned from replay_bench (different file lifecycle, no
// dependency to share).  Keeps the bench standalone.
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
// Op shape + workload, mirroring replay_bench but using *_no_commit
// variants of LoroEngine.
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
            block_ids: Vec::with_capacity(TOTAL_OPS / 3),
            content_lens: Vec::with_capacity(TOTAL_OPS / 3),
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

/// Apply via the *_no_commit variants — caller owns the commit cadence.
fn apply_op_no_commit(engine: &mut LoroEngine, workload: &mut Workload, op: &Op) -> Result<()> {
    match op {
        Op::Create {
            block_id,
            parent_id,
            position,
            content,
        } => {
            engine
                .apply_create_block_no_commit(block_id, "text", content, Some(parent_id), *position)
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
                .apply_edit_content_no_commit(target, *offset, *delete_len, replacement)
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
                .apply_set_property_no_commit(target, key, Some(value))
                .with_context(|| format!("set_property {target}/{key}"))?;
            Ok(())
        }
        Op::Move {
            target,
            new_parent,
            new_position,
        } => {
            engine
                .apply_move_block_no_commit(target, Some(new_parent), *new_position)
                .with_context(|| format!("move {target}"))?;
            Ok(())
        }
        Op::Delete { target } => {
            engine
                .apply_delete_block_no_commit(target)
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

/// One run of the workload at a given commit cadence.  Returns
/// `(elapsed_secs, snapshot_bytes, alive_count)`.
///
/// The bootstrap (16 page roots) is OUTSIDE the timed region — we want
/// to measure steady-state apply throughput, not the one-off setup.  All
/// page-root creates use the no-commit variant + a single commit at the
/// end of bootstrap so the doc is in a clean state when timing starts.
fn run_at_cadence(commit_every: usize) -> Result<(f64, usize, usize)> {
    let mut engine = LoroEngine::new();

    // Bootstrap page roots, untimed.
    let mut page_roots = Vec::with_capacity(PAGE_ROOTS);
    for i in 0..PAGE_ROOTS {
        let id = format!("PAGE_{:04}", i);
        engine
            .apply_create_block_no_commit(
                &id,
                "page",
                &format!("Page {i}"),
                None,
                i as i64 * 10_000,
            )
            .with_context(|| format!("bootstrap page {id}"))?;
        page_roots.push(id);
    }
    engine.commit();

    let mut rng = XorShift64::new(SEED);
    let mut workload = Workload::new(page_roots);

    let start = Instant::now();
    for op_index in 0..TOTAL_OPS {
        let Some(op) = next_op(&mut rng, &workload, op_index) else {
            continue;
        };
        apply_op_no_commit(&mut engine, &mut workload, &op)
            .with_context(|| format!("apply op #{op_index}"))?;
        if (op_index + 1) % commit_every == 0 {
            engine.commit();
        }
    }
    // Flush whatever's left pending so the snapshot reflects every op.
    engine.commit();
    let elapsed = start.elapsed().as_secs_f64();

    let snapshot = engine
        .export_snapshot()
        .map_err(|e| anyhow!("export_snapshot: {e}"))?;
    let alive = engine
        .count_alive_blocks()
        .map_err(|e| anyhow!("count_alive_blocks: {e}"))?;

    Ok((elapsed, snapshot.len(), alive))
}

fn main() -> Result<()> {
    println!("PEND-09 Phase 0 day-6 commit-cadence benchmark");
    println!("===============================================");
    println!("seed       = 0x{:016x}", SEED);
    println!("total ops  = {TOTAL_OPS}");
    println!("page roots = {PAGE_ROOTS} (untimed bootstrap)");
    println!();

    let mut rows = Vec::new();
    for &k in CADENCES {
        let (elapsed, snapshot_bytes, alive) = run_at_cadence(k)?;
        rows.push((k, elapsed, snapshot_bytes, alive));
    }

    println!(
        "| {:>9} | {:>13} | {:>17} | {:>13} |",
        "K (every)", "wall-clock (s)", "snapshot bytes", "alive blocks"
    );
    println!("| {:->9} | {:->13} | {:->17} | {:->13} |", "", "", "", "");
    for (k, elapsed, bytes, alive) in &rows {
        let label = if *k == 1 {
            "1 (per-op)".to_string()
        } else if *k >= TOTAL_OPS {
            format!("{} (1×end)", k)
        } else {
            format!("{}", k)
        };
        println!(
            "| {:>9} | {:>13.3} | {:>17} | {:>13} |",
            label, elapsed, bytes, alive
        );
    }
    println!();

    // Quick relative-cost callout for the recommendation in SPIKE-NOTES.
    let baseline = rows[0].1;
    println!("Speed-up vs per-op (K=1) baseline:");
    for (k, elapsed, _, _) in &rows {
        let speedup = baseline / *elapsed;
        let label = if *k == 1 {
            "1 (per-op)".to_string()
        } else {
            format!("{}", k)
        };
        println!("  K = {:>10} : {:.2}×", label, speedup);
    }

    Ok(())
}
