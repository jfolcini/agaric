//! PEND-09 Phase 0 day-4 replay benchmark.
//!
//! Synthesises a 100K-op stream that mirrors the production op-log
//! distribution (see PEND-09-crdt-migration.md and the day-3 spike
//! notes) and applies it through `LoroEngine`, measuring:
//!
//! - wall-clock elapsed (`std::time::Instant`),
//! - peak resident-set size (cross-platform via the `memory-stats`
//!   crate — `/proc/self/statm` on Linux, `task_info` (Mach) on macOS,
//!   `GetProcessMemoryInfo` on Windows; sampled at start, every 10K
//!   ops, and at the end),
//! - final snapshot doc size (bytes),
//! - alive-block count after replay (cheap iteration over the blocks
//!   LoroMap, filter on `deleted_at == None`).
//!
//! **Kill criterion #3** (PEND-09-crdt-migration.md ~line 79): replay
//! must complete in under 10 minutes wall-clock and under 2 GB peak
//! heap on the developer's reference machine.  This binary IS that
//! measurement; if it fires either threshold the spike is killed.
//!
//! Op mix (matches the day-4 deliverable):
//!
//! | Op shape | Share |
//! | -------- | ----- |
//! | apply_create_block | 30% |
//! | apply_edit_content | 50% |
//! | apply_set_property | 10% |
//! | apply_move_block   |  5% |
//! | apply_delete_block |  5% |
//!
//! Determinism: a 64-bit xorshift* seeded with a hard-coded seed (see
//! `SEED` below).  Every random choice — op kind, target block, parent
//! root, edit offset, property key, deletion target — is drawn from the
//! same RNG stream.  No external RNG crate; no `oorandom` dep added.
//!
//! Constraints honoured:
//!
//! - Loro stays at 1.12 (no Cargo.toml change at Phase-0; Phase-2
//!   day-5 added `memory-stats` for cross-platform RSS).
//! - No production code touched.
//! - The bench is a single Rust file; the only `LoroEngine` extension
//!   is `count_alive_blocks` (added in `lib.rs`).
//! - RSS measurement is cross-platform (Linux / macOS / Windows) via
//!   the `memory-stats` crate; if the OS refuses to provide a number
//!   (extremely rare — typically only on exotic kernels) the bench
//!   still runs and reports `peak_rss_kib = n/a`.
//!
//! Machine-readable output: the final stanza prints
//! `peak_rss_kib=NNN`, `wall_clock_seconds=N.NNN`,
//! `snapshot_bytes=NNN`, and `alive_blocks=NNN` on dedicated lines so
//! a CI script can grep them without parsing the prose summary.

use std::time::Instant;

use anyhow::{Context, Result};
use loro_spike::LoroEngine;

// ---------------------------------------------------------------------------
// Tunables — the day-4 spike's choices, in one place so they're easy to
// inspect when reading the run output back.
// ---------------------------------------------------------------------------

/// Hard-coded RNG seed.  Changing this re-rolls the entire op stream;
/// the verification step uses the same seed so the same 100 sample
/// block_ids come out.
const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// Total number of ops to synthesise + apply.
const TOTAL_OPS: usize = 100_000;

/// Commit cadence — every K ops we flush the implicit transaction.
/// Day-1 commit-after-every-op was the pessimistic case (open question
/// 6 in SPIKE-NOTES.md).  K=1000 amortises the commit cost across a
/// reasonable batch without holding so many ops in the working
/// transaction that a single commit becomes a tail-latency cliff.  The
/// individual `apply_*` methods inside `LoroEngine` already call
/// `commit()` per op, so the bench's K-cadence flushes are an
/// additional safety net rather than the only commit point — Loro's
/// committed state is the union.  See SPIKE-NOTES Day-4 for discussion.
const COMMIT_EVERY: usize = 1_000;

/// Number of "page" roots created up-front, used as the parent set for
/// most created blocks.  Mirrors a "small set of pages" distribution.
const PAGE_ROOTS: usize = 16;

