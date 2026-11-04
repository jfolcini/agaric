//! Op payload types for the CRDT op log.
//!
//! Each operation in the log has a typed payload. The [`OpType`] enum identifies
//! the operation kind, and [`OpPayload`] is an internally-tagged enum that wraps
//! all payload structs for (de)serialization.
//!
//! ## Validation
//!
//! These types are *structural* — they enforce correct shapes at
//! (de)serialization time but do **not** validate domain invariants such as
//! non-empty `block_id`. Domain validation is the responsibility of the command
//! layer that constructs payloads before appending to the op log.
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use agaric_core::ulid::{AttachmentId, BlockId};

// ---------------------------------------------------------------------------
// OpType — the string tag stored in op_log.op_type
// ---------------------------------------------------------------------------

/// Operation type tag. Serialized as snake_case strings for storage in the
/// `op_log.op_type` TEXT column.
///
/// **In-crate exhaustive-match invariant** (per docs/architecture/data-and-events.md § Op log —
/// exhaustive `match` over every op type, no catch-all arms): every consumer
/// of this enum is workspace-internal and matches on every variant
/// explicitly. (#652: the invariant is the exhaustive matching, not any
/// specific variant count — an earlier "12 op types" phrasing here drifted
/// the moment `RenameAttachment` landed as the 13th.)
/// I-Core-1: `#[non_exhaustive]` was previously applied as future-proofing
/// for downstream consumers outside the crate, but no such consumers exist —
/// the attribute weakened the invariant by silencing the "missing arm"
/// compiler error when a new variant is added. Without it, adding a new op
/// type (e.g. for compaction tombstones) reliably surfaces every site that
/// must be updated.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpType {
    CreateBlock,
    EditBlock,
    DeleteBlock,
    RestoreBlock,
    PurgeBlock,
    MoveBlock,
    AddTag,
    RemoveTag,
    SetProperty,
    DeleteProperty,
    AddAttachment,
    DeleteAttachment,
    RenameAttachment,
    AddPageAlias,
    RemovePageAlias,
    SetPropertyDef,
    RenamePropertyKey,
    RewriteProperties,
    RenamePropertyOption,
}

impl OpType {
    /// Returns the snake_case string representation, matching the serde
    /// serialization and the `op_log.op_type` column value.
    ///
    /// This is the single source of truth for the string mapping. Both
    /// [`Display`](std::fmt::Display) and [`OpPayload::op_type_str`] delegate here.
    ///
    /// # Examples
    ///
    /// Every variant maps to its `op_log.op_type` column value, matching the
    /// serde serialization:
    ///
    /// ```
    /// use agaric_store::op::OpType;
    ///
    /// assert_eq!(OpType::CreateBlock.as_str(), "create_block");
    /// assert_eq!(OpType::RenameAttachment.as_str(), "rename_attachment");
    /// ```
    pub fn as_str(&self) -> &'static str {
        match self {
            OpType::CreateBlock => "create_block",
            OpType::EditBlock => "edit_block",
            OpType::DeleteBlock => "delete_block",
            OpType::RestoreBlock => "restore_block",
            OpType::PurgeBlock => "purge_block",
            OpType::MoveBlock => "move_block",
            OpType::AddTag => "add_tag",
            OpType::RemoveTag => "remove_tag",
            OpType::SetProperty => "set_property",
            OpType::DeleteProperty => "delete_property",
            OpType::AddAttachment => "add_attachment",
            OpType::DeleteAttachment => "delete_attachment",
            OpType::RenameAttachment => "rename_attachment",
            OpType::AddPageAlias => "add_page_alias",
            OpType::RemovePageAlias => "remove_page_alias",
            OpType::SetPropertyDef => "set_property_def",
            OpType::RenamePropertyKey => "rename_property_key",
            OpType::RewriteProperties => "rewrite_properties",
            OpType::RenamePropertyOption => "rename_property_option",
        }
    }
}

impl fmt::Display for OpType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for OpType {
    type Err = String;

    /// Parses a snake_case string (e.g. `"create_block"`) into an [`OpType`].
    ///
    /// Uses a manual match to avoid the overhead of serde_json deserialization
    /// for this simple string-to-enum conversion. The match arms mirror
    /// [`OpType::as_str`] to guarantee round-trip consistency.
    ///
    /// # Examples
    ///
    /// Parsing round-trips with [`OpType::as_str`]; an unrecognised op-type
    /// string is an error rather than a silent default:
    ///
    /// ```
    /// use agaric_store::op::OpType;
    ///
    /// assert_eq!("set_property".parse::<OpType>(), Ok(OpType::SetProperty));
    /// assert_eq!(OpType::SetProperty.as_str().parse::<OpType>(), Ok(OpType::SetProperty));
    /// assert!("no_such_op".parse::<OpType>().is_err());
    /// ```
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "create_block" => Ok(OpType::CreateBlock),
            "edit_block" => Ok(OpType::EditBlock),
            "delete_block" => Ok(OpType::DeleteBlock),
            "restore_block" => Ok(OpType::RestoreBlock),
            "purge_block" => Ok(OpType::PurgeBlock),
            "move_block" => Ok(OpType::MoveBlock),
            "add_tag" => Ok(OpType::AddTag),
            "remove_tag" => Ok(OpType::RemoveTag),
            "set_property" => Ok(OpType::SetProperty),
            "delete_property" => Ok(OpType::DeleteProperty),
            "add_attachment" => Ok(OpType::AddAttachment),
            "delete_attachment" => Ok(OpType::DeleteAttachment),
            "rename_attachment" => Ok(OpType::RenameAttachment),
            "add_page_alias" => Ok(OpType::AddPageAlias),
            "remove_page_alias" => Ok(OpType::RemovePageAlias),
            "set_property_def" => Ok(OpType::SetPropertyDef),
            "rename_property_key" => Ok(OpType::RenamePropertyKey),
            "rewrite_properties" => Ok(OpType::RewriteProperties),
            "rename_property_option" => Ok(OpType::RenamePropertyOption),
            other => Err(format!("unknown op type: {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Payload structs — one per OpType variant
// ---------------------------------------------------------------------------

/// Payload for the `create_block` op — creates a new block with the given type, content, and optional parent.
///
/// Sibling placement (#400): new ops carry [`Self::index`] — a 0-based slot
/// among `parent_id`'s children — and Loro derives the convergent fractional
/// key at apply time. Pre-#400 ops carry only the legacy sparse [`Self::position`];
/// op-log replay maps that to a slot (see `LoroEngine::apply_create_block`).
/// Both fields are optional + omitted-when-`None` so old and new payloads
/// round-trip without a wire-format break (issue #400 mandates this extension).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateBlockPayload {
    pub block_id: BlockId,
    pub block_type: String,
    pub parent_id: Option<BlockId>,
    /// Legacy sparse 1-based sibling position (pre-#400 ops only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    /// New-scheme 0-based sibling slot among `parent_id`'s children (#400).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    pub content: String,
}

/// Payload for the `edit_block` op — replaces a block's content with `to_text`, tracking the previous edit for conflict detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditBlockPayload {
    pub block_id: BlockId,
    pub to_text: String,
    /// `(device_id, seq)` reference to the edit or create whose text the block
    /// held when this edit was written — forms the CAS key for editor conflict
    /// detection. The `device_id`
    /// string participates in the canonical payload / hash preimage (see
    /// `normalize_block_ids`); it must be in its already-canonical form (today:
    /// UUID, always ASCII-safe). Compare the I-Core-11 note on `parent_seqs`.
    ///
    /// Serialized as a JSON two-element array `[device_id, seq]` or `null`.
    pub prev_edit: Option<(String, i64)>,
    /// The text the edit overwrote, which its undo restores, recorded only
    /// when no op in the log holds it: a Loro merge of two devices' edits, or a
    /// block whose ops never reached this log (#6046). `None` otherwise and on
    /// ops written before it existed; omitted then, so an ordinary edit keeps
    /// its size and an older op its hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_text: Option<String>,
}

/// Delete always cascades to all descendants. The `cascade` field
/// was removed — it was always `true` and never read by any code path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteBlockPayload {
    pub block_id: BlockId,
}

/// Payload for the `restore_block` op — un-deletes a block and its descendants using the `deleted_at` timestamp as a guard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreBlockPayload {
    pub block_id: BlockId,
    /// Epoch-ms guard matched against `blocks.deleted_at` (INTEGER since
    /// migration 0080); sourced from the delete op's `created_at`.
    pub deleted_at_ref: i64,
}

/// Payload for the `purge_block` op — physically deletes a soft-deleted block and all its descendants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurgeBlockPayload {
    pub block_id: BlockId,
}

/// Payload for the `move_block` op — reparents a block under a new parent at a
/// given sibling slot.
///
/// Sibling placement (#400): new ops carry [`Self::new_index`] — a 0-based
/// insertion slot among the target parent's *other* children (the moved node is
/// excluded, matching `LoroTree::mov_to`) — and Loro derives the convergent
/// fractional key at apply time. Pre-#400 ops carry only the legacy sparse
/// [`Self::new_position`]; op-log replay maps that to a slot (see
/// `LoroEngine::apply_move_block`). `new_position` is retained (and, for new
/// ops, mirrors `new_index` as a breadcrumb) so it never needs to change type;
/// `new_index` is omitted-when-`None` so old payloads round-trip unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveBlockPayload {
    pub block_id: BlockId,
    pub new_parent_id: Option<BlockId>,
    /// Legacy sparse 1-based sibling position. For new (#400) ops this mirrors
    /// `new_index` (0-based) as a non-authoritative breadcrumb; the materializer
    /// routes on `new_index` when present.
    pub new_position: i64,
    /// New-scheme 0-based sibling slot (#400). `None` ⇒ a pre-#400 op.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_index: Option<i64>,
    /// Where the block sat before the move, which its undo restores. The op
    /// log cannot always supply it: a block created on a peer has no local
    /// create, and a peer's move of it no local move (#6046). `None` on ops
    /// written before it existed and on the boot repairs' moves; omitted then,
    /// so those ops keep their hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior: Option<BlockPlacement>,
}

/// A block's parent and its 0-based slot among that parent's other live
/// children in `(position, id)` order, the slot a `move_block`'s `new_index`
/// names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockPlacement {
    pub parent_id: Option<BlockId>,
    pub index: i64,
}

/// Payload for the `add_tag` op — associates a tag block with a content/page block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddTagPayload {
    pub block_id: BlockId,
    pub tag_id: BlockId,
}

/// Payload for the `remove_tag` op — dissociates a tag block from a content/page block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveTagPayload {
    pub block_id: BlockId,
    pub tag_id: BlockId,
}

/// Payload for the `add_page_alias` op — gives a page an alternative name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddPageAliasPayload {
    pub page_id: BlockId,
    pub alias: String,
}

/// Payload for the `remove_page_alias` op — takes an alternative name off a page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemovePageAliasPayload {
    pub page_id: BlockId,
    pub alias: String,
}

/// A user property definition as a space holds it: its type and, for a
/// select, its options as the JSON array text `property_definitions.options`
/// stores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropertyDefState {
    pub value_type: String,
    pub options: Option<String>,
}

