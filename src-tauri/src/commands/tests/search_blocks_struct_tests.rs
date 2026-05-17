//! PEND-50 Phase 0 — wire-shape regression tests for the
//! `search_blocks` IPC structs (`SearchFilter` request,
//! `SearchBlockRow` response).
//!
//! These tests guard the JSON shape that tauri-specta generates for the
//! frontend bindings (`src/lib/bindings.ts`). Specifically:
//!
//! - `SearchFilter` must deserialise from `{}` with every field
//!   defaulted, so follow-up plans (PEND-54/55/53) can append fields
//!   with `#[serde(default)]` without ever requiring the frontend to
//!   send them.
//! - `SearchBlockRow.snippet` must serialise as JSON `null` when
//!   absent and as a plain string when present — the frontend renderer
//!   parses the literal `<mark>...</mark>` markers as React nodes and
//!   never invokes `dangerouslySetInnerHTML`.

#![allow(unused_imports)]

use super::super::{SearchBlockRow, SearchFilter};
use crate::ulid::ActiveBlockId;
use serde_json::json;

// ---------------------------------------------------------------------
// SearchFilter — deserialise
// ---------------------------------------------------------------------

#[test]
fn search_filter_deserialises_from_empty_object_with_defaults() {
    // The frontend wrapper for a no-filter call sends `{}` — every
    // field must be optional and default to the same value as
    // `SearchFilter::default()`.
    let filter: SearchFilter = serde_json::from_value(json!({})).unwrap();
    assert!(filter.parent_id.is_none(), "default parent_id must be None");
    assert!(
        filter.tag_ids.is_empty(),
        "default tag_ids must be empty vec"
    );
    assert!(filter.space_id.is_none(), "default space_id must be None");
}

#[test]
fn search_filter_deserialises_with_partial_fields() {
    // The wrapper for "only tags supplied" sends just `tagIds`. Every
    // other field must default to its `Default` value.
    let filter: SearchFilter = serde_json::from_value(json!({
        "tagIds": ["TAG_A", "TAG_B"],
    }))
    .unwrap();
    assert!(filter.parent_id.is_none());
    assert_eq!(filter.tag_ids, vec!["TAG_A".to_string(), "TAG_B".into()]);
    assert!(filter.space_id.is_none());
}

#[test]
fn search_filter_roundtrip_serialise_deserialise_is_identity() {
    // Round-trip: a fully-populated filter survives a JSON cycle with
    // every field preserved.
    let original = SearchFilter {
        parent_id: Some("PAGE_X".into()),
        tag_ids: vec!["TAG_1".into(), "TAG_2".into()],
        space_id: Some("01TESTSPACE000000000000001".into()),
    };
    let json = serde_json::to_value(&original).unwrap();
    let decoded: SearchFilter = serde_json::from_value(json).unwrap();
    assert_eq!(decoded.parent_id, original.parent_id);
    assert_eq!(decoded.tag_ids, original.tag_ids);
    assert_eq!(decoded.space_id, original.space_id);
}

// ---------------------------------------------------------------------
// SearchBlockRow — serialise
// ---------------------------------------------------------------------

#[test]
fn search_block_row_snippet_serialises_none_as_null_and_some_as_string() {
    // `snippet: None` must serialise as JSON `null` so the frontend's
    // TypeScript binding (`snippet: string | null`) deserialises
    // cleanly. `Some("foo")` must serialise as `"foo"` verbatim — the
    // backend emits literal `<mark>...</mark>` markers and the
    // frontend parses them as React nodes (no
    // `dangerouslySetInnerHTML`).
    let none_row = SearchBlockRow {
        id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
        block_type: "content".into(),
        content: Some("body".into()),
        parent_id: None,
        position: None,
        deleted_at: None,
        todo_state: None,
        priority: None,
        due_date: None,
        scheduled_date: None,
        page_id: None,
        snippet: None,
    };
    let v = serde_json::to_value(&none_row).unwrap();
    assert!(
        v.get("snippet").is_some_and(serde_json::Value::is_null),
        "snippet=None must serialise as JSON null; got {:?}",
        v.get("snippet")
    );

    let some_row = SearchBlockRow {
        snippet: Some("hello <mark>world</mark>".into()),
        ..none_row
    };
    let v = serde_json::to_value(&some_row).unwrap();
    assert_eq!(
        v.get("snippet").and_then(|s| s.as_str()),
        Some("hello <mark>world</mark>"),
        "snippet=Some must serialise as the literal string"
    );
}
