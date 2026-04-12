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
        MaterializeTask::ApplyOp(record) => serde_json::from_str::<BlockIdHint>(&record.payload)
            .ok()
            .map(|h| h.block_id)
            .filter(|id| !id.is_empty()),
        MaterializeTask::BatchApplyOps(records) => records.first().and_then(|r| {
            serde_json::from_str::<BlockIdHint>(&r.payload)
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