/// Payload for the `set_property_def` op — creates, edits or deletes
/// `space_id`'s definition of `key` (#5841).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetPropertyDefPayload {
    pub space_id: BlockId,
    pub key: String,
    /// The definition the op leaves; `None` deletes it.
    pub def: Option<PropertyDefState>,
    /// The definition the op replaced, which its undo restores; `None` when
    /// the space did not declare the key.
    pub prior: Option<PropertyDefState>,
}

/// Payload for the `rename_property_key` op — moves `space_id`'s definition of
/// `old_key`, and every value under it, to `new_key` (#5841). A block or a
/// space already holding `new_key` keeps what it holds, so a replay that meets
/// a later write under `old_key` leaves it there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenamePropertyKeyPayload {
    pub space_id: BlockId,
    pub old_key: String,
    pub new_key: String,
}

/// Payload for the `rename_property_option` op — renames `old_option` of
/// `space_id`'s select `key` to `new_option`, in the definition's options (in
/// place, keeping their order) and in every value of the space's blocks equal
/// to it (#5841).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenamePropertyOptionPayload {
    pub space_id: BlockId,
    pub key: String,
    pub old_option: String,
    pub new_option: String,
}

/// Why a `rewrite_properties` op rewrote `space_id`'s definitions and values
/// (#5841).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewriteReason {
    /// One key merged into another of the same type.
    Merge,
    /// A key's type changed; each value the new type converts to another
    /// form is written.
    ChangeType,
    /// Every value of a key its definition does not take was removed (#6206).
    RemoveUnfit,
    /// Values of a key its definition does not take were replaced by ones it
    /// does (#6206).
    ConvertUnfit,
    /// Values of a key its definition does not take were moved to another
    /// key, on the same blocks, where they fit (#6206).
    MoveUnfit,
}

/// One definition a `rewrite_properties` op writes: `def` replaces `prior`,
/// `None` meaning the space does not declare `key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropertyDefWrite {
    pub key: String,
    pub def: Option<PropertyDefState>,
    pub prior: Option<PropertyDefState>,
}

/// One value a `rewrite_properties` op writes: `value` replaces `prior` under
/// `key` on `block_id`, `None` meaning the block holds no value there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyValueWrite {
    pub block_id: BlockId,
    pub key: String,
    pub value: Option<PropertyValueFields>,
    pub prior: Option<PropertyValueFields>,
}

/// Payload for the `rewrite_properties` op (#5841): absolute writes of
/// `space_id`'s definitions, then of its values, each recording what it
/// replaced, so a replay writes the same state and the reverse is the swap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RewritePropertiesPayload {
    pub space_id: BlockId,
    pub reason: RewriteReason,
    pub defs: Vec<PropertyDefWrite>,
    pub values: Vec<PropertyValueWrite>,
}

/// Payload for the `set_property` op — upserts a typed key-value property on a block (exactly one value field must be set).
///
/// `value_bool` is marked `#[serde(default)]` so op-log entries
/// Written before (which had no `value_bool` column) still
/// deserialize — they yield `value_bool = None`. Mirrors the pattern used
/// by [`DeleteAttachmentPayload::fs_path`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetPropertyPayload {
    pub block_id: BlockId,
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<BlockId>,
    #[serde(default)]
    pub value_bool: Option<bool>,
    /// The value the set overwrote, which its undo restores; every slot `None`
    /// when the block held none. The op log cannot always supply it: a value
    /// set on a peer arrives through the engine with no local op behind it,
    /// and so does the deletion of one (#6014). `None` on ops written before
    /// it existed, and on the writers that only set a key the block does not
    /// hold (the space migrations and orphan-tag adoption); omitted then, so
    /// those ops keep their hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior: Option<PropertyValueFields>,
}

impl SetPropertyPayload {
    /// The payload that sets `key` on `block_id` to `value`.
    pub fn with_value(block_id: BlockId, key: String, value: PropertyValueFields) -> Self {
        let PropertyValueFields {
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
        } = value;
        Self {
            block_id,
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
            prior: None,
        }
    }

    /// The value this payload sets.
    pub fn value(&self) -> PropertyValueFields {
        PropertyValueFields {
            value_text: self.value_text.clone(),
            value_num: self.value_num,
            value_date: self.value_date.clone(),
            value_ref: self.value_ref.clone(),
            value_bool: self.value_bool,
        }
    }
}

/// A property's typed value, in the five slots [`SetPropertyPayload`] carries.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PropertyValueFields {
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<BlockId>,
    pub value_bool: Option<bool>,
}

impl PropertyValueFields {
    /// `None` when every slot is empty. A value a block holds sets a slot, so
    /// an empty `prior` records that the block held none.
    pub fn into_held(self) -> Option<Self> {
        (self != Self::default()).then_some(self)
    }
}

/// Payload for the `delete_property` op — removes a property by key from a block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeletePropertyPayload {
    pub block_id: BlockId,
    pub key: String,
    /// The value the delete removed, which its undo restores. The op log
    /// cannot always supply it: a value set on a peer arrives through the
    /// engine with no local op behind it, and compaction prunes old ones
    /// (#5918). `None` on ops written before it existed and on a delete of a
    /// key the block did not hold; omitted then, so those ops keep their hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior: Option<PropertyValueFields>,
}

/// Payload for the `add_attachment` op — records a new file attachment linked to a block.
///
/// `attachment_id` is an [`AttachmentId`] (alias of [`BlockId`]) so that it
/// auto-uppercases on construction / deserialization. Storing it as a raw
/// `String` would bypass the uppercase contract and feed un-normalized bytes
/// into [`compute_op_hash`](agaric_core::hash::compute_op_hash), breaking the
/// blake3 hash determinism that AGENTS.md invariant #8 relies on for
/// cross-device sync. The serde wire format is unchanged (`BlockId` is
/// `#[serde(transparent)]`).
///
/// `content_hash` is the blake3 hex of the bytes (#5608 step 6). A peer's row
/// carries it, so the receiver can refuse bytes that do not match and link
/// bytes it already holds instead of requesting them. Op-log entries written
/// before it decode as `None`, and `None` is omitted when serialized, so those
/// entries re-serialize to the text their hash was computed over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddAttachmentPayload {
    pub attachment_id: AttachmentId,
    pub block_id: BlockId,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// Payload for the `delete_attachment` op — removes an attachment by its ID (block_id is not needed).
///
/// `fs_path` carries the on-disk path (relative to `app_data_dir`) of the
/// attachment file at the time of deletion so the local apply step can
/// unlink it. Marked `#[serde(default)]` so op-log entries written before
/// C-3 (which had no `fs_path`) still deserialize — they yield `fs_path
/// = ""` and will be reconciled by the C-3c GC pass.
///
/// `filename` carries the display name the row held at the time of deletion,
/// for the same reason `fs_path` does: `rename_attachment` is a first-class op,
/// so the name on the original `add_attachment` is the name the row was *born*
/// with, not the one it was deleted under. Reconstructing the undo from the add
/// payload alone therefore resurrects a pre-rename name (#4262). Marked
/// `#[serde(default)]` so op-log entries written before #4262 still deserialize
/// — they yield `filename = ""`, which
/// `reverse::attachment_ops::adopt_delete_time_state` treats as "nothing was
/// recorded" and falls back to the `add_attachment` name.
///
/// `attachment_id` is an [`AttachmentId`] (alias of [`BlockId`]) for the
/// same uppercase-normalization contract as [`AddAttachmentPayload`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteAttachmentPayload {
    pub attachment_id: AttachmentId,
    #[serde(default)]
    pub fs_path: String,
    #[serde(default)]
    pub filename: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameAttachmentPayload {
    pub attachment_id: AttachmentId,
    pub old_filename: String,
    pub new_filename: String,
}

// ---------------------------------------------------------------------------
// Undo/Redo types
// ---------------------------------------------------------------------------

/// Reference to a specific op in the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct OpRef {
    pub device_id: String,
    pub seq: i64,
}

/// Result of an undo or redo operation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UndoResult {
    /// The op that was reversed (the original op for undo, the undo-op for redo).
    pub reversed_op: OpRef,
    /// The op_type of the reversed op (e.g. `create_block`, `edit_block`, `set_property`).
    /// Used by the frontend to show a descriptive toast ("Undid create", "Undid edit", etc.).
    pub reversed_op_type: String,
    /// The newly appended reverse op.
    pub new_op_ref: OpRef,
    /// The op_type of the newly appended op.
    pub new_op_type: String,
    /// Whether this was a redo (true) or undo (false).
    pub is_redo: bool,
}

// ---------------------------------------------------------------------------
// OpPayload — tagged union of all payload structs
// ---------------------------------------------------------------------------

/// Wrapper enum for all op payloads. Uses serde's internally-tagged
/// representation so that serialized JSON includes `"op_type": "..."` alongside
/// the payload fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op_type", rename_all = "snake_case")]
pub enum OpPayload {
    CreateBlock(CreateBlockPayload),
    EditBlock(EditBlockPayload),
    DeleteBlock(DeleteBlockPayload),
    RestoreBlock(RestoreBlockPayload),
    PurgeBlock(PurgeBlockPayload),
    MoveBlock(MoveBlockPayload),
    AddTag(AddTagPayload),
    RemoveTag(RemoveTagPayload),
    SetProperty(SetPropertyPayload),
    DeleteProperty(DeletePropertyPayload),
    AddAttachment(AddAttachmentPayload),
    DeleteAttachment(DeleteAttachmentPayload),
    RenameAttachment(RenameAttachmentPayload),
    AddPageAlias(AddPageAliasPayload),
    RemovePageAlias(RemovePageAliasPayload),
    SetPropertyDef(SetPropertyDefPayload),
    RenamePropertyKey(RenamePropertyKeyPayload),
    RewriteProperties(RewritePropertiesPayload),
    RenamePropertyOption(RenamePropertyOptionPayload),
}

impl OpPayload {
    /// Returns the [`OpType`] corresponding to this payload variant.
    pub fn op_type(&self) -> OpType {
        match self {
            OpPayload::CreateBlock(_) => OpType::CreateBlock,
            OpPayload::EditBlock(_) => OpType::EditBlock,
            OpPayload::DeleteBlock(_) => OpType::DeleteBlock,
            OpPayload::RestoreBlock(_) => OpType::RestoreBlock,
            OpPayload::PurgeBlock(_) => OpType::PurgeBlock,
            OpPayload::MoveBlock(_) => OpType::MoveBlock,
            OpPayload::AddTag(_) => OpType::AddTag,
            OpPayload::RemoveTag(_) => OpType::RemoveTag,
            OpPayload::SetProperty(_) => OpType::SetProperty,
            OpPayload::DeleteProperty(_) => OpType::DeleteProperty,
            OpPayload::AddAttachment(_) => OpType::AddAttachment,
            OpPayload::DeleteAttachment(_) => OpType::DeleteAttachment,
            OpPayload::RenameAttachment(_) => OpType::RenameAttachment,
            OpPayload::AddPageAlias(_) => OpType::AddPageAlias,
            OpPayload::RemovePageAlias(_) => OpType::RemovePageAlias,
            OpPayload::SetPropertyDef(_) => OpType::SetPropertyDef,
            OpPayload::RenamePropertyKey(_) => OpType::RenamePropertyKey,
            OpPayload::RewriteProperties(_) => OpType::RewriteProperties,
            OpPayload::RenamePropertyOption(_) => OpType::RenamePropertyOption,
        }
    }

