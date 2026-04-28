use crate::op::*;
use crate::op_log::OpRecord;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Outcome of a three-way text merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeResult {
    /// Clean merge -- non-overlapping edits combined successfully.
    Clean(String),
    /// Conflict -- overlapping edits, needs conflict copy.
    Conflict {
        ours: String,
        theirs: String,
        ancestor: String,
    },
}

/// Resolution of a concurrent property conflict (Last-Writer-Wins).
#[derive(Debug, Clone)]
pub struct PropertyConflictResolution {
    pub winner_device: String,
    pub winner_seq: i64,
    pub winner_value: SetPropertyPayload,
}

/// Outcome of merging a single block.
#[derive(Debug, Clone)]
pub enum MergeOutcome {
    /// Clean merge -- new edit op created with merged content.
    Merged(OpRecord),
    /// Conflict -- original block keeps our text, conflict copy created.
    // I-Lifecycle-4: `original_kept_ours: bool` field removed -- was hardcoded
    // to `true` at the only construction site in `apply.rs`. The "kept theirs"
    // branch was never wired up; if symmetric outcomes ever become real, the
    // field can be reintroduced as part of that change.
    ConflictCopy { conflict_block_op: OpRecord },
    /// No merge needed -- heads are the same.
    AlreadyUpToDate,
}
