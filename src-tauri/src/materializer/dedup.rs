use super::MaterializeTask;
use rustc_hash::{FxHashSet, FxHasher};
use std::mem;

pub(super) fn hash_id(s: &str) -> u64 {
    // SipHash via `DefaultHasher` is overkill for a
    // dedup-only fingerprint. `FxHasher` is ~3× faster on small string
    // keys and the hash is never persisted, so the choice is a pure
    // throughput win.
    use std::hash::{Hash, Hasher};
    let mut h = FxHasher::default();
    s.hash(&mut h);
    h.finish()
}

pub(super) fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    // Swap to `FxHashSet`. `u64` and `Discriminant` keys
    // hash trivially under FxHasher (no SipHash setup cost), and the
    // sets are short-lived (one drain).
    let mut seen_d: FxHashSet<mem::Discriminant<MaterializeTask>> = FxHashSet::default();
    let mut seen_bl: FxHashSet<u64> = FxHashSet::default();
    let mut seen_btr: FxHashSet<u64> = FxHashSet::default();
    let mut seen_fu: FxHashSet<u64> = FxHashSet::default();
    let mut seen_fr: FxHashSet<u64> = FxHashSet::default();
    let mut seen_frr: FxHashSet<u64> = FxHashSet::default();
    let mut seen_tu: FxHashSet<u64> = FxHashSet::default();
    let mut seen_spid: FxHashSet<u64> = FxHashSet::default();
    // #2042: RebuildPagesCacheCounts is held aside and emitted exactly once at
    // the END of the batch (see the arm + tail below).
    let mut saw_pages_cache_counts = false;
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
            // #2540: keyed by `block_id`, NOT discriminant — two
            // `SetBlockPageId` for DIFFERENT blocks in the same drain must both
            // survive. This is the per-block `page_id`/`space_id` backstop
            // (task_handlers.rs) that fills a block whose owning page the in-tx
            // stamp could not resolve; every non-page create enqueues one
            // (dispatch.rs), so a multi-block paste/import burst co-locates many
            // in one drain. Collapsing by discriminant would keep only the first
            // and leave every later block with NULL page_id/space_id until an
            // unrelated lifecycle op enqueues a full RebuildPageIds. Same
            // per-key dedup shape as ReindexBlockLinks; only exact-`block_id`
            // duplicates collapse.
            MaterializeTask::SetBlockPageId { block_id } => {
                if seen_spid.insert(hash_id(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ApplyOp(_)
            | MaterializeTask::BatchApplyOps(_)
            | MaterializeTask::Barrier(_) => {
                result.push(task);
            }
            // #2042: RebuildPagesCacheCounts (an UPDATE of *existing* pages_cache
            // rows) depends on RebuildPagesCache, which re-inserts a restored
            // page's ROW, and on RebuildPageIds. In a mixed page+content
            // multi-root lifecycle batch the content set's RebuildPagesCacheCounts
            // (the content set has no RebuildPagesCache) would otherwise dedup
            // AHEAD of the page set's RebuildPagesCache under the keep-first rule,
            // recomputing a restored page's counts before its row exists and
            // leaving it at 0 until the next lifecycle op. Collapse duplicates and
            // emit it once at the END of the batch so it always runs after every
            // row / page_id rebuild. This is safe w.r.t. `flush`/`settle`: the
            // consumer signals Barriers only after the whole batch drains
            // (`consumer::run_background`), so a trailing position still completes
            // before the flush barrier fires.
            MaterializeTask::RebuildPagesCacheCounts => {
                saw_pages_cache_counts = true;
            }
            _ => {
                if seen_d.insert(mem::discriminant(&task)) {
                    result.push(task);
                }
            }
        }
    }
    if saw_pages_cache_counts {
        result.push(MaterializeTask::RebuildPagesCacheCounts);
    }
    result
}

// H-5 / H-6 (2026-04): `extract_block_id` and `group_tasks_by_block_id`
// used to live here as the input to `process_foreground_segment`'s
// JoinSet parallelism. The JoinSet path was removed in favour of strict
// FIFO execution (see `consumer::process_foreground_segment`), so the
// bucketing helpers were deleted along with their unit tests.
//
// (2026-04): the `BlockIdHint` payload-shape type that survived
// H-5/H-6 has now also been deleted — the four `dispatch.rs` arms
// (edit/delete/restore/purge) that parsed it now read from the cached
// `OpRecord::block_id` sidecar populated at append-time / sync ingress.
// See the comment above `CreateBlockHint` in `super` for context.