    /// Returns the op type as a snake_case string suitable for the
    /// `op_log.op_type` column.
    ///
    /// Delegates to [`OpType::as_str`] to keep the string mapping in one place.
    pub fn op_type_str(&self) -> &'static str {
        self.op_type().as_str()
    }

    /// Returns the `block_id` from the inner payload, if present.
    ///
    /// The alias variants answer their `page_id`, and the definition variants
    /// (`SetPropertyDef`, `RenamePropertyKey`, `RewriteProperties`,
    /// `RenamePropertyOption`) their `space_id`. `DeleteAttachment` and
    /// `RenameAttachment` identify the target by `attachment_id` only, so this
    /// method returns `None` for them.
    pub fn block_id(&self) -> Option<&str> {
        match self {
            OpPayload::CreateBlock(p) => Some(p.block_id.as_str()),
            OpPayload::EditBlock(p) => Some(p.block_id.as_str()),
            OpPayload::DeleteBlock(p) => Some(p.block_id.as_str()),
            OpPayload::RestoreBlock(p) => Some(p.block_id.as_str()),
            OpPayload::PurgeBlock(p) => Some(p.block_id.as_str()),
            OpPayload::MoveBlock(p) => Some(p.block_id.as_str()),
            OpPayload::AddTag(p) => Some(p.block_id.as_str()),
            OpPayload::RemoveTag(p) => Some(p.block_id.as_str()),
            OpPayload::SetProperty(p) => Some(p.block_id.as_str()),
            OpPayload::DeleteProperty(p) => Some(p.block_id.as_str()),
            OpPayload::AddAttachment(p) => Some(p.block_id.as_str()),
            OpPayload::DeleteAttachment(_) => None,
            OpPayload::RenameAttachment(_) => None,
            OpPayload::AddPageAlias(p) => Some(p.page_id.as_str()),
            OpPayload::RemovePageAlias(p) => Some(p.page_id.as_str()),
            OpPayload::SetPropertyDef(p) => Some(p.space_id.as_str()),
            OpPayload::RenamePropertyKey(p) => Some(p.space_id.as_str()),
            OpPayload::RewriteProperties(p) => Some(p.space_id.as_str()),
            OpPayload::RenamePropertyOption(p) => Some(p.space_id.as_str()),
        }
    }

    /// Returns the `attachment_id` from the inner payload, if present.
    ///
    /// The three attachment variants carry an `attachment_id`; every other
    /// variant identifies its target by `block_id` and returns `None` here.
    ///
    /// Used by `op_log::append_local_op_in_tx`, `dag::append_merge_op`,
    /// and `dag::insert_remote_op` to populate the indexed
    /// `op_log.attachment_id` column added by migration 0064
    /// (SQL-review B-4), so reverse-attachment lookups are O(log N)
    /// rather than scanning every `add_attachment` row.
    pub fn attachment_id(&self) -> Option<&str> {
        match self {
            OpPayload::AddAttachment(p) => Some(p.attachment_id.as_str()),
            OpPayload::DeleteAttachment(p) => Some(p.attachment_id.as_str()),
            OpPayload::RenameAttachment(p) => Some(p.attachment_id.as_str()),
            OpPayload::CreateBlock(_)
            | OpPayload::EditBlock(_)
            | OpPayload::DeleteBlock(_)
            | OpPayload::RestoreBlock(_)
            | OpPayload::PurgeBlock(_)
            | OpPayload::MoveBlock(_)
            | OpPayload::AddTag(_)
            | OpPayload::RemoveTag(_)
            | OpPayload::SetProperty(_)
            | OpPayload::DeleteProperty(_)
            | OpPayload::AddPageAlias(_)
            | OpPayload::RemovePageAlias(_)
            | OpPayload::SetPropertyDef(_)
            | OpPayload::RenamePropertyKey(_)
            | OpPayload::RewriteProperties(_)
            | OpPayload::RenamePropertyOption(_) => None,
        }
    }

    /// No-op contract marker: BlockId fields already auto-normalize to
    /// uppercase Crockford base32 on construction and deserialization
    /// (see `BlockId::from_trusted` and the `Deserialize` impl). This
    /// method is retained as an explicit call-site marker so the
    /// normalization invariant is greppable from the op-log append
    /// path; the body is intentionally empty.
    pub fn normalize_block_ids(&mut self) {}
}

/// The four "fixed" property keys that are stored as dedicated same-named
/// columns on the `blocks` table (`todo_state`, `priority`, `due_date`,
/// `scheduled_date`) rather than as `block_properties` rows.
///
/// #589 — single source of truth for the reserved-key set. The migration-0088
/// `key_not_reserved` CHECK on `block_properties` and `db::reserved_key_blocks_column`
/// must stay in sync with [`COLUMN_BACKED_PROPERTY_KEYS`] (which is this set plus
/// `space`); the drift tests in `db.rs`
/// (`reserved_key_set_matches_db_check_constraint_589`,
/// `reserved_key_blocks_column_covers_column_backed_set_589`,
/// `block_properties_rejects_reserved_key_534`) fail if they drift.
pub const RESERVED_PROPERTY_KEYS: [&str; 4] =
    ["todo_state", "priority", "due_date", "scheduled_date"];

/// The `space` property is also column-backed (`blocks.space_id`, #533) but is
/// routed separately from the four [`RESERVED_PROPERTY_KEYS`] because it maps to
/// a differently-named column with page-group fan-out.
pub const SPACE_PROPERTY_KEY: &str = "space";

/// Every property key that lives in a dedicated `blocks` column and is therefore
/// FORBIDDEN as a `block_properties` row (enforced by the migration-0088 CHECK):
/// the four [`RESERVED_PROPERTY_KEYS`] plus [`SPACE_PROPERTY_KEY`]. (#589)
pub const COLUMN_BACKED_PROPERTY_KEYS: [&str; 5] = [
    RESERVED_PROPERTY_KEYS[0],
    RESERVED_PROPERTY_KEYS[1],
    RESERVED_PROPERTY_KEYS[2],
    RESERVED_PROPERTY_KEYS[3],
    SPACE_PROPERTY_KEY,
];

/// Reserved property keys that map to fixed columns on the `blocks` table.
pub fn is_reserved_property_key(key: &str) -> bool {
    RESERVED_PROPERTY_KEYS.contains(&key)
}

/// Whether `key` is column-backed on `blocks` and thus forbidden as a
/// `block_properties` row (the four reserved keys plus `space`). (#589)
pub fn is_column_backed_property_key(key: &str) -> bool {
    COLUMN_BACKED_PROPERTY_KEYS.contains(&key)
}

/// A built-in property definition (#5841): a code constant, so it is the same
/// in every vault and on every device, and nothing can create, edit or delete
/// it. `property_definitions` holds only the user's own definitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinPropertyDef {
    pub key: &'static str,
    pub value_type: &'static str,
    /// A `select`'s allowed values, in display order; `None` for other types.
    pub options: Option<&'static [&'static str]>,
}

impl BuiltinPropertyDef {
    const fn of(key: &'static str, value_type: &'static str) -> Self {
        Self {
            key,
            value_type,
            options: None,
        }
    }

    const fn select(key: &'static str, options: &'static [&'static str]) -> Self {
        Self {
            key,
            value_type: "select",
            options: Some(options),
        }
    }

    /// The options as the JSON array `property_definitions.options` stores.
    pub fn options_json(&self) -> Option<String> {
        self.options
            .map(|options| serde_json::to_string(options).expect("a list of strings serializes"))
    }
}

/// The built-in `priority` options, highest first.
pub const PRIORITY_LEVELS: [&str; 3] = ["1", "2", "3"];

/// Every built-in property definition (#5841): the reserved column keys,
/// the task-lifecycle and recurrence keys the app writes itself, the space
/// membership keys and the list style. Mirrored by `BUILTIN_PROPERTY_DEFS` in
/// `src/lib/property-save-utils.ts`, which
/// `property-save-utils-rust-parity.test.ts` parses this array against.
pub const BUILTIN_PROPERTY_DEFS: [BuiltinPropertyDef; 14] = [
    BuiltinPropertyDef::select("todo_state", &["TODO", "DOING", "DONE", "CANCELLED"]),
    BuiltinPropertyDef::select("priority", &PRIORITY_LEVELS),
    BuiltinPropertyDef::of("due_date", "date"),
    BuiltinPropertyDef::of("scheduled_date", "date"),
    BuiltinPropertyDef::of("created_at", "date"),
    BuiltinPropertyDef::of("completed_at", "date"),
    BuiltinPropertyDef::of("repeat", "text"),
    BuiltinPropertyDef::of("repeat-until", "date"),
    BuiltinPropertyDef::of("repeat-count", "number"),
    BuiltinPropertyDef::of("repeat-seq", "number"),
    BuiltinPropertyDef::of("repeat-origin", "text"),
    BuiltinPropertyDef::of("space", "ref"),
    BuiltinPropertyDef::select("is_space", &["true"]),
    BuiltinPropertyDef::select("listStyle", &["bullet", "ordered"]),
];

/// The keys the app writes for its own bookkeeping, which a user's rename or
/// merge moves neither from nor onto (#5841): the built-ins the app sets itself,
/// the template markers, the image layout and a migration marker. Mirrored by
/// `INTERNAL_PROPERTY_KEYS` in `src/lib/block-utils.ts`.
pub const INTERNAL_PROPERTY_KEYS: [&str; 14] = [
    "repeat",
    "created_at",
    "completed_at",
    "repeat-seq",
    "repeat-origin",
    "is_space",
    "accent_color",
    "personal_to_work_migration_v1",
    "template",
    "journal-template",
    "listStyle",
    "image_width",
    "image_alignment",
    "image_caption",
];

/// Whether `key` is one of the [`INTERNAL_PROPERTY_KEYS`].
pub fn is_internal_property_key(key: &str) -> bool {
    INTERNAL_PROPERTY_KEYS.contains(&key)
}

/// The built-in definition of `key`, or `None` for a user's key.
pub fn builtin_property_def(key: &str) -> Option<&'static BuiltinPropertyDef> {
    BUILTIN_PROPERTY_DEFS.iter().find(|def| def.key == key)
}

/// Whether `key` has a built-in definition, which nothing can create, edit or
/// delete (#5841).
///
/// User-settable properties like `effort`, `assignee`, and `location` are
/// intentionally **not** built in — users must be able to remove them.
pub fn is_builtin_property_key(key: &str) -> bool {
    builtin_property_def(key).is_some()
}

