use super::{BlockIdHint, MaterializeTask};
use std::collections::{HashMap, HashSet};
use std::mem;

pub(super) fn hash_id(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

pub(super) fn dedup_tasks(tasks: Vec<MaterializeTask>) -> Vec<MaterializeTask> {
    let mut seen_d: HashSet<mem::Discriminant<MaterializeTask>> = HashSet::new();
    let mut seen_bl: HashSet<u64> = HashSet::new();
    let mut seen_fu: HashSet<u64> = HashSet::new();
    let mut seen_fr: HashSet<u64> = HashSet::new();
    let mut seen_frr: HashSet<u64> = HashSet::new();
    let mut result = Vec::with_capacity(tasks.len());
    for task in tasks {
        match &task {
            MaterializeTask::ReindexBlockLinks { block_id } => {
                if seen_bl.insert(hash_id(block_id)) {
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

pub(super) fn extract_block_id(task: &MaterializeTask) -> Option<String> {
    match task {
        // MAINT-46: keep the non-dedup fallback semantics (malformed or
        // block-id-less payloads are treated as "cannot group by block_id"),
        // but no longer silently swallow the parse error — surface it at
        // warn level so operators can spot genuinely malformed op payloads
        // without changing runtime behaviour.
        MaterializeTask::ApplyOp(record) => serde_json::from_str::<BlockIdHint>(&record.payload)
            .inspect_err(|e| {
                tracing::warn!(
                    op_type = %record.op_type,
                    seq = record.seq,
                    device_id = %record.device_id,
                    error = %e,
                    "materializer dedup: failed to parse payload for block_id hint; \
                     falling back to non-dedup grouping"
                );
            })
            .ok()
            .map(|h| h.block_id)
            .filter(|id| !id.is_empty()),
        MaterializeTask::BatchApplyOps(records) => records.first().and_then(|r| {
            serde_json::from_str::<BlockIdHint>(&r.payload)
                .inspect_err(|e| {
                    tracing::warn!(
                        op_type = %r.op_type,
                        seq = r.seq,
                        device_id = %r.device_id,
                        error = %e,
                        "materializer dedup: failed to parse payload for block_id hint \
                         (batch head); falling back to non-dedup grouping"
                    );
                })
                .ok()
                .map(|h| h.block_id)
                .filter(|id| !id.is_empty())
        }),
        _ => None,
    }
}

pub(super) fn group_tasks_by_block_id(
    tasks: Vec<MaterializeTask>,
) -> Vec<(Option<String>, Vec<MaterializeTask>)> {
    let mut order: Vec<Option<String>> = Vec::new();
    let mut groups: HashMap<Option<String>, Vec<MaterializeTask>> = HashMap::new();
    for task in tasks {
        let block_id = extract_block_id(&task);
        match groups.entry(block_id) {
            std::collections::hash_map::Entry::Vacant(e) => {
                order.push(e.key().clone());
                e.insert(vec![task]);
            }
            std::collections::hash_map::Entry::Occupied(mut e) => {
                e.get_mut().push(task);
            }
        }
    }
    let mut result = Vec::with_capacity(order.len());
    let mut none_group = None;
    for key in order {
        if let Some(tasks) = groups.remove(&key) {
            if key.is_none() {
                none_group = Some(tasks);
            } else {
                result.push((key, tasks));
            }
        }
    }
    if let Some(tasks) = none_group {
        result.push((None, tasks));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::op_log::OpRecord;

    fn op_record(op_type: &str, payload: &str) -> OpRecord {
        OpRecord {
            device_id: "dev-A".into(),
            seq: 42,
            parent_seqs: None,
            hash: "deadbeef".into(),
            op_type: op_type.into(),
            payload: payload.into(),
            created_at: "2025-01-15T12:00:00Z".into(),
        }
    }

    /// MAINT-46: Malformed op payloads fall back to "no block_id" grouping
    /// (so `group_tasks_by_block_id` routes them through the None bucket
    /// and `dedup_tasks` still enqueues the ApplyOp task). The warn-level
    /// log is best-effort observability.
    ///
    /// Note: without a tracing-test subscriber installed, this test can
    /// only assert the functional fall-through (None block_id), not the
    /// log output itself. The tracing invocation is exercised via the
    /// `.inspect_err(...)` closure — if the closure panics or fails to
    /// compile, this test still catches the regression.
    #[test]
    fn extract_block_id_returns_none_and_logs_for_malformed_payload() {
        let malformed = op_record("delete_block", "{not valid json");
        let task = MaterializeTask::ApplyOp(malformed);
        assert_eq!(
            extract_block_id(&task),
            None,
            "MAINT-46: malformed JSON must fall back to None block_id so \
             the task is still processed under the non-dedup grouping"
        );
    }

    /// MAINT-46: the batch variant takes the first record's payload as the
    /// group hint; a malformed first record must also fall back safely.
    #[test]
    fn extract_block_id_returns_none_and_logs_for_malformed_batch_head() {
        let malformed = op_record("restore_block", "not even close to json");
        let healthy = op_record(
            "restore_block",
            r#"{"block_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}"#,
        );
        let task = MaterializeTask::BatchApplyOps(vec![malformed, healthy]);
        assert_eq!(
            extract_block_id(&task),
            None,
            "MAINT-46: malformed first-record JSON must yield None (caller \
             then routes the whole batch into the non-dedup bucket)"
        );
    }

    /// Regression guard: when the payload parses cleanly, extract_block_id
    /// must still return the block_id (no log fired).
    #[test]
    fn extract_block_id_returns_block_id_for_valid_payload() {
        let valid = op_record(
            "delete_block",
            r#"{"block_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}"#,
        );
        let task = MaterializeTask::ApplyOp(valid);
        assert_eq!(
            extract_block_id(&task),
            Some("01ARZ3NDEKTSV4RRFFQ69G5FAV".into()),
        );
    }

    /// Regression guard: empty block_id must still be filtered out (keeps
    /// the existing `.filter(|id| !id.is_empty())` semantics).
    #[test]
    fn extract_block_id_returns_none_for_empty_block_id() {
        let empty = op_record("delete_block", r#"{"block_id":""}"#);
        let task = MaterializeTask::ApplyOp(empty);
        assert_eq!(extract_block_id(&task), None);
    }
}
