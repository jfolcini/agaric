//! #763 — the shared normalized-snapshot builder (Rust side).
//!
//! This is the crux of the conformance harness: it must produce a snapshot
//! that is BYTE-IDENTICAL to the one the TS side builds from the tauri-mock
//! for the same logical state. The TS twin lives at
//! `src/lib/tauri-mock/__tests__/conformance-snapshot.ts` — keep the two in
//! lockstep.
//!
//! ## Canonical id relabeling
//!
//! Block ids differ per backend (ULID) vs mock (counter), so the raw id value
//! is useless for comparison. Instead we relabel every id to a canonical token
//! `B1, B2, …` by a DETERMINISTIC traversal that does not depend on the raw id:
//!
//!   * seed blocks first, in fixture seed order;
//!   * then created blocks, in op (creation) order — i.e. the order their
//!     `create_block` op was appended to the op_log.
//!
//! Every id REFERENCE is remapped through the same map: `parent_id`, `page_id`,
//! `block_tags.{block_id,tag_id}`, `page_links.{source_id,target_id,source_page_id}`,
//! and property `value_ref`. A reference to a block that is not in the map
//! (should not happen for in-corpus fixtures) is passed through verbatim so a
//! drift shows up rather than panicking.
//!
//! Nondeterministic fields (absolute timestamps, hashes, cursors, raw ids) are
//! stripped. `deleted_at` collapses to a boolean-ish sentinel: `null` when the
//! block is live, `"DELETED"` when tombstoned.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Raw (pre-relabel) intermediate state, filled by the runner's DB reads.
// ---------------------------------------------------------------------------

pub struct RawBlock {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted: bool,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<String>,
}

pub struct RawProperty {
    pub block_id: String,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
    pub value_bool: Option<bool>,
}

pub struct RawTag {
    pub block_id: String,
    pub tag_id: String,
}

pub struct RawLink {
    pub source_id: String,
    pub target_id: String,
    pub source_page_id: Option<String>,
}

/// A digest entry: the canonicalized op type and, for property ops, the key.
pub struct RawOp {
    pub op_type: String,
    pub key: Option<String>,
}

impl RawOp {
    /// Canonicalize a raw op_log row into a digest entry, applying the shared
    /// normalization rules. Returns `None` for ops that are dropped from the
    /// digest (auto-derived timestamp property writes).
    pub fn canonicalize(op_type: &str, key: Option<&str>) -> Option<Self> {
        // Auto-derived timestamp property writes — the mock never models these,
        // and they carry today's date. Drop from the digest.
        if op_type == "set_property" && matches!(key, Some("created_at" | "completed_at")) {
            return None;
        }
        // Reserved-key set_property ops are emitted by the backend as
        // `set_property(key=<reserved>)` but the mock has dedicated op_types
        // (`set_todo_state`, `set_due_date`, …). Canonicalize the backend shape
        // to the mock's logical name so the digests line up.
        if op_type == "set_property"
            && let Some(k) = key
            && matches!(k, "todo_state" | "priority" | "due_date" | "scheduled_date")
        {
            return Some(RawOp {
                op_type: format!("set_{k}"),
                key: None,
            });
        }
        let key = if op_type == "set_property" {
            key.map(str::to_owned)
        } else {
            None
        };
        Some(RawOp {
            op_type: op_type.to_owned(),
            key,
        })
    }
}

pub struct RawState {
    pub blocks: Vec<RawBlock>,
    pub properties: Vec<RawProperty>,
    pub block_tags: Vec<RawTag>,
    pub page_links: Vec<RawLink>,
    pub op_log: Vec<RawOp>,
}

// ---------------------------------------------------------------------------
// Normalized snapshot (the serialized comparison target).
// ---------------------------------------------------------------------------

/// The normalized snapshot. Serialized to JSON and compared field-by-field via
/// a `BTreeMap` round-trip on both sides, so map-key order never matters; the
/// arrays below ARE order-sensitive and are sorted deterministically here.
#[derive(Serialize)]
pub struct Snapshot {
    pub blocks: Vec<Value>,
    pub properties: Vec<Value>,
    pub block_tags: Vec<Value>,
    pub page_links: Vec<Value>,
    pub op_log_digest: Value,
}

/// Build the canonical id → token (`B1`, `B2`, …) map from the ordered list of
/// raw ids. The order is computed by the runner: seed ids in seed order, then
/// created ids in op order.
pub fn canonical_label_map(canonical_order: &[String]) -> BTreeMap<String, String> {
    canonical_order
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), format!("B{}", i + 1)))
        .collect()
}