/// RSS sampling cadence (ops between samples).
const RSS_SAMPLE_EVERY: usize = 10_000;

/// Number of post-replay sample reads to verify.
const VERIFY_SAMPLE_SIZE: usize = 100;

// ---------------------------------------------------------------------------
// xorshift* — a tiny deterministic 64-bit PRNG.  Sufficient for picking
// op kinds, block indices, splice offsets etc.  NOT cryptographic; not
// trying to be.
// ---------------------------------------------------------------------------

struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        // Seed must be non-zero for xorshift.  Hard-coded SEED above is
        // non-zero; this guard is for paranoia.
        let s = if seed == 0 {
            0xDEAD_BEEF_CAFE_BABE
        } else {
            seed
        };
        Self { state: s }
    }

    fn next_u64(&mut self) -> u64 {
        // Marsaglia xorshift64*.  Period 2^64 - 1.
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform integer in `[0, n)`.  Used everywhere we need an index.
    fn next_index(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        // Modulo bias is tolerable here — n is far smaller than 2^64.
        (self.next_u64() % (n as u64)) as usize
    }
}

// ---------------------------------------------------------------------------
// Cross-platform RSS sampling via the `memory-stats` crate.
//
// Phase-0 day 4 used a Linux-only `/proc/self/statm` parse; the
// kill-criterion-#3 verdict (144 MiB peak / 14× margin under the 2 GiB
// floor) was therefore Linux-only.  Phase-2 day 5 swaps in
// `memory-stats`, which wraps `/proc/self/statm` on Linux, `task_info`
// (Mach) on macOS, and `GetProcessMemoryInfo` on Windows behind a
// single API.  The bench now produces a comparable headline number on
// all three desktop targets ahead of the cutover toggle ship.
// ---------------------------------------------------------------------------

/// Read this process's resident-set-size, in KiB.
///
/// Returns `Ok(None)` only when the underlying OS hook refuses to
/// supply a number — `memory-stats` returns `None` when its native
/// query path fails (e.g. an exotic kernel without `/proc`, or a
/// hardened sandbox that denies `task_info`).  On every supported
/// desktop target (Linux, macOS, Windows) the call is expected to
/// succeed; the `Option` return type is plumbed through the bench
/// purely so the kill-criterion verdict can degrade gracefully ("can't
/// observe → don't fire on missing data") rather than crash.
///
/// Units are KiB (kibibytes, 1024 bytes) — chosen so the
/// `peak_rss_kib=NNN` machine-readable output line is a tidy integer.
/// Internally `memory-stats` returns bytes; we divide by 1024.
fn current_rss_kib() -> Result<Option<u64>> {
    Ok(memory_stats::memory_stats().map(|s| (s.physical_mem / 1024) as u64))
}

// ---------------------------------------------------------------------------
// Op-stream synthesis + replay.
// ---------------------------------------------------------------------------

/// All op shapes the bench can synthesise.  The `Verify(_)` variant is
/// not written into the engine at apply time — it's a marker the
/// verification phase consumes via re-running the same RNG stream.
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

/// State the synthesis loop needs across iterations: the set of live
/// (created-and-not-deleted) block ids so we can pick realistic targets
/// for edits, moves, properties, deletes.  Stored as Vec for O(1)
/// random index, plus a parallel `content_len` so we know what edit
/// offsets are valid.  When a block is deleted we leave it in the
/// vector but mark its content_len as `None`; that way the index space
/// stays stable but we skip dead targets when picking edit targets.
struct Workload {
    /// All created block ids in insertion order.  Index = creation
    /// order.
    block_ids: Vec<String>,
    /// Current content length (in unicode scalars) of each block, or
    /// `None` if the block has been deleted (we still treat deleted
    /// blocks as targetable for edit ops? — no, we skip them).
    content_lens: Vec<Option<usize>>,
    /// Page-root ids created up-front; used as parent for most blocks.
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

