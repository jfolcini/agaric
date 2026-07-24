use super::MaterializeTask;
use rustc_hash::FxHashSet;
use std::mem;
use std::sync::Arc;

pub(super) fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    // Swap to `FxHashSet`. `Discriminant` keys hash trivially under
    // FxHasher (no SipHash setup cost); the per-id sets below key on the
    // task id itself (`Arc<str>`) rather than a 64-bit fingerprint of it —
    // see #2911: a fingerprint collision between two DISTINCT ids would
    // silently drop the second id's task. Inserting the `Arc<str>` is a
    // cheap refcount bump, not a string clone. The sets are short-lived
    // (one drain).
    let mut seen_d: FxHashSet<mem::Discriminant<MaterializeTask>> = FxHashSet::default();
    let mut seen_bl: FxHashSet<Arc<str>> = FxHashSet::default();
    let mut seen_btr: FxHashSet<Arc<str>> = FxHashSet::default();
    let mut seen_fu: FxHashSet<Arc<str>> = FxHashSet::default();
    let mut seen_fr: FxHashSet<Arc<str>> = FxHashSet::default();
    let mut seen_frr: FxHashSet<Arc<str>> = FxHashSet::default();
    let mut seen_tu: FxHashSet<Arc<str>> = FxHashSet::default();
    let mut seen_spid: FxHashSet<Arc<str>> = FxHashSet::default();
    // #2042: RebuildPagesCacheCounts is held aside and emitted exactly once at
    // the END of the batch (see the arm + tail below).
    let mut saw_pages_cache_counts = false;
    let mut result = Vec::with_capacity(tasks.len());
    for task in tasks {
        match &task {
            MaterializeTask::ReindexBlockLinks { block_id } => {
                if seen_bl.insert(Arc::clone(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ReindexBlockTagRefs { block_id } => {
                if seen_btr.insert(Arc::clone(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::UpdateFtsBlock { block_id } => {
                if seen_fu.insert(Arc::clone(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ReindexFtsReferences { block_id } => {
                if seen_frr.insert(Arc::clone(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::RemoveFtsBlock { block_id } => {
                if seen_fr.insert(Arc::clone(block_id)) {
                    result.push(task);
                }
            }
            // #676: keyed by `tag_id`, NOT discriminant — two
            // `RefreshTagUsageCount` for DIFFERENT tags in the same drain
            // must both survive (collapsing them by discriminant would drop
            // one tag's usage_count refresh). Same per-key dedup shape as the
            // per-block tasks above; only exact-`tag_id` duplicates collapse.
            MaterializeTask::RefreshTagUsageCount { tag_id } => {
                if seen_tu.insert(Arc::clone(tag_id)) {
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
                if seen_spid.insert(Arc::clone(block_id)) {
                    result.push(task);
                }
            }
            MaterializeTask::ApplyOp(_)
            | MaterializeTask::ReplayApplyOp(..)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// #2911: dedup used to key per-id tasks on a 64-bit `FxHasher`
    /// fingerprint of the id rather than the id itself, so two
    /// DISTINCT ids that happened to collide on that 64-bit
    /// fingerprint would silently drop the second id's task. Keying
    /// directly on the `Arc<str>` id removes that collision class.
    /// This test exercises every per-id arm: same id twice collapses
    /// to one task, distinct ids both survive.
    #[test]
    fn per_id_arms_dedup_on_identity_not_a_fingerprint() {
        let cases: Vec<fn(Arc<str>) -> MaterializeTask> = vec![
            |block_id| MaterializeTask::ReindexBlockLinks { block_id },
            |block_id| MaterializeTask::ReindexBlockTagRefs { block_id },
            |block_id| MaterializeTask::UpdateFtsBlock { block_id },
            |block_id| MaterializeTask::ReindexFtsReferences { block_id },
            |block_id| MaterializeTask::RemoveFtsBlock { block_id },
            |block_id| MaterializeTask::SetBlockPageId { block_id },
            |tag_id| MaterializeTask::RefreshTagUsageCount { tag_id },
        ];

        for make in &cases {
            // Same id twice -> deduped to a single task.
            let same = dedup_tasks(vec![make(Arc::from("same-id")), make(Arc::from("same-id"))]);
            assert_eq!(
                same.len(),
                1,
                "two tasks with the same id must dedup to one"
            );

            // Distinct ids -> both survive (no false drop, e.g. from a
            // fingerprint collision).
            let distinct = dedup_tasks(vec![make(Arc::from("id-a")), make(Arc::from("id-b"))]);
            assert_eq!(
                distinct.len(),
                2,
                "two tasks with different ids must both be kept"
            );
        }
    }

    /// A mixed batch across several per-id kinds, each with both a
    /// duplicate and a distinct id, so every arm's set is exercised in
    /// the same drain and the counts confirm no cross-kind bleed.
    #[test]
    fn mixed_per_id_kinds_dedup_independently() {
        let d = dedup_tasks(vec![
            MaterializeTask::ReindexBlockLinks {
                block_id: Arc::from("a"),
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: Arc::from("a"), // duplicate, dropped
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: Arc::from("b"), // distinct, kept
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: Arc::from("a"), // different kind, same id as above: kept
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: Arc::from("a"), // duplicate within this kind, dropped
            },
            MaterializeTask::SetBlockPageId {
                block_id: Arc::from("x"),
            },
            MaterializeTask::SetBlockPageId {
                block_id: Arc::from("y"), // distinct, kept
            },
            MaterializeTask::RefreshTagUsageCount {
                tag_id: Arc::from("t1"),
            },
            MaterializeTask::RefreshTagUsageCount {
                tag_id: Arc::from("t1"), // duplicate, dropped
            },
            MaterializeTask::RefreshTagUsageCount {
                tag_id: Arc::from("t2"), // distinct, kept
            },
        ]);

        assert_eq!(
            d.len(),
            7,
            "expected 2 ReindexBlockLinks + 1 UpdateFtsBlock + 2 SetBlockPageId \
             + 2 RefreshTagUsageCount to survive dedup"
        );
        assert_eq!(
            d.iter()
                .filter(|t| matches!(t, MaterializeTask::ReindexBlockLinks { .. }))
                .count(),
            2
        );
        assert_eq!(
            d.iter()
                .filter(|t| matches!(t, MaterializeTask::UpdateFtsBlock { .. }))
                .count(),
            1
        );
        assert_eq!(
            d.iter()
                .filter(|t| matches!(t, MaterializeTask::SetBlockPageId { .. }))
                .count(),
            2
        );
        assert_eq!(
            d.iter()
                .filter(|t| matches!(t, MaterializeTask::RefreshTagUsageCount { .. }))
                .count(),
            2
        );
    }
}