/// The schema allows multiple value columns (text, num, date, ref) but the
/// domain invariant is that exactly one must be set per operation. This
/// function enforces that invariant at the command layer, before the payload
/// is appended to the op log.
///
/// Key format: alphanumeric characters, hyphens, and underscores only,
/// 1–64 characters. This prevents garbage keys that could break UI rendering
/// or sync.
///
/// Returns `Ok(())` if valid, or an `AppError::Validation` describing the
/// violation.
///
/// # Hand-ported twin
///
/// `validateSetPropertyPayload` in
/// `src/components/editor/__tests__/BlockPropertyEditor.test.tsx` re-implements
/// the rules below in TypeScript, so the chip-editor suite can reject exactly
/// what this function rejects (a fixture that always answered "ok" hid a live
/// rename failure). Nothing checks the two for drift: change the payload rules
/// here and that hand-port needs the same change, or the frontend suite starts
/// accepting payloads the backend refuses.
pub fn validate_set_property(p: &SetPropertyPayload) -> Result<(), agaric_core::error::AppError> {
    // Validate key format: alphanumeric + hyphens + underscores, 1-64 chars
    if p.key.is_empty() || p.key.len() > 64 {
        return Err(agaric_core::error::AppError::validation(format!(
            "property key must be 1-64 characters, got {} characters",
            p.key.len()
        )));
    }
    if !p
        .key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(agaric_core::error::AppError::validation(format!(
            "property key must contain only alphanumeric characters, hyphens, and underscores, got '{}'",
            p.key
        )));
    }

    // Reject NaN / Infinity — these are not valid domain values and would
    // corrupt downstream consumers that expect finite numbers.
    if let Some(num) = p.value_num
        && !num.is_finite()
    {
        return Err(agaric_core::error::AppError::validation(format!(
            "value_num must be finite, got {num}"
        )));
    }

    let count = [
        p.value_text.is_some(),
        p.value_num.is_some(),
        p.value_date.is_some(),
        p.value_ref.is_some(),
        p.value_bool.is_some(),
    ]
    .iter()
    .filter(|&&b| b)
    .count();

    if count == 1 {
        // Reject empty / whitespace-only string fields. The frontend
        // already enforces non-empty values, but op-log entries can also
        // originate from MCP tools and import paths, so backend-side
        // validation prevents downstream parse failures (e.g. agenda code
        // parses `value_date` as ISO 8601 and chokes on `""`).
        // `value_num` is unaffected — finite-ness is checked above.
        if p.value_text.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(agaric_core::error::AppError::validation(
                "set_property.value_text.empty".into(),
            ));
        }
        if p.value_date.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(agaric_core::error::AppError::validation(
                "set_property.value_date.empty".into(),
            ));
        }
        if p.value_ref
            .as_ref()
            .is_some_and(|b| b.as_str().trim().is_empty())
        {
            return Err(agaric_core::error::AppError::validation(
                "set_property.value_ref.empty".into(),
            ));
        }
        Ok(())
    } else if count == 0 && is_reserved_property_key(&p.key) {
        // Reserved keys allow all-null values (= clear the column)
        Ok(())
    } else {
        Err(agaric_core::error::AppError::validation(format!(
            "SetProperty must have exactly 1 non-null value field, found {count}"
        )))
    }
}

// ===========================================================================
// Tests
// ===========================================================================

