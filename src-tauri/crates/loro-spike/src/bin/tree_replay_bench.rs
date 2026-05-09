//! PEND-09 Phase 0 day-5 — head-to-head benchmark: `TreeEngine` vs
//! `LoroEngine`.
//!
//! Same shape as `replay_bench.rs` (day-4) — same SEED, same op-mix,
//! same op-stream — but applied through `TreeEngine` (the LoroTree-shaped
//! mirror).  Output is the same metric set so the day-4 vs day-5 numbers
//! diff cleanly:
//!
//! - wall-clock for the apply loop,
//! - final snapshot byte size,
//! - alive block count,
//! - peak Linux RSS.
//!
//! See `SPIKE-NOTES.md` Day 5 for the head-to-head comparison table and
//! the recommendation that follows.

use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use loro_spike::TreeEngine;

const SEED: u64 = 0x9E37_79B9_7F4A_7C15;
const TOTAL_OPS: usize = 100_000;
const COMMIT_EVERY: usize = 1_000;
const PAGE_ROOTS: usize = 16;
const RSS_SAMPLE_EVERY: usize = 10_000;
const VERIFY_SAMPLE_SIZE: usize = 100;

// xorshift* — SAME implementation as `replay_bench.rs` so the op stream
// it produces with the same seed is byte-for-byte identical.  Don't
// touch unless you also touch the day-4 binary.
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