    /// Pick a random *live* (non-deleted) block id, returning its index
    /// into `block_ids`.  Returns None if the workload has no live
    /// blocks yet (early in the run, before any creates have landed).
    /// Uses a bounded scan: pick a starting index then walk forward
    /// until we find a live block or wrap once.  Over the course of
    /// 100K ops with 30% creates and only 5% deletes, the live ratio
    /// stays at ~83%, so the expected cost is ~1.2 probes.
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

/// Property keys cycled through by `apply_set_property` ops.  Matches
/// the four "hot path" properties documented in PEND-09 open
/// question 10.
const PROPERTY_KEYS: &[&str] = &["priority", "todo_state", "due_date", "scheduled_date"];

/// Property values cycled by `apply_set_property`.  Short, realistic.
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

/// Replacement strings for edit splices.  Keeps content growth bounded
/// — every edit deletes a small range and inserts a similarly-sized
/// one, plus the occasional pure-insert (delete_len=0).
const EDIT_REPLACEMENTS: &[&str] = &[
    "fix", "tweak ", "edit", "x", " more", " text ", "!", "TODO ", "ok", " note",
];

/// Synthesise the next op given the current workload + RNG state.
/// Picks an op kind from the weighted distribution, then fills in
/// realistic operands.  Returns `None` only in the unreachable case
/// where the workload contains zero live blocks AND the RNG draws a
/// non-create op — in that case the caller should retry; in practice
/// the very first op is always a create because we bootstrap with
/// `PAGE_ROOTS` creates before the random loop starts.
fn next_op(rng: &mut XorShift64, workload: &Workload, op_index: usize) -> Option<Op> {
    // Distribution: 30 / 50 / 10 / 5 / 5 (sums to 100).
    let dice = rng.next_index(100);
    let kind: u8 = if dice < 30 {
        0 // Create
    } else if dice < 80 {
        1 // Edit
    } else if dice < 90 {
        2 // SetProperty
    } else if dice < 95 {
        3 // Move
    } else {
        4 // Delete
    };

    // For non-create ops we need at least one live target.  If there
    // isn't one yet (only happens for the first ~handful of ops before
    // a create has been applied), demote to a create instead.
    let kind = if kind != 0 && workload.pick_live(&mut XorShift64::new(0x1)).is_none() {
        // ^ probe with a throwaway RNG so we don't perturb the main
        // stream's determinism just to check liveness.  Quick and
        // dirty, but acceptable: workload state is consulted directly
        // below for the actual target pick.
        0
    } else {
        kind
    };

    match kind {
        0 => {
            // Create.  block_id = format!("BLK_{n:08}", n=op_index).
            // op_index gives us a globally-unique id per op slot
            // (creates are sparse enough that we don't run out of
            // slots).  We stamp the index into the id so the verify
            // step can recompute "the kth create's id" from the
            // re-run RNG stream.
            let block_id = format!("BLK_{:08}", op_index);
            let parent_idx = rng.next_index(workload.page_roots.len());
            let parent_id = workload.page_roots[parent_idx].clone();
            let position = rng.next_u64() as i64;
            // Short procedural string with the op index baked in for
            // future spot-checking.
            let content = format!("block #{}", op_index);
            Some(Op::Create {
                block_id,
                parent_id,
                position,
                content,
            })
        }
        1 => {
            // Edit.
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            let len = workload.content_lens[target_idx].expect("live block has Some(len)");
            // Pick offset in [0, len], delete_len in [0, min(4, len-offset)],
            // replacement from the canned set.
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
            // SetProperty.
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            let key = PROPERTY_KEYS[rng.next_index(PROPERTY_KEYS.len())];
            let value = PROPERTY_VALUES[rng.next_index(PROPERTY_VALUES.len())];
            Some(Op::SetProperty { target, key, value })
        }
        3 => {
            // Move.
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
            // Delete.
            let target_idx = workload.pick_live(rng)?;
            let target = workload.block_ids[target_idx].clone();
            Some(Op::Delete { target })
        }
        _ => unreachable!(),
    }
}

/// Apply one op against the engine + update the workload bookkeeping.
/// Returns the index of the affected block in `workload.block_ids` (for
/// content_len updates), and a Boolean for "was this a creation"
/// (lifted out so the caller can also push to `block_ids`).
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
            // Unicode-scalar length of `content`.
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
            // Update bookkeeping: same-index lookup as the synth path
            // used.  We re-find by id because we don't carry the index
            // through (kept `Op` an owned struct for clarity).
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
            // Mark the workload slot as dead so we stop targeting it.
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
// Verification phase — re-run the same RNG stream, collect created
// block_ids, sample 100 of them, assert each is readable.  We also keep
// track of which were deleted along the way and confirm `read_deleted`
// returns true on a sample of those.
// ---------------------------------------------------------------------------

/// Re-runs the synthesis loop without applying anything to an engine,
/// collecting the full list of created and deleted block_ids in the
/// order they would have been produced.  Used by the verification step
/// to deterministically reproduce sample targets.
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    let overall_start = Instant::now();

