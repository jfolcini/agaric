use super::MaterializeTask;
use rustc_hash::{FxHashSet, FxHasher};
use std::mem;

pub(super) fn hash_id(s: &str) -> u64 {
    // L-5 (PEND-25): SipHash via `DefaultHasher` is overkill for a
    // dedup-only fingerprint. `FxHasher` is ~3× faster on small string
    // keys and the hash is never persisted, so the choice is a pure
    // throughput win.
    use std::hash::{Hash, Hasher};
    let mut h = FxHasher::default();
    s.hash(&mut h);
    h.finish()
}

pub(super) fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    // L-5 (PEND-25): swap to `FxHashSet`. `u64` and `Discriminant` keys
    // hash trivially under FxHasher (no SipHash setup cost), and the
    // sets are short-lived (one drain).
    let mut seen_d: FxHashSet<mem::Discriminant<MaterializeTask>> = FxHashSet::default();
    let mut seen_bl: FxHashSet<u64> = FxHashSet::default();
    let mut seen_btr: FxHashSet<u64> = FxHashSet::default();
    let mut seen_fu: FxHashSet<u64> = FxHashSet::default();
    let mut seen_fr: FxHashSet<u64> = FxHashSet::default();
    let mut seen_frr: FxHashSet<u64> = FxHashSet::default();
    let mut seen_tu: FxHashSet<u64> = FxHashSet::default();
    let mut result = Vec::with_capacity(tasks.len());
    for task in tasks {
        match &task {
            MaterializeTask::ReindexBlockLinks { block_id } => {
                if seen_bl.insert(hash_id(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ReindexBlockTagRefs { block_id } => {
                if seen_btr.insert(hash_id(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::UpdateFtsBlock { block_id } => {
                if seen_fu.insert(hash_id(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ReindexFtsReferences { block_id } => {
                if seen_frr.insert(hash_id(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::RemoveFtsBlock { block_id } => {
                if seen_fr.insert(hash_id(block_id)) {
                    result.push(task);
                }
            }
            // #676: keyed by `tag_id`, NOT discriminant — two
            // `RefreshTagUsageCount` for DIFFERENT tags in the same drain
            // must both survive (collapsing them by discriminant would drop
            // one tag's usage_count refresh). Same per-key dedup shape as the
            // per-block tasks above; only exact-`tag_id` duplicates collapse.
            MaterializeTask::RefreshTagUsageCount { tag_id } => {
                if seen_tu.insert(hash_id(tag_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ApplyOp(_)
            | MaterializeTask::BatchApplyOps(_)
            | MaterializeTask::Barrier(_) => {
                result.push(task);
            }
            _ => {
                if seen_d.insert(mem::discriminant(&task)) {
                    result.push(task);
                }
            }
        }
    }
    result
}

// H-5 / H-6 (2026-04): `extract_block_id` and `group_tasks_by_block_id`
// used to live here as the input to `process_foreground_segment`'s
// JoinSet parallelism. The JoinSet path was removed in favour of strict
// FIFO execution (see `consumer::process_foreground_segment`), so the
// bucketing helpers were deleted along with their unit tests.
//
// L-13 (2026-04): the `BlockIdHint` payload-shape type that survived
// H-5/H-6 has now also been deleted — the four `dispatch.rs` arms
// (edit/delete/restore/purge) that parsed it now read from the cached
// `OpRecord::block_id` sidecar populated at append-time / sync ingress.
// See the comment above `CreateBlockHint` in `super` for context.