fn read_rss_bytes() -> Result<Option<usize>> {
    if cfg!(not(target_os = "linux")) {
        return Ok(None);
    }
    let contents = match std::fs::read_to_string("/proc/self/statm") {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let mut iter = contents.split_ascii_whitespace();
    let _size = iter
        .next()
        .ok_or_else(|| anyhow!("statm: missing size field"))?;
    let resident_pages: usize = iter
        .next()
        .ok_or_else(|| anyhow!("statm: missing resident field"))?
        .parse()
        .with_context(|| "statm: resident not a usize")?;
    let page_size: usize = 4_096;
    Ok(Some(resident_pages * page_size))
}

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

fn apply_op(engine: &mut TreeEngine, workload: &mut Workload, op: &Op) -> Result<()> {
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

fn replay_for_ids(seed: u64, page_roots: &[String]) -> (Vec<String>, Vec<String>) {
    let mut rng = XorShift64::new(seed);
    let mut workload = Workload::new(page_roots.to_vec());
    let mut created: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    for op_index in 0..TOTAL_OPS {
        let Some(op) = next_op(&mut rng, &workload, op_index) else {
            continue;
        };
        match &op {
            Op::Create {
                block_id, content, ..
            } => {
                workload.block_ids.push(block_id.clone());
                workload.content_lens.push(Some(content.chars().count()));
                created.push(block_id.clone());
            }
            Op::Edit {
                target,
                delete_len,
                replacement,
                ..
            } => {
                if let Some(pos) = workload.block_ids.iter().position(|id| id == target) {
                    if let Some(slot) = workload.content_lens.get_mut(pos) {
                        if let Some(l) = slot {
                            *l = *l - *delete_len + replacement.chars().count();
                        }
                    }
                }
            }
            Op::SetProperty { .. } | Op::Move { .. } => {}
            Op::Delete { target } => {
                if let Some(pos) = workload.block_ids.iter().position(|id| id == target) {
                    if let Some(slot) = workload.content_lens.get_mut(pos) {
                        *slot = None;
                    }
                }
                deleted.push(target.clone());
            }
        }
    }
    (created, deleted)
}

fn main() -> Result<()> {
    let overall_start = Instant::now();

    println!("PEND-09 Phase 0 day-5 TREE-ENGINE replay benchmark");
    println!("===================================================");
    println!("seed                = 0x{:016x}", SEED);
    println!("total ops           = {TOTAL_OPS}");
    println!("commit cadence (K)  = {COMMIT_EVERY}");
    println!("page roots          = {PAGE_ROOTS}");
    println!("rss sample every    = {RSS_SAMPLE_EVERY} ops");
    println!();

    let mut engine = TreeEngine::new();
    let mut page_roots = Vec::with_capacity(PAGE_ROOTS);
    for i in 0..PAGE_ROOTS {
        let id = format!("PAGE_{:04}", i);
        engine
            .apply_create_block(&id, "page", &format!("Page {i}"), None, i as i64 * 10_000)
            .with_context(|| format!("bootstrap page {id}"))?;
        page_roots.push(id);
    }
    let bootstrap_alive = engine.count_alive_blocks()?;
    println!(
        "bootstrap: {} pages created, alive count = {bootstrap_alive}",
        page_roots.len()
    );

    let mut peak_rss: Option<usize> = None;
    let rss_start = read_rss_bytes()?;
    if let Some(rss) = rss_start {
        peak_rss = Some(peak_rss.map_or(rss, |p| p.max(rss)));
    }
    println!("rss at start         = {}", fmt_rss(rss_start));

    let mut rng = XorShift64::new(SEED);
    let mut workload = Workload::new(page_roots.clone());

    let mut count_create = 0usize;
    let mut count_edit = 0usize;
    let mut count_set_property = 0usize;
    let mut count_move = 0usize;
    let mut count_delete = 0usize;

    let apply_start = Instant::now();
    for op_index in 0..TOTAL_OPS {
        let op = match next_op(&mut rng, &workload, op_index) {
            Some(o) => o,
            None => continue,
        };
        match &op {
            Op::Create { .. } => count_create += 1,
            Op::Edit { .. } => count_edit += 1,
            Op::SetProperty { .. } => count_set_property += 1,
            Op::Move { .. } => count_move += 1,
            Op::Delete { .. } => count_delete += 1,
        }
        apply_op(&mut engine, &mut workload, &op)
            .with_context(|| format!("apply op #{op_index}"))?;

        if (op_index + 1) % COMMIT_EVERY == 0 {
            // No-op against an already-committed state.
        }

        if (op_index + 1) % RSS_SAMPLE_EVERY == 0 {
            let now = read_rss_bytes()?;
            if let Some(rss) = now {
                peak_rss = Some(peak_rss.map_or(rss, |p| p.max(rss)));
            }
            let elapsed = apply_start.elapsed();
            println!(
                "  [{:>7} ops]  elapsed = {:>8.2}s  rss = {}  peak = {}",
                op_index + 1,
                elapsed.as_secs_f64(),
                fmt_rss(now),
                fmt_rss(peak_rss),
            );
        }
    }
    let apply_elapsed = apply_start.elapsed();

    let rss_end = read_rss_bytes()?;
    if let Some(rss) = rss_end {
        peak_rss = Some(peak_rss.map_or(rss, |p| p.max(rss)));
    }

    let snapshot = engine.export_snapshot()?;
    let alive_count = engine.count_alive_blocks()?;

    println!();
    println!("---- replay complete ----");
    println!("op-mix actual      : create={count_create} edit={count_edit} set_property={count_set_property} move={count_move} delete={count_delete}");
    println!(
        "apply elapsed      = {:.3}s ({:.3} min)",
        apply_elapsed.as_secs_f64(),
        apply_elapsed.as_secs_f64() / 60.0
    );
    println!(
        "doc snapshot bytes = {} ({:.2} MiB)",
        snapshot.len(),
        snapshot.len() as f64 / 1_048_576.0
    );
    println!("alive blocks       = {alive_count}");
    println!("rss at end         = {}", fmt_rss(rss_end));
    println!("peak rss           = {}", fmt_rss(peak_rss));

    let expected_alive = bootstrap_alive + count_create - count_delete;
    if alive_count != expected_alive {
        eprintln!(
            "WARNING: alive_count ({alive_count}) != bootstrap+creates-deletes ({expected_alive})"
        );
    } else {
        println!("alive sanity check : OK ({bootstrap_alive} bootstrap + {count_create} creates - {count_delete} deletes = {expected_alive})");
    }

    println!();
    println!("---- verification ----");
    let (all_creates, all_deletes) = replay_for_ids(SEED, &page_roots);
    println!(
        "synthesised creates = {}, deletes = {}",
        all_creates.len(),
        all_deletes.len()
    );

    let mut sample_rng = XorShift64::new(SEED ^ 0xDEAD_BEEF);
    let sample_size = VERIFY_SAMPLE_SIZE.min(all_creates.len());
    let mut readable = 0usize;
    let mut errors = 0usize;
    for _ in 0..sample_size {
        let idx = sample_rng.next_index(all_creates.len());
        let id = &all_creates[idx];
        match engine.read_block(id) {
            Ok(Some(_)) => readable += 1,
            Ok(None) => {
                errors += 1;
                eprintln!("VERIFY FAIL: block {id} not found");
            }
            Err(e) => {
                errors += 1;
                eprintln!("VERIFY ERR: block {id}: {e}");
            }
        }
    }
    println!("sample creates: {readable}/{sample_size} readable, {errors} errors");

    let delete_sample = (20).min(all_deletes.len());
    let mut delete_ok = 0usize;
    for _ in 0..delete_sample {
        let idx = sample_rng.next_index(all_deletes.len());
        let id = &all_deletes[idx];
        match engine.read_deleted(id) {
            Ok(true) => delete_ok += 1,
            Ok(false) => eprintln!("VERIFY FAIL: deleted block {id} not marked deleted"),
            Err(e) => eprintln!("VERIFY ERR: read_deleted({id}): {e}"),
        }
    }
    println!("sample deletes: {delete_ok}/{delete_sample} confirmed deleted");

    println!();
    println!(
        "total wall-clock (incl. bootstrap + verify) = {:.3}s",
        overall_start.elapsed().as_secs_f64()
    );

    if errors > 0 {
        std::process::exit(1);
    }
    Ok(())
}

fn fmt_rss(rss: Option<usize>) -> String {
    match rss {
        None => "n/a".to_string(),
        Some(n) => format!("{} bytes ({:.2} MiB)", n, n as f64 / 1_048_576.0),
    }
}