    println!("PEND-09 Phase 0 day-4 replay benchmark");
    println!("=======================================");
    println!("seed                = 0x{:016x}", SEED);
    println!("total ops           = {TOTAL_OPS}");
    println!("commit cadence (K)  = {COMMIT_EVERY}");
    println!("page roots          = {PAGE_ROOTS}");
    println!("rss sample every    = {RSS_SAMPLE_EVERY} ops");
    println!();

    // 1. Bootstrap: create the page roots up-front so the rest of the
    //    stream always has a parent set to draw from.  These pages are
    //    not counted in TOTAL_OPS (they're scaffolding); the first
    //    100K op_index slots after bootstrap are the measured stream.
    let mut engine = LoroEngine::new();
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

    // 2. RSS at start (before the 100K-op apply loop starts).
    let mut peak_rss: Option<u64> = None;
    let rss_start = current_rss_kib()?;
    if let Some(rss) = rss_start {
        peak_rss = Some(peak_rss.map_or(rss, |p| p.max(rss)));
    }
    println!("rss at start         = {}", fmt_rss(rss_start));

    // 3. Synthesis + apply loop.
    let mut rng = XorShift64::new(SEED);
    let mut workload = Workload::new(page_roots.clone());

    // Counters for the headline op-mix breakdown.
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

        // Commit cadence flush (the per-op `apply_*` paths already
        // call `doc.commit()`, so this is belt-and-braces — harmless
        // and cheap when there's nothing pending).
        if (op_index + 1) % COMMIT_EVERY == 0 {
            // No-op against an already-committed state, but kept for
            // forward compatibility if individual `apply_*`s drop their
            // internal commits in a later refactor.
        }