/// Tests for `OpType`, `OpPayload`, and every payload struct.
///
/// Covers serde round-trips, `Display`/`FromStr` consistency, `block_id()`
/// extraction, raw-JSON deserialization, error handling for malformed or
/// unknown inputs, and edge cases (unicode, empty, large content, optional
/// fields).
#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Valid ULID fixture constants for tests that go through serde round-trips.
    const TEST_BID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const TEST_PID: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const TEST_TID: &str = "01BX5ZZKBKACTAV9WEVGEMMVS0";

    /// All OpType variants, for exhaustive iteration in tests.
    fn all_op_types() -> Vec<OpType> {
        vec![
            OpType::CreateBlock,
            OpType::EditBlock,
            OpType::DeleteBlock,
            OpType::RestoreBlock,
            OpType::PurgeBlock,
            OpType::MoveBlock,
            OpType::AddTag,
            OpType::RemoveTag,
            OpType::SetProperty,
            OpType::DeleteProperty,
            OpType::AddAttachment,
            OpType::DeleteAttachment,
            OpType::RenameAttachment,
            OpType::AddPageAlias,
            OpType::RemovePageAlias,
            OpType::SetPropertyDef,
            OpType::RenamePropertyKey,
            OpType::RewriteProperties,
            OpType::RenamePropertyOption,
        ]
    }

    /// Builds one test instance of each OpPayload variant with valid ULID block_ids
    /// so serde round-trips work.
    fn all_test_payloads() -> Vec<OpPayload> {
        vec![
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_string(TEST_PID).unwrap()),
                position: Some(1),
                index: None,
                content: "hello".into(),
            }),
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                to_text: "updated".into(),
                prev_edit: Some(("dev-1".into(), 1)),
                prior_text: None,
            }),
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
            }),
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                deleted_at_ref: 1_735_689_600_000, // 2025-01-01T00:00:00Z
            }),
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
            }),
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                new_parent_id: Some(BlockId::from_string(TEST_PID).unwrap()),
                new_position: 3,
                new_index: None,
                prior: None,
            }),
            OpPayload::AddTag(AddTagPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                tag_id: BlockId::from_string(TEST_TID).unwrap(),
            }),
            OpPayload::RemoveTag(RemoveTagPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                tag_id: BlockId::from_string(TEST_TID).unwrap(),
            }),
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            }),
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                key: "priority".into(),
                prior: None,
            }),
            OpPayload::AddAttachment(AddAttachmentPayload {
                attachment_id: BlockId::test_id("A1"),
                block_id: BlockId::from_string(TEST_BID).unwrap(),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
                content_hash: Some("blake3-of-photo".into()),
            }),
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: BlockId::test_id("A1"),
                fs_path: "/tmp/photo.png".into(),
                filename: "photo.png".into(),
            }),
            OpPayload::RenameAttachment(RenameAttachmentPayload {
                attachment_id: BlockId::test_id("A1"),
                old_filename: "old.png".into(),
                new_filename: "new.png".into(),
            }),
            OpPayload::AddPageAlias(AddPageAliasPayload {
                page_id: BlockId::from_string(TEST_BID).unwrap(),
                alias: "Plans".into(),
            }),
            OpPayload::RemovePageAlias(RemovePageAliasPayload {
                page_id: BlockId::from_string(TEST_BID).unwrap(),
                alias: "Plans".into(),
            }),
            OpPayload::SetPropertyDef(SetPropertyDefPayload {
                space_id: BlockId::from_string(TEST_BID).unwrap(),
                key: "stage".into(),
                def: Some(PropertyDefState {
                    value_type: "select".into(),
                    options: Some(r#"["draft","done"]"#.into()),
                }),
                prior: Some(PropertyDefState {
                    value_type: "select".into(),
                    options: Some(r#"["draft"]"#.into()),
                }),
            }),
            OpPayload::RenamePropertyKey(RenamePropertyKeyPayload {
                space_id: BlockId::from_string(TEST_BID).unwrap(),
                old_key: "project".into(),
                new_key: "area".into(),
            }),
            OpPayload::RewriteProperties(RewritePropertiesPayload {
                space_id: BlockId::from_string(TEST_BID).unwrap(),
                reason: RewriteReason::Merge,
                defs: vec![
                    PropertyDefWrite {
                        key: "stage".into(),
                        def: None,
                        prior: Some(PropertyDefState {
                            value_type: "select".into(),
                            options: Some(r#"["a"]"#.into()),
                        }),
                    },
                    PropertyDefWrite {
                        key: "phase".into(),
                        def: Some(PropertyDefState {
                            value_type: "select".into(),
                            options: Some(r#"["b","a"]"#.into()),
                        }),
                        prior: Some(PropertyDefState {
                            value_type: "select".into(),
                            options: Some(r#"["b"]"#.into()),
                        }),
                    },
                ],
                values: vec![
                    PropertyValueWrite {
                        block_id: BlockId::from_string(TEST_PID).unwrap(),
                        key: "stage".into(),
                        value: None,
                        prior: Some(PropertyValueFields {
                            value_text: Some("a".into()),
                            ..Default::default()
                        }),
                    },
                    PropertyValueWrite {
                        block_id: BlockId::from_string(TEST_PID).unwrap(),
                        key: "phase".into(),
                        value: Some(PropertyValueFields {
                            value_text: Some("a".into()),
                            ..Default::default()
                        }),
                        prior: None,
                    },
                ],
            }),
            OpPayload::RenamePropertyOption(RenamePropertyOptionPayload {
                space_id: BlockId::from_string(TEST_BID).unwrap(),
                key: "stage".into(),
                old_option: "review".into(),
                new_option: "in_review".into(),
            }),
        ]
    }

    // -----------------------------------------------------------------------
    // 1. Serde roundtrip — every payload type
    // -----------------------------------------------------------------------

    #[test]
    fn all_payload_serde_roundtrip() {
        let payloads = all_test_payloads();
        // Sanity: we must cover every variant
        assert_eq!(payloads.len(), all_op_types().len());

        for payload in payloads {
            let tag = payload.op_type_str();
            let json =
                serde_json::to_string(&payload).unwrap_or_else(|e| panic!("serialize {tag}: {e}"));

            // Internally-tagged representation must include the op_type field
            assert!(
                json.contains(&format!("\"op_type\":\"{tag}\"")),
                "{tag}: missing op_type tag in {json}"
            );

            // Deserialize back and verify the tag round-trips
            let deser: OpPayload =
                serde_json::from_str(&json).unwrap_or_else(|e| panic!("deserialize {tag}: {e}"));
            assert_eq!(deser.op_type_str(), tag);

            // Re-serialize and verify JSON stability (serialize -> deser -> serialize)
            let json2 = serde_json::to_string(&deser).unwrap();
            assert_eq!(json, json2, "{tag}: re-serialization mismatch");
        }
    }

    // -----------------------------------------------------------------------
    // 2. Individual payload edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn edit_block_prev_edit_serializes_as_array_or_null() {
        let with = EditBlockPayload {
            block_id: BlockId::test_id("B1"),
            to_text: "new text".into(),
            prev_edit: Some(("device-1".into(), 5)),
            prior_text: None,
        };
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains("[\"device-1\",5]"));

        let without = EditBlockPayload {
            block_id: BlockId::test_id("B1"),
            to_text: "new text".into(),
            prev_edit: None,
            prior_text: None,
        };
        let json = serde_json::to_string(&without).unwrap();
        assert!(json.contains("\"prev_edit\":null"));
    }

    #[test]
    fn create_block_with_null_optional_fields_roundtrips() {
        let p = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            index: None,
            content: String::new(),
        });
        let json = serde_json::to_string(&p).unwrap();
        assert!(
            json.contains("\"parent_id\":null"),
            "parent_id should serialize as null"
        );
        // #400: the sibling-slot fields are `skip_serializing_if = is_none`, so
        // a `None` is OMITTED (keeps new-op payloads minimal). The old behaviour
        // serialized `"position":null`; legacy rows still deserialize (below).
        assert!(
            !json.contains("\"position\""),
            "position should be omitted when None, got {json}"
        );
        assert!(
            !json.contains("\"index\""),
            "index should be omitted when None, got {json}"
        );

        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::CreateBlock(inner) = deser else {
            panic!("expected CreateBlock variant");
        };
        assert!(inner.parent_id.is_none(), "parent_id should be None");
        assert!(inner.position.is_none(), "position should be None");
        assert!(inner.index.is_none(), "index should be None");
    }

    /// #400 backwards-compat: a pre-#400 `create_block` row serialized
    /// `"position":null` (and no `index`). It must still deserialize, with
    /// `position` → `None` and `index` → `None` (serde default).
    #[test]
    fn create_block_legacy_json_with_explicit_null_position_deserializes() {
        let legacy = r#"{
            "op_type": "create_block",
            "block_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "block_type": "content",
            "parent_id": null,
            "position": null,
            "content": "x"
        }"#;
        let deser: OpPayload = serde_json::from_str(legacy).unwrap();
        let OpPayload::CreateBlock(inner) = deser else {
            panic!("expected CreateBlock variant");
        };
        assert!(inner.position.is_none());
        assert!(inner.index.is_none());
    }

    /// #400 backwards-compat: a pre-#400 `move_block` row carried `new_position`
    /// and no `new_index`. It must deserialize with `new_index` → `None`.
    #[test]
    fn move_block_legacy_json_without_new_index_deserializes() {
        let legacy = r#"{
            "op_type": "move_block",
            "block_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "new_parent_id": null,
            "new_position": 3
        }"#;
        let deser: OpPayload = serde_json::from_str(legacy).unwrap();
        let OpPayload::MoveBlock(inner) = deser else {
            panic!("expected MoveBlock variant");
        };
        assert_eq!(inner.new_position, 3);
        assert!(inner.new_index.is_none());
    }

    /// #400 forward (new-scheme) wire shape: a payload that actually CARRIES a
    /// `index` / `new_index` slot must serialize the field (as a number) and
    /// round-trip back to the same `Some` value. The omit-when-`None` tests
    /// above only cover the legacy shape; this locks in the JSON every future
    /// #400 op writes to the op log.
    #[test]
    fn create_and_move_block_with_index_some_roundtrip() {
        // create_block carrying a 0-based slot.
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            index: Some(2),
            content: "x".into(),
        });
        let cjson = serde_json::to_string(&create).unwrap();
        assert!(
            cjson.contains("\"index\":2"),
            "index Some(2) must serialize, got {cjson}"
        );
        let OpPayload::CreateBlock(cdeser) = serde_json::from_str(&cjson).unwrap() else {
            panic!("expected CreateBlock variant");
        };
        assert_eq!(cdeser.index, Some(2));
        assert!(cdeser.position.is_none());

        // move_block carrying a 0-based slot + its 1-based breadcrumb.
        let mv = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            new_parent_id: None,
            new_position: 3,
            new_index: Some(2),
            prior: None,
        });
        let mjson = serde_json::to_string(&mv).unwrap();
        assert!(
            mjson.contains("\"new_index\":2"),
            "new_index Some(2) must serialize, got {mjson}"
        );
        let OpPayload::MoveBlock(mdeser) = serde_json::from_str(&mjson).unwrap() else {
            panic!("expected MoveBlock variant");
        };
        assert_eq!(mdeser.new_index, Some(2));
        assert_eq!(mdeser.new_position, 3);
    }

    /// Backwards-compat: pre-existing op-log rows for `set_property`
    /// were written without a `value_bool` field. Those entries must continue
    /// to deserialize, with `value_bool` defaulting to `None`. Mirrors the
    /// `delete_attachment_payload_legacy_json_deserializes_without_fs_path`
    /// pattern below.
    #[test]
    fn set_property_payload_legacy_json_deserializes_without_value_bool() {
        let legacy = r#"{
            "block_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "key": "priority",
            "value_text": "high",
            "value_num": null,
            "value_date": null,
            "value_ref": null
        }"#;
        let parsed: SetPropertyPayload = serde_json::from_str(legacy)
            .expect("legacy SetPropertyPayload JSON without value_bool must still deserialize");
        assert!(
            parsed.value_bool.is_none(),
            "missing value_bool in legacy JSON must default to None"
        );
        assert_eq!(parsed.value_text.as_deref(), Some("high"));

        // Also exercise the OpPayload-tagged form (the on-wire shape used by
        // the op_log; the inner-struct test above guards serde_json::from_str
        // on the bare payload).
        let legacy_tagged = r#"{
            "op_type": "set_property",
            "block_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "key": "priority",
            "value_text": "high",
            "value_num": null,
            "value_date": null,
            "value_ref": null
        }"#;
        let parsed: OpPayload = serde_json::from_str(legacy_tagged)
            .expect("legacy tagged OpPayload JSON without value_bool must still deserialize");
        match parsed {
            OpPayload::SetProperty(inner) => {
                assert!(inner.value_bool.is_none());
                assert_eq!(inner.value_text.as_deref(), Some("high"));
            }
            other => panic!("expected SetProperty, got {other:?}"),
        }
    }

    /// #6014: an empty `prior` records that the key was absent, so it has to
    /// survive the stored JSON as a present object. Dropped on write, it would
    /// read back as the `None` of an older op, and its reverse would ask the op
    /// log again.
    #[test]
    fn set_property_empty_prior_is_stored_and_read_back_as_present() {
        let payload = SetPropertyPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            key: "effort".into(),
            value_text: Some("2h".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: Some(PropertyValueFields::default()),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(
            json["prior"],
            serde_json::json!({
                "value_text": null,
                "value_num": null,
                "value_date": null,
                "value_ref": null,
                "value_bool": null,
            })
        );
        let read_back: SetPropertyPayload = serde_json::from_value(json).unwrap();
        assert_eq!(read_back.prior, Some(PropertyValueFields::default()));
    }

    /// #6014: only a value with no slot set reads as "held none". A `false`, a
    /// `0` and an empty string are values, and each sets its slot.
    #[test]
    fn property_value_into_held_is_none_only_when_every_slot_is_empty() {
        assert_eq!(PropertyValueFields::default().into_held(), None);
        for held in [
            PropertyValueFields {
                value_bool: Some(false),
                ..Default::default()
            },
            PropertyValueFields {
                value_num: Some(0.0),
                ..Default::default()
            },
            PropertyValueFields {
                value_text: Some(String::new()),
                ..Default::default()
            },
        ] {
            assert_eq!(held.clone().into_held(), Some(held));
        }
    }

    /// #6106: the value a set writes is the value its undo deletes and its
    /// redo restores, so a payload reads back each slot it was built with.
    #[test]
    fn set_property_payload_value_is_the_value_it_was_built_with() {
        for value in [
            PropertyValueFields {
                value_text: Some("draft".into()),
                ..Default::default()
            },
            PropertyValueFields {
                value_num: Some(3.0),
                ..Default::default()
            },
            PropertyValueFields {
                value_date: Some("2026-10-28".into()),
                ..Default::default()
            },
            PropertyValueFields {
                value_ref: Some(BlockId::from_trusted(TEST_PID)),
                ..Default::default()
            },
            PropertyValueFields {
                value_bool: Some(true),
                ..Default::default()
            },
        ] {
            let payload = SetPropertyPayload::with_value(
                BlockId::from_trusted(TEST_BID),
                "k".into(),
                value.clone(),
            );
            assert_eq!(payload.value(), value);
        }
    }

    /// C-3a backwards-compat: pre-existing op-log rows for `delete_attachment`
    /// were written without an `fs_path` field. Those entries must continue to
    /// deserialize, with `fs_path` defaulting to the empty string. The C-3c
    /// GC pass is responsible for reconciling such rows against on-disk state.
    #[test]
    fn delete_attachment_payload_legacy_json_deserializes_without_fs_path() {
        let legacy = r#"{"attachment_id":"ATT-LEGACY"}"#;
        let parsed: DeleteAttachmentPayload = serde_json::from_str(legacy)
            .expect("legacy DeleteAttachmentPayload JSON without fs_path must still deserialize");
        assert_eq!(parsed.attachment_id, "ATT-LEGACY");
        assert_eq!(
            parsed.fs_path, "",
            "missing fs_path in legacy JSON must default to empty string"
        );

        // Also exercise the OpPayload-tagged form (this is the on-wire shape
        // used by the op_log; the inner-struct test above guards
        // serde_json::from_str on the bare payload).
        let legacy_tagged = r#"{"op_type":"delete_attachment","attachment_id":"ATT-LEGACY-2"}"#;
        let parsed: OpPayload = serde_json::from_str(legacy_tagged)
            .expect("legacy tagged OpPayload JSON without fs_path must still deserialize");
        match parsed {
            OpPayload::DeleteAttachment(inner) => {
                assert_eq!(inner.attachment_id, "ATT-LEGACY-2");
                assert_eq!(inner.fs_path, "");
            }
            other => panic!("expected DeleteAttachment, got {other:?}"),
        }
    }

    /// #4262 backwards-compat, the same shape as the C-3a `fs_path` test
    /// above: op-log rows for `delete_attachment` written before #4262 carry
    /// no `filename`. Those entries must keep deserializing, with `filename`
    /// defaulting to the empty string — the sentinel
    /// `reverse::attachment_ops::adopt_delete_time_state` reads as "no
    /// delete-time name was ever recorded", so the reverse falls back to the
    /// original `add_attachment`'s name (the pre-#4262 behaviour, for exactly
    /// the ops that predate the fix).
    #[test]
    fn delete_attachment_payload_legacy_json_deserializes_without_filename() {
        // The pre-#4262 shape: `fs_path` present (C-3 added it), `filename`
        // absent. This is the JSON actually sitting in op logs today.
        let legacy = r#"{"attachment_id":"ATT-LEGACY-3","fs_path":"attachments/photo.png"}"#;
        let parsed: DeleteAttachmentPayload = serde_json::from_str(legacy)
            .expect("legacy DeleteAttachmentPayload JSON without filename must still deserialize");
        assert_eq!(parsed.attachment_id, "ATT-LEGACY-3");
        assert_eq!(parsed.fs_path, "attachments/photo.png");
        assert_eq!(
            parsed.filename, "",
            "missing filename in legacy JSON must default to empty string"
        );

        // And the on-wire `OpPayload`-tagged form the op_log actually stores.
        let legacy_tagged = r#"{"op_type":"delete_attachment","attachment_id":"ATT-LEGACY-4","fs_path":"attachments/photo.png"}"#;
        let parsed: OpPayload = serde_json::from_str(legacy_tagged)
            .expect("legacy tagged OpPayload JSON without filename must still deserialize");
        match parsed {
            OpPayload::DeleteAttachment(inner) => {
                assert_eq!(inner.attachment_id, "ATT-LEGACY-4");
                assert_eq!(inner.fs_path, "attachments/photo.png");
                assert_eq!(inner.filename, "");
            }
            other => panic!("expected DeleteAttachment, got {other:?}"),
        }
    }

    /// #5608 step 6: an `add_attachment` written before `content_hash` existed
    /// decodes with no hash, and re-serializes to the exact text it was stored
    /// as, so its op hash still verifies.
    #[test]
    fn add_attachment_payload_legacy_json_decodes_and_reserializes_unchanged() {
        let legacy = r#"{"op_type":"add_attachment","attachment_id":"ATT-LEGACY-5","block_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","mime_type":"image/png","filename":"photo.png","size_bytes":9,"fs_path":"attachments/photo.png"}"#;
        let parsed: OpPayload = serde_json::from_str(legacy)
            .expect("an add_attachment without content_hash must still decode");
        let OpPayload::AddAttachment(inner) = &parsed else {
            panic!("expected AddAttachment, got {parsed:?}");
        };
        assert_eq!(inner.content_hash, None);
        assert_eq!(serde_json::to_string(&parsed).unwrap(), legacy);
    }

    /// #5608 step 6: the hash round-trips when present.
    #[test]
    fn add_attachment_payload_round_trips_with_content_hash() {
        let payload = AddAttachmentPayload {
            attachment_id: BlockId::test_id("A1"),
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 9,
            fs_path: "attachments/photo.png".into(),
            content_hash: Some("ab12".into()),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""content_hash":"ab12""#), "got {json}");
        let back: AddAttachmentPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
    }

    /// #5841 S3: a type change is a `rewrite_properties` whose reason is
    /// `change_type`: one definition write, and a value write per value it
    /// converts. `all_test_payloads` holds one payload per op
    /// type, so this one is pinned on its own.
    #[test]
    fn rewrite_properties_change_type_round_trips_5841() {
        let def = |value_type: &str| PropertyDefState {
            value_type: value_type.into(),
            options: None,
        };
        let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
            space_id: BlockId::from_string(TEST_BID).unwrap(),
            reason: RewriteReason::ChangeType,
            defs: vec![PropertyDefWrite {
                key: "effort".into(),
                def: Some(def("number")),
                prior: Some(def("text")),
            }],
            values: vec![
                PropertyValueWrite {
                    block_id: BlockId::from_string(TEST_PID).unwrap(),
                    key: "effort".into(),
                    value: Some(PropertyValueFields {
                        value_num: Some(42.0),
                        ..Default::default()
                    }),
                    prior: Some(PropertyValueFields {
                        value_text: Some("042".into()),
                        ..Default::default()
                    }),
                },
                PropertyValueWrite {
                    block_id: BlockId::from_string(TEST_TID).unwrap(),
                    key: "effort".into(),
                    value: None,
                    prior: Some(PropertyValueFields {
                        value_text: Some("abc".into()),
                        ..Default::default()
                    }),
                },
            ],
        });
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["reason"], "change_type", "the reason's wire name");
        let back: OpPayload = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, payload, "round trip");
        insta::assert_yaml_snapshot!("op_payload_json_rewrite_properties_change_type", json);
    }

    /// #6206: removing a key's values that don't fit is a `rewrite_properties`
    /// whose reason is `remove_unfit`: no definition write, and a value write
    /// per value removed, recording it.
    #[test]
    fn rewrite_properties_remove_unfit_round_trips_6206() {
        let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
            space_id: BlockId::from_string(TEST_BID).unwrap(),
            reason: RewriteReason::RemoveUnfit,
            defs: Vec::new(),
            values: vec![
                PropertyValueWrite {
                    block_id: BlockId::from_string(TEST_PID).unwrap(),
                    key: "when".into(),
                    value: None,
                    prior: Some(PropertyValueFields {
                        value_text: Some("soon".into()),
                        ..Default::default()
                    }),
                },
                PropertyValueWrite {
                    block_id: BlockId::from_string(TEST_TID).unwrap(),
                    key: "when".into(),
                    value: None,
                    prior: Some(PropertyValueFields {
                        value_num: Some(5.0),
                        ..Default::default()
                    }),
                },
            ],
        });
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["reason"], "remove_unfit", "the reason's wire name");
        let back: OpPayload = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, payload, "round trip");
        insta::assert_yaml_snapshot!("op_payload_json_rewrite_properties_remove_unfit", json);
    }

    /// #6206: converting a key's values that don't fit is a
    /// `rewrite_properties` whose reason is `convert_unfit`: no definition
    /// write, and a value write per value replaced, recording it.
    #[test]
    fn rewrite_properties_convert_unfit_round_trips_6206() {
        let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
            space_id: BlockId::from_string(TEST_BID).unwrap(),
            reason: RewriteReason::ConvertUnfit,
            defs: Vec::new(),
            values: vec![PropertyValueWrite {
                block_id: BlockId::from_string(TEST_PID).unwrap(),
                key: "when".into(),
                value: Some(PropertyValueFields {
                    value_text: Some("2026-03-01".into()),
                    ..Default::default()
                }),
                prior: Some(PropertyValueFields {
                    value_text: Some("soon".into()),
                    ..Default::default()
                }),
            }],
        });
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["reason"], "convert_unfit", "the reason's wire name");
        let back: OpPayload = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, payload, "round trip");
        insta::assert_yaml_snapshot!("op_payload_json_rewrite_properties_convert_unfit", json);
    }

    /// #6206: moving a key's values that don't fit to another key is a
    /// `rewrite_properties` whose reason is `move_unfit`: no definition write,
    /// and per block the value removed under its key, then written under the
    /// other.
    #[test]
    fn rewrite_properties_move_unfit_round_trips_6206() {
        let payload = OpPayload::RewriteProperties(RewritePropertiesPayload {
            space_id: BlockId::from_string(TEST_BID).unwrap(),
            reason: RewriteReason::MoveUnfit,
            defs: Vec::new(),
            values: vec![
                PropertyValueWrite {
                    block_id: BlockId::from_string(TEST_PID).unwrap(),
                    key: "when".into(),
                    value: None,
                    prior: Some(PropertyValueFields {
                        value_num: Some(5.0),
                        ..Default::default()
                    }),
                },
                PropertyValueWrite {
                    block_id: BlockId::from_string(TEST_PID).unwrap(),
                    key: "notes".into(),
                    value: Some(PropertyValueFields {
                        value_text: Some("5".into()),
                        ..Default::default()
                    }),
                    prior: None,
                },
            ],
        });
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["reason"], "move_unfit", "the reason's wire name");
        let back: OpPayload = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, payload, "round trip");
        insta::assert_yaml_snapshot!("op_payload_json_rewrite_properties_move_unfit", json);
    }

    // -----------------------------------------------------------------------
    // 3. OpType — serde, Display, FromStr
    // -----------------------------------------------------------------------

    #[test]
    fn op_type_serializes_as_snake_case_string() {
        let serialized = serde_json::to_string(&OpType::AddAttachment).unwrap();
        assert_eq!(serialized, "\"add_attachment\"");

        let deser: OpType = serde_json::from_str("\"delete_property\"").unwrap();
        assert_eq!(deser, OpType::DeleteProperty);
    }

    #[test]
    fn op_type_as_str_matches_serde_for_all_variants() {
        for variant in all_op_types() {
            let serde_json_str = serde_json::to_string(&variant).unwrap();
            // serde produces `"snake_case"` — strip the surrounding quotes
            let serde_str = serde_json_str.trim_matches('"');
            assert_eq!(
                variant.as_str(),
                serde_str,
                "as_str() vs serde mismatch for {variant:?}"
            );
        }
    }

    #[test]
    fn op_type_display_matches_as_str_for_all_variants() {
        for variant in all_op_types() {
            assert_eq!(
                variant.to_string(),
                variant.as_str(),
                "Display vs as_str mismatch for {variant:?}"
            );
        }
    }

    #[test]
    fn op_type_from_str_roundtrip() {
        for variant in all_op_types() {
            let s = variant.as_str();
            let parsed: OpType = s.parse().unwrap_or_else(|e| panic!("parse '{s}': {e}"));
            assert_eq!(parsed, variant);
        }
    }

    #[test]
    fn op_type_from_str_rejects_invalid() {
        assert!("not_a_real_op".parse::<OpType>().is_err());
        assert!("CreateBlock".parse::<OpType>().is_err()); // PascalCase rejected
        assert!("CREATE_BLOCK".parse::<OpType>().is_err()); // UPPER_SNAKE rejected
        assert!("".parse::<OpType>().is_err());
    }

    // -----------------------------------------------------------------------
    // 4. OpPayload::op_type_str consistency with serde tag
    // -----------------------------------------------------------------------

    #[test]
    fn op_type_str_consistent_with_serde_tag() {
        for payload in all_test_payloads() {
            let json = serde_json::to_string(&payload).unwrap();
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            let serde_tag = value["op_type"].as_str().unwrap();
            assert_eq!(
                payload.op_type_str(),
                serde_tag,
                "op_type_str vs JSON tag mismatch for {:?}",
                payload.op_type()
            );
        }
    }

    // -----------------------------------------------------------------------
    // 5. OpPayload::block_id()
    // -----------------------------------------------------------------------

    #[test]
    fn block_id_returns_value_for_block_bearing_variants() {
        for payload in all_test_payloads() {
            match payload {
                OpPayload::DeleteAttachment(_) | OpPayload::RenameAttachment(_) => {
                    assert_eq!(
                        payload.block_id(),
                        None,
                        "DeleteAttachment/RenameAttachment should return None"
                    );
                }
                _ => {
                    assert_eq!(
                        payload.block_id(),
                        Some(TEST_BID),
                        "{:?} should have block_id {}",
                        payload.op_type(),
                        TEST_BID
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 6. Deserialization from raw JSON (simulating DB reads)
    // -----------------------------------------------------------------------

    #[test]
    fn deserialize_create_block_from_raw_json() {
        let raw = r#"{
            "op_type": "create_block",
            "block_id": "01HZ00000000000000000000AB",
            "block_type": "content",
            "parent_id": null,
            "position": 0,
            "content": "Hello from DB"
        }"#;

        let payload: OpPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.op_type_str(), "create_block");
        assert_eq!(payload.block_id(), Some("01HZ00000000000000000000AB"));

        let OpPayload::CreateBlock(inner) = &payload else {
            panic!("expected CreateBlock");
        };
        assert_eq!(inner.content, "Hello from DB");
        assert!(inner.parent_id.is_none());
        assert_eq!(inner.position, Some(0));
    }

    #[test]
    fn deserialize_set_property_from_raw_json() {
        let raw = r#"{
            "op_type": "set_property",
            "block_id": "B42",
            "key": "status",
            "value_text": "done",
            "value_num": null,
            "value_date": null,
            "value_ref": null
        }"#;

        let payload: OpPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.op_type_str(), "set_property");
        let OpPayload::SetProperty(inner) = &payload else {
            panic!("expected SetProperty");
        };
        assert_eq!(inner.value_text.as_deref(), Some("done"));
        assert!(inner.value_num.is_none());
    }

    #[test]
    fn deserialize_delete_attachment_from_raw_json() {
        let raw = r#"{"op_type": "delete_attachment", "attachment_id": "A99"}"#;
        let payload: OpPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.op_type_str(), "delete_attachment");
        assert_eq!(payload.block_id(), None);
    }

    // -----------------------------------------------------------------------
    // 7. Error handling — malformed / unknown
    // -----------------------------------------------------------------------

    #[test]
    fn deserialize_malformed_json_returns_error() {
        assert!(
            serde_json::from_str::<OpPayload>("not json").is_err(),
            "invalid JSON should fail"
        );
        assert!(
            serde_json::from_str::<OpPayload>(r#"{"op_type": "create_block"}"#).is_err(),
            "missing required fields should fail"
        );
        assert!(
            serde_json::from_str::<OpPayload>("{}").is_err(),
            "empty object without op_type tag should fail"
        );
        assert!(
            serde_json::from_str::<OpPayload>("[]").is_err(),
            "array instead of object should fail"
        );
    }

    #[test]
    fn unknown_op_type_returns_error() {
        let raw = r#"{"op_type": "frobnicate", "block_id": "B1"}"#;
        let result = serde_json::from_str::<OpPayload>(raw);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        // serde should mention the unknown variant name
        assert!(
            err_msg.contains("frobnicate") || err_msg.contains("unknown variant"),
            "error should reference the bad variant: {err_msg}"
        );
    }

    // -----------------------------------------------------------------------
    // 8. Edge cases — Unicode, empty, long content
    // -----------------------------------------------------------------------

    #[test]
    fn unicode_content_roundtrips_through_serde() {
        let text = "日本語テスト 🚀 spëcial — «guillemets» \u{200B}";
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            index: None,
            content: text.into(),
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::CreateBlock(inner) = deser else {
            panic!("expected CreateBlock");
        };
        assert_eq!(
            inner.content, text,
            "unicode content must survive round-trip"
        );
    }

    #[test]
    fn empty_content_roundtrips_through_serde() {
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            to_text: String::new(),
            prev_edit: None,
            prior_text: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::EditBlock(inner) = &deser else {
            panic!("expected EditBlock");
        };
        assert_eq!(inner.to_text, "", "empty string must survive round-trip");
    }

    #[test]
    fn large_content_100kb_roundtrips_through_serde() {
        let long_text = "x".repeat(100_000);
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            to_text: long_text.clone(),
            prev_edit: None,
            prior_text: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::EditBlock(inner) = deser else {
            panic!("expected EditBlock");
        };
        assert_eq!(
            inner.to_text.len(),
            100_000,
            "100 KB content must survive round-trip"
        );
    }

    // -----------------------------------------------------------------------
    // 9. Optional field handling
    // -----------------------------------------------------------------------

    #[test]
    fn all_optional_set_property_fields_serialize_as_null() {
        let payload = SetPropertyPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            key: "k".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"value_text\":null"));
        assert!(json.contains("\"value_num\":null"));
        assert!(json.contains("\"value_date\":null"));
        assert!(json.contains("\"value_ref\":null"));

        // Roundtrip through deserialization
        let deser: SetPropertyPayload = serde_json::from_str(&json).unwrap();
        assert!(deser.value_text.is_none());
        assert!(deser.value_num.is_none());
        assert!(deser.value_date.is_none());
        assert!(deser.value_ref.is_none());
    }

    #[test]
    fn set_property_with_numeric_value_roundtrips() {
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            key: "score".into(),
            value_text: None,
            value_num: Some(42.5),
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::SetProperty(inner) = deser else {
            panic!("expected SetProperty");
        };
        assert!(inner.value_text.is_none(), "value_text should be None");
        assert_eq!(inner.value_num, Some(42.5), "value_num mismatch");
        assert!(inner.value_date.is_none(), "value_date should be None");
        assert!(inner.value_ref.is_none(), "value_ref should be None");
    }

    // -----------------------------------------------------------------------
    // 10. Additional edge cases
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 11. insta snapshot tests — OpPayload JSON serialization
    // -----------------------------------------------------------------------

    /// Snapshot the JSON serialization of every OpPayload variant.
    /// These are fully deterministic (no timestamps, no ULIDs).
    #[test]
    fn snapshot_all_payload_json_serialization() {
        for payload in all_test_payloads() {
            let tag = payload.op_type_str();
            let json: serde_json::Value = serde_json::to_value(&payload).unwrap();
            insta::assert_yaml_snapshot!(format!("op_payload_json_{tag}"), json);
        }
    }

    #[test]
    fn move_block_to_root_serializes_null_parent() {
        let payload = OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            new_parent_id: None,
            new_position: 0,
            new_index: None,
            prior: None,
        });
        let json = serde_json::to_string(&payload).unwrap();
        assert!(
            json.contains("\"new_parent_id\":null"),
            "move to root should have null parent"
        );
        let deser: OpPayload = serde_json::from_str(&json).unwrap();
        let OpPayload::MoveBlock(inner) = deser else {
            panic!("expected MoveBlock");
        };
        assert!(
            inner.new_parent_id.is_none(),
            "deserialized parent should be None for root move"
        );
    }

    // -----------------------------------------------------------------------
    // 12. F02: normalize_block_ids — now a no-op since BlockId auto-normalizes
    // -----------------------------------------------------------------------

    #[test]
    fn normalize_block_ids_is_no_op_since_block_id_auto_normalizes() {
        let lower = "01arz3ndektsv4rrffq69g5fav";
        let upper = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        // BlockId::from_string auto-normalizes to uppercase
        let mut payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(lower).unwrap(),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_string(lower).unwrap()),
            position: Some(1),
            index: None,
            content: "test".into(),
        });
        // Already uppercase from construction
        assert_eq!(payload.block_id(), Some(upper));
        // normalize_block_ids is a no-op but should not panic
        payload.normalize_block_ids();
        assert_eq!(payload.block_id(), Some(upper));
        let OpPayload::CreateBlock(inner) = &payload else {
            panic!("expected CreateBlock");
        };
        assert_eq!(inner.parent_id.as_ref().unwrap().as_str(), upper);
    }

    #[test]
    fn normalize_block_ids_is_no_op_for_all_payload_variants() {
        let payloads = all_test_payloads();
        assert_eq!(
            payloads.len(),
            all_op_types().len(),
            "must cover every variant"
        );

        for mut payload in payloads {
            let tag = payload.op_type_str();
            let json_before = serde_json::to_string(&payload)
                .unwrap_or_else(|e| panic!("serialize before normalize {tag}: {e}"));
            payload.normalize_block_ids();
            let json_after = serde_json::to_string(&payload)
                .unwrap_or_else(|e| panic!("serialize after normalize {tag}: {e}"));
            assert_eq!(
                json_before, json_after,
                "normalize_block_ids must be a no-op for {tag}"
            );
        }
    }

    #[test]
    fn block_id_auto_normalizes_on_construction() {
        let lower = "01arz3ndektsv4rrffq69g5fav";
        let upper = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

        // AddTag — both block_id and tag_id normalize on construction
        let tag_payload = OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_string(lower).unwrap(),
            tag_id: BlockId::from_string(lower).unwrap(),
        });
        let OpPayload::AddTag(inner) = &tag_payload else {
            panic!("expected AddTag");
        };
        assert_eq!(inner.block_id.as_str(), upper);
        assert_eq!(inner.tag_id.as_str(), upper);
    }

    // -----------------------------------------------------------------------
    // 13. F04: validate_set_property
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_accepts_exactly_one_value() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        assert!(
            validate_set_property(&p).is_ok(),
            "validate_set_property should accept a payload with exactly one value (value_text set)"
        );
    }

    #[test]
    fn validate_set_property_rejects_zero_values() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "expected Validation error, got: {err:?}"
        );
        assert!(err.to_string().contains("found 0"));
    }

    #[test]
    fn validate_set_property_rejects_multiple_values() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: Some("v".into()),
            value_num: Some(1.0),
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "expected Validation error, got: {err:?}"
        );
        assert!(err.to_string().contains("found 2"));
    }

    /// Validation accepts a payload whose only set value is
    /// `value_bool` (both `Some(true)` and `Some(false)`).
    #[test]
    fn validate_set_property_accepts_value_bool_alone() {
        for b in [true, false] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "flag".into(),
                value_text: None,
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: Some(b),
                prior: None,
            };
            assert!(
                validate_set_property(&p).is_ok(),
                "value_bool={b} should pass exactly-one-value validation"
            );
        }
    }

    /// Mixing `value_bool` with another set value field fails the
    /// exactly-one-value check just like any other pair.
    #[test]
    fn validate_set_property_rejects_value_bool_with_other_fields() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "flag".into(),
            value_text: Some("yes".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: Some(true),
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "expected Validation error, got: {err:?}"
        );
        assert!(err.to_string().contains("found 2"));
    }

    /// Snapshot the JSON serde shape of a `value_bool=Some(true)`
    /// payload. Locks the wire format so any accidental rename / reorder is
    /// caught.
    #[test]
    fn set_property_payload_boolean_serde_snapshot() {
        let payload = SetPropertyPayload {
            block_id: BlockId::from_string(TEST_BID).unwrap(),
            key: "flag".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: Some(true),
            prior: None,
        };
        let json: serde_json::Value = serde_json::to_value(&payload).unwrap();
        insta::assert_yaml_snapshot!("set_property_payload_value_bool_true", json);
    }

    // -----------------------------------------------------------------------
    // 13b. Key format validation (#23)
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_accepts_valid_keys() {
        for key in [
            "due",
            "priority",
            "my-key",
            "my_key",
            "key123",
            "a",
            &"k".repeat(64),
        ] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: key.into(),
                value_text: Some("v".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            };
            assert!(
                validate_set_property(&p).is_ok(),
                "key '{key}' should be accepted"
            );
        }
    }

    #[test]
    fn validate_set_property_rejects_empty_key() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: String::new(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "empty key should be rejected"
        );
        assert!(err.to_string().contains("1-64 characters"));
    }

    #[test]
    fn validate_set_property_rejects_too_long_key() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".repeat(65),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "65-char key should be rejected"
        );
        assert!(err.to_string().contains("1-64 characters"));
    }

    #[test]
    fn validate_set_property_rejects_special_char_keys() {
        for key in ["bad key", "key.name", "key/name", "key@here", "k!ey", "a b"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: key.into(),
                value_text: Some("v".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(err, agaric_core::error::AppError::Validation { .. }),
                "key '{key}' should be rejected"
            );
            assert!(
                err.to_string().contains("alphanumeric"),
                "error should mention alphanumeric for key '{key}'"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 14. F09: OpType Display/FromStr exhaustive
    // -----------------------------------------------------------------------

    #[test]
    fn op_type_display_from_str_roundtrip_all_variants() {
        for variant in all_op_types() {
            let displayed = variant.to_string();
            let parsed: OpType = displayed
                .parse()
                .unwrap_or_else(|e| panic!("FromStr failed for '{displayed}': {e}"));
            assert_eq!(
                parsed, variant,
                "Display → FromStr round-trip failed for {variant:?}"
            );
        }
    }

    #[test]
    fn op_type_as_str_display_from_str_all_consistent() {
        for variant in all_op_types() {
            let as_str = variant.as_str();
            let display = format!("{variant}");
            let from_str: OpType = as_str.parse().unwrap();
            assert_eq!(
                as_str, display,
                "as_str vs Display mismatch for {variant:?}"
            );
            assert_eq!(
                from_str, variant,
                "FromStr(as_str) mismatch for {variant:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 15. F24: validate_set_property rejects NaN / Infinity
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_set_property_nan() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: Some(f64::NAN),
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "NaN value_num must return Validation error, got: {err:?}"
        );
        assert!(
            err.to_string().contains("finite"),
            "error message must mention 'finite', got: {err}"
        );
    }

    #[test]
    fn test_validate_set_property_infinity() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: Some(f64::INFINITY),
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err = validate_set_property(&p).unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "Infinity value_num must return Validation error, got: {err:?}"
        );
        assert!(
            err.to_string().contains("finite"),
            "error message must mention 'finite', got: {err}"
        );

        // Also test negative infinity
        let p_neg = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "k".into(),
            value_text: None,
            value_num: Some(f64::NEG_INFINITY),
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        let err_neg = validate_set_property(&p_neg).unwrap_err();
        assert!(
            matches!(err_neg, agaric_core::error::AppError::Validation { .. }),
            "NEG_INFINITY value_num must return Validation error, got: {err_neg:?}"
        );
    }

    #[test]
    fn validate_set_property_allows_clear_for_reserved_key() {
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "todo_state".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
            prior: None,
        };
        assert!(
            validate_set_property(&p).is_ok(),
            "reserved key with all-null values should be allowed (clear)"
        );
    }

    // -----------------------------------------------------------------------
    // Validate_set_property rejects empty / whitespace-only string fields
    // -----------------------------------------------------------------------

    #[test]
    fn validate_set_property_rejects_empty_value_text() {
        for empty in ["", "   ", "\t\n"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "k".into(),
                value_text: Some(empty.into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(
                    err,
                    agaric_core::error::AppError::Validation { message: ref m, .. }
                        if m == "set_property.value_text.empty"
                ),
                "empty value_text ({empty:?}) must return the value_text.empty error, got: {err:?}"
            );
        }
    }

    #[test]
    fn validate_set_property_rejects_empty_value_date() {
        for empty in ["", "   ", "\t\n"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "k".into(),
                value_text: None,
                value_num: None,
                value_date: Some(empty.into()),
                value_ref: None,
                value_bool: None,
                prior: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(
                    err,
                    agaric_core::error::AppError::Validation { message: ref m, .. }
                        if m == "set_property.value_date.empty"
                ),
                "empty value_date ({empty:?}) must return the value_date.empty error, got: {err:?}"
            );
        }
    }

    #[test]
    fn validate_set_property_rejects_empty_value_ref() {
        for empty in ["", "   ", "\t\n"] {
            let p = SetPropertyPayload {
                block_id: BlockId::test_id("B1"),
                key: "k".into(),
                value_text: None,
                value_num: None,
                value_date: None,
                value_ref: Some(empty.into()),
                value_bool: None,
                prior: None,
            };
            let err = validate_set_property(&p).unwrap_err();
            assert!(
                matches!(
                    err,
                    agaric_core::error::AppError::Validation { message: ref m, .. }
                        if m == "set_property.value_ref.empty"
                ),
                "empty value_ref ({empty:?}) must return the value_ref.empty error, got: {err:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // #465: SetPropertyPayload.value_ref is Option<BlockId> — auto-uppercase
    // -----------------------------------------------------------------------

    /// Regression test for issue #465: `value_ref` is now `Option<BlockId>`,
    /// so constructing a `SetPropertyPayload` with a lowercase ULID string
    /// must produce the canonical uppercase form.  This ensures blake3 hash
    /// determinism across devices (AGENTS.md invariant #8).
    #[test]
    fn set_property_value_ref_blockid_normalizes_lowercase() {
        let lower = "abc123def456ghi789jkl01a";
        let p = SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "linked".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::from(lower)),
            value_bool: None,
            prior: None,
        };
        assert_eq!(
            p.value_ref.as_ref().map(agaric_core::ulid::BlockId::as_str),
            Some("ABC123DEF456GHI789JKL01A"),
            "value_ref BlockId must auto-uppercase the input ULID"
        );
    }

    // -----------------------------------------------------------------------
    // is_reserved_property_key
    // -----------------------------------------------------------------------

    #[test]
    fn is_reserved_property_key_recognizes_all_four() {
        assert!(
            is_reserved_property_key("todo_state"),
            "todo_state must be recognized as reserved"
        );
        assert!(
            is_reserved_property_key("priority"),
            "priority must be recognized as reserved"
        );
        assert!(
            is_reserved_property_key("due_date"),
            "due_date must be recognized as reserved"
        );
        assert!(
            is_reserved_property_key("scheduled_date"),
            "scheduled_date must be recognized as reserved"
        );
    }

    #[test]
    fn is_reserved_property_key_rejects_non_reserved() {
        assert!(
            !is_reserved_property_key("custom_key"),
            "custom_key must not be recognized as reserved"
        );
        assert!(
            !is_reserved_property_key("todo"),
            "todo must not be recognized as reserved"
        );
        assert!(
            !is_reserved_property_key(""),
            "empty string must not be recognized as reserved"
        );
    }

    // -----------------------------------------------------------------------
    // is_column_backed_property_key / COLUMN_BACKED_PROPERTY_KEYS (#589)
    // -----------------------------------------------------------------------

    #[test]
    fn column_backed_set_is_reserved_plus_space_589() {
        // COLUMN_BACKED_PROPERTY_KEYS must be exactly the four reserved
        // keys plus `space` — both built from the same constants, so this
        // pins the composition (no duplicates, no omissions).
        assert_eq!(COLUMN_BACKED_PROPERTY_KEYS.len(), 5);
        for key in RESERVED_PROPERTY_KEYS {
            assert!(
                COLUMN_BACKED_PROPERTY_KEYS.contains(&key),
                "reserved key '{key}' must be in COLUMN_BACKED_PROPERTY_KEYS"
            );
        }
        assert!(
            COLUMN_BACKED_PROPERTY_KEYS.contains(&SPACE_PROPERTY_KEY),
            "'space' must be in COLUMN_BACKED_PROPERTY_KEYS"
        );
    }

    #[test]
    fn is_column_backed_property_key_recognizes_all_five_589() {
        for key in COLUMN_BACKED_PROPERTY_KEYS {
            assert!(
                is_column_backed_property_key(key),
                "'{key}' must be recognized as column-backed"
            );
        }
        // `space` is column-backed but NOT reserved (different column name,
        // page-group fan-out) — the two predicates must disagree on it.
        assert!(is_column_backed_property_key("space"));
        assert!(!is_reserved_property_key("space"));
    }

    #[test]
    fn is_column_backed_property_key_rejects_non_members_589() {
        for key in ["effort", "assignee", "space_id", "created_at", ""] {
            assert!(
                !is_column_backed_property_key(key),
                "'{key}' must not be recognized as column-backed"
            );
        }
    }

    // -----------------------------------------------------------------------
    // is_builtin_property_key
    // -----------------------------------------------------------------------

    #[test]
    fn is_builtin_property_key_recognizes_all() {
        let builtin_keys = [
            "todo_state",
            "priority",
            "due_date",
            "scheduled_date",
            "created_at",
            "completed_at",
            "repeat",
            "repeat-until",
            "repeat-count",
            "repeat-seq",
            "repeat-origin",
            "space",
            "is_space",
            "listStyle",
        ];
        for key in builtin_keys {
            assert!(
                is_builtin_property_key(key),
                "'{key}' must be recognized as built-in"
            );
        }
    }

    #[test]
    fn is_builtin_property_key_rejects_custom() {
        assert!(
            !is_builtin_property_key("custom_key"),
            "custom_key must not be recognized as built-in"
        );
        assert!(
            !is_builtin_property_key(""),
            "empty string must not be recognized as built-in"
        );
    }

    /// #5841: the rename and merge refusals check built-ins only; a
    /// column-backed key is one of them.
    #[test]
    fn every_column_backed_key_is_builtin() {
        for key in COLUMN_BACKED_PROPERTY_KEYS {
            assert!(is_builtin_property_key(key), "'{key}' is column-backed");
        }
    }

    #[test]
    fn internal_keys_are_internal_and_user_keys_are_not() {
        for key in ["template", "journal-template", "accent_color", "repeat"] {
            assert!(is_internal_property_key(key), "'{key}' is the app's own");
        }
        for key in ["project", "status", "due_date"] {
            assert!(!is_internal_property_key(key), "'{key}' is not internal");
        }
    }

    #[test]
    fn user_settable_properties_are_not_builtin() {
        for key in ["status", "url", "effort", "assignee", "location"] {
            assert!(
                !is_builtin_property_key(key),
                "'{key}' is user-settable and must NOT be treated as built-in"
            );
        }
    }

    /// #6106: a built-in's definition and the value check read a select's
    /// options as the JSON array `property_definitions.options` stores; a
    /// built-in of another type has none.
    #[test]
    fn builtin_options_json_is_a_selects_options_as_a_json_array() {
        let options = |key| builtin_property_def(key).and_then(BuiltinPropertyDef::options_json);
        assert_eq!(options("priority").as_deref(), Some(r#"["1","2","3"]"#));
        assert_eq!(options("due_date"), None);
    }
}

// ===========================================================================
// Property-based tests (proptest)
// ===========================================================================

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;
    use std::str::FromStr;

    // ── ULID normalization is idempotent ────────────────────────────────

    proptest! {
        /// Normalizing a BlockId via `from_trusted` is idempotent: applying
        /// the normalization twice yields the same result as applying it once.
        #[test]
        fn normalize_block_id_idempotent(s in "[0-9A-Za-z]{26}") {
            let normalized = BlockId::from_trusted(&s).as_str().to_string();
            let double_normalized = BlockId::from_trusted(&normalized).as_str().to_string();
            prop_assert_eq!(&normalized, &double_normalized);
        }
    }

    // ── OpType as_str / FromStr round-trip ──────────────────────────────

    /// Strategy that produces one of the known OpType variants.
    fn arb_op_type() -> impl Strategy<Value = OpType> {
        prop_oneof![
            Just(OpType::CreateBlock),
            Just(OpType::EditBlock),
            Just(OpType::DeleteBlock),
            Just(OpType::RestoreBlock),
            Just(OpType::PurgeBlock),
            Just(OpType::MoveBlock),
            Just(OpType::AddTag),
            Just(OpType::RemoveTag),
            Just(OpType::SetProperty),
            Just(OpType::DeleteProperty),
            Just(OpType::AddAttachment),
            Just(OpType::DeleteAttachment),
            Just(OpType::RenameAttachment),
            Just(OpType::AddPageAlias),
            Just(OpType::RemovePageAlias),
            Just(OpType::SetPropertyDef),
            Just(OpType::RenamePropertyKey),
            Just(OpType::RewriteProperties),
            Just(OpType::RenamePropertyOption),
        ]
    }

    proptest! {
        /// Every OpType variant survives a round-trip through `as_str` → `FromStr`.
        #[test]
        fn op_type_as_str_from_str_roundtrip(variant in arb_op_type()) {
            let s = variant.as_str();
            let parsed = OpType::from_str(s).unwrap();
            prop_assert_eq!(variant, parsed);
        }

        /// Every OpType variant maps to a unique string — no two variants
        /// share the same `as_str` value.
        #[test]
        fn op_type_as_str_unique(a in arb_op_type(), b in arb_op_type()) {
            prop_assume!(a != b);
            prop_assert_ne!(a.as_str(), b.as_str());
        }
    }
}
