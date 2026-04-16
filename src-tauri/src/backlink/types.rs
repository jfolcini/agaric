//! Type definitions for backlink queries: filter predicates, sort modes,
//! and response structs.

use serde::{Deserialize, Serialize};

use crate::pagination::BlockRow;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Comparison operators for property filters.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum CompareOp {
    Eq,
    Neq,
    Lt,
    Gt,
    Lte,
    Gte,
    Contains,
    StartsWith,
}

/// Sort direction.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum SortDir {
    Asc,
    Desc,
}

/// Tagged union of filter predicates for backlink queries.
///
/// Filters are combined with AND semantics at the top level.
/// Use `And`/`Or`/`Not` variants for compound boolean logic.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum BacklinkFilter {
    PropertyText {
        key: String,
        op: CompareOp,
        value: String,
    },
    PropertyNum {
        key: String,
        op: CompareOp,
        value: f64,
    },
    PropertyDate {
        key: String,
        op: CompareOp,
        value: String,
    },
    PropertyIsSet {
        key: String,
    },
    PropertyIsEmpty {
        key: String,
    },
    /// Filter blocks by todo_state column (direct, no block_properties join).
    TodoState {
        state: String,
    },
    /// Filter blocks by priority column (direct, no block_properties join).
    Priority {
        level: String,
    },
    /// Filter blocks by due_date column with comparison operator.
    DueDate {
        op: CompareOp,
        value: String,
    },
    HasTag {
        tag_id: String,
    },
    HasTagPrefix {
        prefix: String,
    },
    Contains {
        query: String,
    },
    CreatedInRange {
        after: Option<String>,
        before: Option<String>,
    },
    BlockType {
        block_type: String,
    },
    /// Filter by source page — include/exclude blocks based on their root page ancestor.
    SourcePage {
        included: Vec<String>,
        excluded: Vec<String>,
    },
    And {
        filters: Vec<BacklinkFilter>,
    },
    Or {
        filters: Vec<BacklinkFilter>,
    },
    Not {
        filter: Box<BacklinkFilter>,
    },
}

/// Tagged union of sort modes for backlink queries.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum BacklinkSort {
    Created { dir: SortDir },
    PropertyText { key: String, dir: SortDir },
    PropertyNum { key: String, dir: SortDir },
    PropertyDate { key: String, dir: SortDir },
}

/// Response for a filtered backlink query, including total count.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct BacklinkQueryResponse {
    pub items: Vec<BlockRow>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_count: usize,
    pub filtered_count: usize,
}

/// A group of backlinks from the same source page.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct BacklinkGroup {
    pub page_id: String,
    pub page_title: Option<String>,
    pub blocks: Vec<BlockRow>,
}

/// Response for grouped backlink queries — backlinks organized by source page.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct GroupedBacklinkResponse {
    pub groups: Vec<BacklinkGroup>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_count: usize,
    pub filtered_count: usize,
    /// `true` when the FTS query hit the internal row cap (10 000) and results
    /// may be incomplete.  Only relevant for unlinked-reference queries; regular
    /// grouped backlink queries always set this to `false`.
    pub truncated: bool,
}