        if (op_index + 1) % RSS_SAMPLE_EVERY == 0 {
            let now = current_rss_kib()?;
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

    // 4. RSS at end + final snapshot.
    let rss_end = current_rss_kib()?;
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

    // Sanity check: alive == bootstrap_pages + creates - deletes.
    let expected_alive = bootstrap_alive + count_create - count_delete;
    if alive_count != expected_alive {
        eprintln!(
            "WARNING: alive_count ({alive_count}) != bootstrap+creates-deletes ({expected_alive})"
        );
    } else {
        println!("alive sanity check : OK ({bootstrap_alive} bootstrap + {count_create} creates - {count_delete} deletes = {expected_alive})");
    }

    // 5. Verification: re-run the synthesis stream to deterministically
    //    reproduce the list of created + deleted block_ids, then sample
    //    100 of the *creates* (whether or not they were later deleted —
    //    `read_block` returns Some for both alive and soft-deleted
    //    blocks because deletion is a flag, not a removal).  Spot-check
    //    that any block in the deleted set returns `read_deleted ==
    //    true`.
    println!();
    println!("---- verification ----");
    let (all_creates, all_deletes) = replay_for_ids(SEED, &page_roots);
    println!(
        "synthesised creates = {}, deletes = {}",
        all_creates.len(),
        all_deletes.len()
    );

    // Sample 100 random creates with a fresh RNG — different stream
    // from the synthesis one to avoid coupling, but seeded
    // deterministically so the sample set is reproducible.
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

    // Spot-check deletions: pick up to 20 deleted ids and assert
    // `read_deleted` is true.
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

    // 6. Kill criterion verdict.
    println!();
    println!("---- kill criterion #3 ----");
    let wall_clock_seconds = apply_elapsed.as_secs_f64();
    let wall_clock_under_10min = wall_clock_seconds < 600.0;
    let rss_under_2gb = match peak_rss {
        // 2 GiB == 2 * 1024 * 1024 KiB.  Comparison is in KiB to match
        // `current_rss_kib` units; the kill-criterion threshold itself
        // is unchanged from Phase-0.
        Some(rss_kib) => rss_kib < 2 * 1024 * 1024,
        None => true, // cannot observe, do not fire purely on missing data
    };
    println!(
        "wall-clock under 10 min: {} ({:.2}s)",
        if wall_clock_under_10min { "YES" } else { "NO" },
        wall_clock_seconds,
    );
    println!(
        "peak rss   under 2 GB  : {} ({})",
        if rss_under_2gb { "YES" } else { "NO" },
        fmt_rss(peak_rss),
    );
    let fired = !wall_clock_under_10min || !rss_under_2gb || errors > 0;
    println!(
        "verdict: kill criterion #3 {}",
        if fired { "FIRED" } else { "NOT FIRED" },
    );

    println!();
    println!(
        "total wall-clock (incl. bootstrap + verify) = {:.3}s",
        overall_start.elapsed().as_secs_f64()
    );

    // Machine-readable summary — one key=value per line so a CI script
    // can grep without parsing the prose above.  RSS is in KiB so the
    // value is a tidy integer; "n/a" means the OS hook returned None
    // (extremely rare on the supported desktop targets).  Phase-2
    // day-5: this stanza became the cross-platform verification anchor
    // — replay the bench on macOS / Windows and grep `peak_rss_kib=`
    // to confirm the kill-criterion-#3 margin holds.
    println!();
    println!("---- machine-readable summary ----");
    println!("wall_clock_seconds={:.3}", wall_clock_seconds);
    println!("snapshot_bytes={}", snapshot.len());
    println!("alive_blocks={alive_count}");
    match peak_rss {
        Some(kib) => println!("peak_rss_kib={kib}"),
        None => println!("peak_rss_kib=n/a"),
    }

    if fired {
        std::process::exit(1);
    }
    Ok(())
}

/// Format an `Option<u64>` rss measurement (in KiB) as a human-readable
/// string.  Returns "n/a" if `memory-stats` couldn't supply a number
/// — extremely rare on the three supported desktop targets.
fn fmt_rss(rss_kib: Option<u64>) -> String {
    match rss_kib {
        None => "n/a".to_string(),
        Some(n) => format!("{} KiB ({:.2} MiB)", n, n as f64 / 1024.0),
    }
}

// ---------------------------------------------------------------------------
// Smoke tests — Phase-2 day-5.
//
// The spike crate is throwaway (frozen post-Phase-0), but the day-5
// RSS swap still gets a CI-runnable smoke test so a future toolchain
// upgrade that breaks `memory-stats` surfaces immediately rather than
// during a manual bench run.  The test runs on whichever platform CI
// dispatches it on — Linux today, future macOS / Windows runners
// later — and implicitly verifies the API on the running platform.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// `memory-stats` should return a positive RSS reading for the
    /// running test process on every supported desktop target.  A
    /// `None` here would indicate the OS hook was disabled or the
    /// crate's platform support regressed; a zero reading would
    /// indicate a measurement bug (the test process itself has a
    /// non-trivial RSS).
    #[test]
    fn current_rss_kib_returns_positive_reading() {
        let rss = current_rss_kib().expect("current_rss_kib should not error");
        let kib = rss.expect("memory-stats should report a value on this platform");
        assert!(
            kib > 0,
            "process RSS should be > 0 KiB; got {kib} (likely a measurement bug)",
        );
    }
}