/// Build the full normalized snapshot. Relabeling is driven entirely by
/// `canonical_order` (seed ids in seed order, then created ids in op order).
pub fn build_snapshot_with_order(state: RawState, canonical_order: &[String]) -> Snapshot {
    let map = canonical_label_map(canonical_order);
    let relabel = |id: &str| -> String { map.get(id).cloned().unwrap_or_else(|| id.to_owned()) };
    let relabel_opt = |id: &Option<String>| -> Value {
        match id {
            Some(s) => json!(relabel(s)),
            None => Value::Null,
        }
    };

    // Blocks — sorted by canonical id (numeric on the Bn suffix).
    let mut blocks: Vec<(String, Value)> = state
        .blocks
        .into_iter()
        .map(|b| {
            let cid = relabel(&b.id);
            let v = json!({
                "id": cid,
                "block_type": b.block_type,
                "content": b.content,
                "parent_id": relabel_opt(&b.parent_id),
                "page_id": relabel_opt(&b.page_id),
                "position": b.position,
                "deleted_at": if b.deleted { json!("DELETED") } else { Value::Null },
                "todo_state": b.todo_state,
                "priority": b.priority,
                "due_date": b.due_date,
                "scheduled_date": b.scheduled_date,
            });
            (cid, v)
        })
        .collect();
    blocks.sort_by_key(|(cid, _)| token_key(cid));
    let blocks: Vec<Value> = blocks.into_iter().map(|(_, v)| v).collect();

    // Properties — sorted by (block_id, key).
    let mut properties: Vec<(String, String, Value)> = state
        .properties
        .into_iter()
        .map(|p| {
            let bid = relabel(&p.block_id);
            let (value_type, value) = property_typed_value(&p, &relabel);
            let v = json!({
                "block_id": bid,
                "key": p.key,
                "value_type": value_type,
                "value": value,
            });
            (bid, p.key, v)
        })
        .collect();
    properties.sort_by(|a, b| (token_key(&a.0), &a.1).cmp(&(token_key(&b.0), &b.1)));
    let properties: Vec<Value> = properties.into_iter().map(|(_, _, v)| v).collect();

    // Block tags — sorted by (block_id, tag_id).
    let mut block_tags: Vec<(String, String, Value)> = state
        .block_tags
        .into_iter()
        .map(|t| {
            let bid = relabel(&t.block_id);
            let tid = relabel(&t.tag_id);
            (
                bid.clone(),
                tid.clone(),
                json!({ "block_id": bid, "tag_id": tid }),
            )
        })
        .collect();
    block_tags.sort_by_key(|(bid, tid, _)| (token_key(bid), token_key(tid)));
    let block_tags: Vec<Value> = block_tags.into_iter().map(|(_, _, v)| v).collect();

    // Page links — sorted by (source_id, target_id, source_page_id).
    let mut page_links: Vec<(String, String, String, Value)> = state
        .page_links
        .into_iter()
        .map(|l| {
            let sid = relabel(&l.source_id);
            let tid = relabel(&l.target_id);
            let spid = relabel_opt(&l.source_page_id);
            let spid_key = spid.as_str().unwrap_or("").to_owned();
            (
                sid.clone(),
                tid.clone(),
                spid_key,
                json!({ "source_id": sid, "target_id": tid, "source_page_id": spid }),
            )
        })
        .collect();
    page_links.sort_by(|a, b| {
        (token_key(&a.0), token_key(&a.1), token_key(&a.2)).cmp(&(
            token_key(&b.0),
            token_key(&b.1),
            token_key(&b.2),
        ))
    });
    let page_links: Vec<Value> = page_links.into_iter().map(|(_, _, _, v)| v).collect();

    // Op log digest — ordered by seq (already), filtered/canonicalized.
    let ops: Vec<Value> = state
        .op_log
        .iter()
        .map(|o| match &o.key {
            Some(k) => json!({ "op_type": o.op_type, "key": k }),
            None => json!({ "op_type": o.op_type }),
        })
        .collect();
    let op_log_digest = json!({ "count": ops.len(), "ops": ops });

    Snapshot {
        blocks,
        properties,
        block_tags,
        page_links,
        op_log_digest,
    }
}

/// Sort key for a `Bn` canonical token: `(prefix, numeric_suffix)`. Falls back
/// to lexical for non-`Bn` tokens (pass-through ids).
fn token_key(token: &str) -> (String, i64, String) {
    if let Some(rest) = token.strip_prefix('B')
        && let Ok(n) = rest.parse::<i64>()
    {
        return (String::from("B"), n, String::new());
    }
    (String::from("~"), 0, token.to_owned())
}

/// Derive `(value_type, value)` for a property row from whichever typed column
/// is set. Mirrors the TS twin exactly. Ref values are relabeled.
fn property_typed_value(p: &RawProperty, relabel: &dyn Fn(&str) -> String) -> (Value, Value) {
    if let Some(v) = &p.value_text {
        (json!("Text"), json!(v))
    } else if let Some(v) = p.value_num {
        (json!("Num"), json!(v))
    } else if let Some(v) = &p.value_date {
        (json!("Date"), json!(v))
    } else if let Some(v) = &p.value_ref {
        (json!("Ref"), json!(relabel(v)))
    } else if let Some(v) = p.value_bool {
        (json!("Bool"), json!(v))
    } else {
        (Value::Null, Value::Null)
    }
}
