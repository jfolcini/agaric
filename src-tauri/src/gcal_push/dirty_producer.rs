//! FEAT-5h — build [`DirtyEvent`]s from op records applied by the
//! materializer's remote-op path.
//!
//! The connector spawned by [`super::connector::spawn_connector`] owns
//! an mpsc receiver that waits for [`DirtyEvent`]s.  The producer side
//! is wired into the materializer's `apply_op` boundary so every
//! remote op that could shift the agenda on any date in the push
//! window notifies the connector immediately rather than waiting for
//! the 15-minute reconcile sweep.
//!
//! # What counts as "could shift the agenda"
//!
//! The connector cares about dates in
//! `[today, today + gcal_settings.window_days]` on which the
//! [`list_projected_agenda_inner`](crate::commands::list_projected_agenda_inner)
//! output might have changed.  Per the FEAT-5h scope, that is:
//!
//! * `SetProperty` / `DeleteProperty` on the reserved keys
//!   `due_date`, `scheduled_date`, `todo_state`, `priority`.
//! * `SetProperty` / `DeleteProperty` on the non-reserved repeat
//!   keys `repeat`, `repeat-until`, `repeat-count`, `repeat_interval`,
//!   `repeat_unit`.
//! * `EditBlock` — block text is part of the digest line.  When the
//!   block is on the agenda for a given date, re-hash the digest for
//!   that date.
//! * `DeleteBlock` — the block falls out of the projected agenda on
//!   every date it was visible.
//! * `RestoreBlock` — the block re-enters the projected agenda on
//!   every date it maps to.
//!
//! All other op types (create_block, purge_block, move_block, tag ops,
//! attachment ops) are skipped — none of them shift the dates or the
//! visible content of an existing agenda row.
//!
//! # Window pre-filter
//!
//! Producers don't know the user's configured `window_days` — it is a
//! cheap `SELECT value FROM gcal_settings WHERE key = 'window_days'`
//! but that's a database round-trip per op.  Instead we clamp to
//! [`super::connector::MAX_WINDOW_DAYS`] (90) — the maximum allowed
//! setting.  The connector re-clamps to the actual value before
//! pushing, so wasted dates here cost one extra entry in an
//! in-memory `BTreeSet` (and zero network requests).  A date outside
//! `[today, today + 90]` can never be reached on any setting, so
//! pre-filtering there saves wakeups for far-future or past dates.

use std::collections::BTreeSet;
use std::str::FromStr;

use chrono::{Duration, NaiveDate};
use sqlx::SqliteConnection;

use crate::error::AppError;
use crate::op::{
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, OpType, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::op_log::OpRecord;

use super::connector::{DirtyEvent, MAX_WINDOW_DAYS};

// ---------------------------------------------------------------------------
// Keys that affect the agenda projection / digest line
// ---------------------------------------------------------------------------

/// Reserved + non-reserved property keys that the GCal digest depends
/// on.  A `SetProperty` / `DeleteProperty` op on any of these keys
/// *may* change the agenda for the block's dates and we emit a
/// [`DirtyEvent`].  Any other key is agenda-irrelevant.
///
/// This deliberately undercounts — keys the agenda cache treats as
/// visible (e.g. custom labels surfaced in the digest) would need
/// their own entries here — but the 15-minute reconcile sweep always
/// picks up missed changes so the list is conservative.
fn is_agenda_relevant_key(key: &str) -> bool {
    matches!(
        key,
        "due_date"
            | "scheduled_date"
            | "todo_state"
            | "priority"
            | "repeat"
            | "repeat-until"
            | "repeat-count"
            | "repeat_interval"
            | "repeat_unit"
    )
}

fn is_date_key(key: &str) -> bool {
    matches!(key, "due_date" | "scheduled_date")
}

// ---------------------------------------------------------------------------
// Pre-op snapshot
// ---------------------------------------------------------------------------

/// Snapshot of a block's agenda-relevant state taken BEFORE an op is
/// applied.  The materializer loads one of these immediately prior to
/// `apply_op_tx` so the producer can compute `old_affected_dates`
/// without re-querying the post-mutation row (the mutation may have
/// cleared the previous value).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockDateSnapshot {
    pub due_date: Option<NaiveDate>,
    pub scheduled_date: Option<NaiveDate>,
    /// `true` when `blocks.deleted_at IS NOT NULL` at snapshot time.
    /// Used by the `RestoreBlock` arm to skip emission when the block
    /// wasn't actually deleted (defensive — the op is idempotent).
    pub was_deleted: bool,
    /// `true` when the row does not exist (no matching `id`).  A
    /// snapshot with `missing = true` short-circuits
    /// [`compute_dirty_event`] — the op applies to a not-yet-created
    /// block, which has no agenda dates.
    pub missing: bool,
}

/// Read the block's agenda-relevant state for the op targeting it.
///
/// Returns an empty snapshot (`missing = true`) when the op has no
/// `block_id` field (attachment ops) or when the targeted row does
/// not exist yet (create_block dispatched before the row is visible).
///
/// Errors propagate SQL failures only — a missing row is not an
/// error.
pub async fn snapshot_for_op(
    conn: &mut SqliteConnection,
    record: &OpRecord,
) -> Result<BlockDateSnapshot, AppError> {
    let Some(block_id) = block_id_of(record)? else {
        return Ok(BlockDateSnapshot {
            missing: true,
            ..Default::default()
        });
    };
    snapshot_block(conn, &block_id).await
}

/// Read the block's agenda-relevant state by `block_id`.
///
/// Primitive used by both [`snapshot_for_op`] (materializer remote
/// path) and local command handlers (FEAT-5i).  Local command
/// handlers call this BEFORE entering `*_in_tx` — they already know
/// the `block_id` from their arguments and have no `OpRecord` yet.
///
/// Returns `missing = true` when the row does not exist.  `was_deleted`
/// is `true` iff `deleted_at IS NOT NULL` at snapshot time.
pub async fn snapshot_block(
    conn: &mut SqliteConnection,
    block_id: &str,
) -> Result<BlockDateSnapshot, AppError> {
    let row = sqlx::query!(
        r#"SELECT due_date, scheduled_date,
                  CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END as "deleted: bool"
             FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(BlockDateSnapshot {
            missing: true,
            ..Default::default()
        });
    };

    Ok(BlockDateSnapshot {
        due_date: row.due_date.as_deref().and_then(parse_iso_date),
        scheduled_date: row.scheduled_date.as_deref().and_then(parse_iso_date),
        was_deleted: row.deleted.unwrap_or(false),
        missing: false,
    })
}

/// Extract the `block_id` string from a record payload, if present.
///
/// Returns `Ok(None)` for ops whose payload has no block_id field
/// (attachment ops) or fails to parse (defensive — malformed payloads
/// are logged elsewhere).
fn block_id_of(record: &OpRecord) -> Result<Option<String>, AppError> {
    let op_type = OpType::from_str(&record.op_type).ok();
    match op_type {
        Some(
            OpType::CreateBlock
            | OpType::EditBlock
            | OpType::DeleteBlock
            | OpType::RestoreBlock
            | OpType::PurgeBlock
            | OpType::MoveBlock
            | OpType::AddTag
            | OpType::RemoveTag
            | OpType::SetProperty
            | OpType::DeleteProperty,
        ) => {
            // Every block-targeting payload has `block_id` at the top
            // level; pull it out with a typed `serde_json::Value`
            // probe rather than deserializing the full payload (saves
            // allocation + lets us be lenient about unknown fields).
            let value: serde_json::Value = serde_json::from_str(&record.payload)?;
            Ok(value
                .get("block_id")
                .and_then(serde_json::Value::as_str)
                .map(std::borrow::ToOwned::to_owned))
        }
        Some(OpType::AddAttachment | OpType::DeleteAttachment) | None => Ok(None),
    }
}

fn parse_iso_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

// ---------------------------------------------------------------------------
// DirtyEvent construction
// ---------------------------------------------------------------------------

/// Build a [`DirtyEvent`] for `record` given the pre-op block state.
///
/// Returns `None` when the op cannot shift the projected agenda on
/// any in-window date — either because the op type is irrelevant
/// (create_block, attachment ops, non-agenda property keys) or
/// because both old and new date sets are empty after clamping.
///
/// `today` is passed in so tests can pin a deterministic boundary.
/// Production callers pass `chrono::Local::now().date_naive()`.
pub fn compute_dirty_event(
    record: &OpRecord,
    prior: &BlockDateSnapshot,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    let op_type = OpType::from_str(&record.op_type).ok()?;

    match op_type {
        OpType::SetProperty => compute_for_set_property(record, prior, today),
        OpType::DeleteProperty => compute_for_delete_property(record, prior, today),
        OpType::EditBlock => compute_for_edit_block(record, prior, today),
        OpType::DeleteBlock => compute_for_delete_block(record, prior, today),
        OpType::RestoreBlock => compute_for_restore_block(record, prior, today),
        // CreateBlock: fresh block has no agenda dates yet (a
        // subsequent SetProperty op sets them).  PurgeBlock removes
        // the row completely but PurgeBlock arrives only after a
        // DeleteBlock chain that already emitted dirty events.
        // MoveBlock doesn't change dates.  Tag ops don't change the
        // digest.  Attachment ops are irrelevant.
        OpType::CreateBlock
        | OpType::PurgeBlock
        | OpType::MoveBlock
        | OpType::AddTag
        | OpType::RemoveTag
        | OpType::AddAttachment
        | OpType::DeleteAttachment => None,
    }
}

fn compute_for_set_property(
    record: &OpRecord,
    prior: &BlockDateSnapshot,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    if prior.missing {
        return None;
    }
    let payload: SetPropertyPayload = serde_json::from_str(&record.payload).ok()?;
    if !is_agenda_relevant_key(&payload.key) {
        return None;
    }

    let mut old = BTreeSet::new();
    let mut new = BTreeSet::new();

    if is_date_key(&payload.key) {
        // Swap the specific date the key changed.
        let old_date = if payload.key == "due_date" {
            prior.due_date
        } else {
            prior.scheduled_date
        };
        if let Some(d) = old_date {
            old.insert(d);
        }
        if let Some(d) = payload.value_date.as_deref().and_then(parse_iso_date) {
            new.insert(d);
        }
    } else {
        // Non-date keys (todo_state, priority, repeat_*) don't change
        // the dates, but they do change the *visible* digest line on
        // every date the block already maps to.  Emit both halves so
        // the connector re-pushes those dates.
        extend_all_dates(&mut old, prior);
        extend_all_dates(&mut new, prior);
    }

    build_event_clamped(old, new, today)
}

fn compute_for_delete_property(
    record: &OpRecord,
    prior: &BlockDateSnapshot,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    if prior.missing {
        return None;
    }
    let payload: DeletePropertyPayload = serde_json::from_str(&record.payload).ok()?;
    if !is_agenda_relevant_key(&payload.key) {
        return None;
    }

    let mut old = BTreeSet::new();
    let mut new = BTreeSet::new();

    if is_date_key(&payload.key) {
        let old_date = if payload.key == "due_date" {
            prior.due_date
        } else {
            prior.scheduled_date
        };
        if let Some(d) = old_date {
            old.insert(d);
        }
        // new stays empty — the key is cleared.
    } else {
        extend_all_dates(&mut old, prior);
        extend_all_dates(&mut new, prior);
    }

    build_event_clamped(old, new, today)
}

fn compute_for_edit_block(
    record: &OpRecord,
    prior: &BlockDateSnapshot,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    if prior.missing {
        return None;
    }
    // Validate payload structure (unused fields — presence is enough).
    let _payload: EditBlockPayload = serde_json::from_str(&record.payload).ok()?;

    // Emit old = new = {prior dates}.  The visible digest line
    // changes with the block content, so the connector re-pushes the
    // existing dates.
    let mut old = BTreeSet::new();
    let mut new = BTreeSet::new();
    extend_all_dates(&mut old, prior);
    extend_all_dates(&mut new, prior);

    build_event_clamped(old, new, today)
}

fn compute_for_delete_block(
    record: &OpRecord,
    prior: &BlockDateSnapshot,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    if prior.missing {
        return None;
    }
    let _payload: DeleteBlockPayload = serde_json::from_str(&record.payload).ok()?;

    let mut old = BTreeSet::new();
    extend_all_dates(&mut old, prior);

    build_event_clamped(old, BTreeSet::new(), today)
}

fn compute_for_restore_block(
    record: &OpRecord,
    prior: &BlockDateSnapshot,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    if prior.missing {
        return None;
    }
    let _payload: RestoreBlockPayload = serde_json::from_str(&record.payload).ok()?;

    // Only emit if the block was actually deleted before the op — an
    // idempotent re-restore adds nothing.
    if !prior.was_deleted {
        return None;
    }

    let mut new = BTreeSet::new();
    extend_all_dates(&mut new, prior);

    build_event_clamped(BTreeSet::new(), new, today)
}

fn extend_all_dates(sink: &mut BTreeSet<NaiveDate>, snapshot: &BlockDateSnapshot) {
    if let Some(d) = snapshot.due_date {
        sink.insert(d);
    }
    if let Some(d) = snapshot.scheduled_date {
        sink.insert(d);
    }
}

/// Clamp both halves of the event to `[today, today + MAX_WINDOW_DAYS]`
/// and return `None` when nothing survives the filter.
///
/// `MAX_WINDOW_DAYS` is the largest user-configurable value for
/// `gcal_settings.window_days`; the connector re-clamps to the
/// actual setting before touching the network, so emitting dates
/// outside this range is pure waste.
fn build_event_clamped(
    old: BTreeSet<NaiveDate>,
    new: BTreeSet<NaiveDate>,
    today: NaiveDate,
) -> Option<DirtyEvent> {
    let old = clamp_to_window(old, today);
    let new = clamp_to_window(new, today);
    if old.is_empty() && new.is_empty() {
        return None;
    }
    Some(DirtyEvent {
        old_affected_dates: old,
        new_affected_dates: new,
    })
}

fn clamp_to_window(dates: BTreeSet<NaiveDate>, today: NaiveDate) -> Vec<NaiveDate> {
    let end = today + Duration::days(MAX_WINDOW_DAYS);
    dates
        .into_iter()
        .filter(|d| *d >= today && *d <= end)
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::op::OpPayload;
    use crate::ulid::BlockId;

    const TODAY_STR: &str = "2026-04-22";
    const DEVICE: &str = "dev-test";

    fn today() -> NaiveDate {
        NaiveDate::parse_from_str(TODAY_STR, "%Y-%m-%d").unwrap()
    }

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn make_record(payload: &OpPayload) -> OpRecord {
        let json = serde_json::to_string(payload).unwrap();
        OpRecord {
            device_id: DEVICE.to_owned(),
            seq: 1,
            parent_seqs: None,
            hash: "test-hash".to_owned(),
            op_type: payload.op_type_str().to_owned(),
            payload: json,
            created_at: "2026-04-22T12:00:00Z".to_owned(),
        }
    }

    fn bid() -> BlockId {
        BlockId::from_trusted("BLK-TEST-01")
    }

    fn set_property(key: &str, value_date: Option<&str>, value_text: Option<&str>) -> OpRecord {
        make_record(&OpPayload::SetProperty(SetPropertyPayload {
            block_id: bid(),
            key: key.to_owned(),
            value_text: value_text.map(str::to_owned),
            value_num: None,
            value_date: value_date.map(str::to_owned),
            value_ref: None,
        }))
    }

    fn delete_property(key: &str) -> OpRecord {
        make_record(&OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: bid(),
            key: key.to_owned(),
        }))
    }

    fn delete_block() -> OpRecord {
        make_record(&OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: bid(),
        }))
    }

    fn restore_block() -> OpRecord {
        make_record(&OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: bid(),
            deleted_at_ref: "2026-04-22T00:00:00Z".to_owned(),
        }))
    }

    fn edit_block() -> OpRecord {
        make_record(&OpPayload::EditBlock(EditBlockPayload {
            block_id: bid(),
            to_text: "new content".to_owned(),
            prev_edit: None,
        }))
    }

    // ── is_agenda_relevant_key ────────────────────────────────────────

    #[test]
    fn relevant_keys_return_true() {
        for k in [
            "due_date",
            "scheduled_date",
            "todo_state",
            "priority",
            "repeat",
            "repeat-until",
            "repeat-count",
            "repeat_interval",
            "repeat_unit",
        ] {
            assert!(is_agenda_relevant_key(k), "{k} should be relevant");
        }
    }

    #[test]
    fn irrelevant_keys_return_false() {
        for k in ["assignee", "effort", "completed_at", "created_at", "notes"] {
            assert!(!is_agenda_relevant_key(k), "{k} should not be relevant");
        }
    }

    // ── clamp_to_window ───────────────────────────────────────────────

    #[test]
    fn clamp_keeps_today_and_end_bound_inclusive() {
        let today = today();
        let end = today + Duration::days(MAX_WINDOW_DAYS);
        let mut set = BTreeSet::new();
        set.insert(today);
        set.insert(end);
        let kept = clamp_to_window(set, today);
        assert_eq!(kept.len(), 2);
        assert!(kept.contains(&today));
        assert!(kept.contains(&end));
    }

    #[test]
    fn clamp_drops_past_dates() {
        let today = today();
        let mut set = BTreeSet::new();
        set.insert(today - Duration::days(1));
        set.insert(today - Duration::days(100));
        let kept = clamp_to_window(set, today);
        assert_eq!(kept.len(), 0);
    }

    #[test]
    fn clamp_drops_far_future_dates() {
        let today = today();
        let mut set = BTreeSet::new();
        set.insert(today + Duration::days(MAX_WINDOW_DAYS + 1));
        set.insert(today + Duration::days(365));
        let kept = clamp_to_window(set, today);
        assert_eq!(kept.len(), 0);
    }

    // ── SetProperty(due_date) ─────────────────────────────────────────

    #[test]
    fn set_property_due_date_old_to_new_emits_both_halves() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            scheduled_date: None,
            was_deleted: false,
            missing: false,
        };
        let rec = set_property("due_date", Some("2026-04-26"), None);
        let ev = compute_dirty_event(&rec, &prior, today()).expect("expected DirtyEvent");
        assert_eq!(ev.old_affected_dates, vec![date("2026-04-25")]);
        assert_eq!(ev.new_affected_dates, vec![date("2026-04-26")]);
    }

    #[test]
    fn set_property_due_date_from_none_to_some() {
        let prior = BlockDateSnapshot::default();
        let rec = set_property("due_date", Some("2026-04-26"), None);
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert!(ev.old_affected_dates.is_empty());
        assert_eq!(ev.new_affected_dates, vec![date("2026-04-26")]);
    }

    #[test]
    fn set_property_due_date_clear_via_set_with_none_value() {
        // Reserved-key "clear" also goes through SetProperty with all
        // value_* fields NULL — see commands/blocks/crud.rs.
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        let rec = set_property("due_date", None, None);
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(ev.old_affected_dates, vec![date("2026-04-25")]);
        assert!(ev.new_affected_dates.is_empty());
    }

    #[test]
    fn set_property_scheduled_date_only_touches_scheduled_half() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            scheduled_date: Some(date("2026-04-26")),
            ..BlockDateSnapshot::default()
        };
        let rec = set_property("scheduled_date", Some("2026-04-27"), None);
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(ev.old_affected_dates, vec![date("2026-04-26")]);
        assert_eq!(ev.new_affected_dates, vec![date("2026-04-27")]);
    }

    #[test]
    fn set_property_past_dates_are_filtered_out() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2024-01-01")),
            ..BlockDateSnapshot::default()
        };
        let rec = set_property("due_date", Some("2024-01-02"), None);
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── SetProperty(todo_state / priority / repeat_*) ─────────────────

    #[test]
    fn set_property_todo_state_emits_all_dates_on_both_halves() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            scheduled_date: Some(date("2026-04-26")),
            ..BlockDateSnapshot::default()
        };
        let rec = set_property("todo_state", None, Some("DONE"));
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(
            ev.old_affected_dates,
            vec![date("2026-04-25"), date("2026-04-26")]
        );
        assert_eq!(
            ev.new_affected_dates,
            vec![date("2026-04-25"), date("2026-04-26")]
        );
    }

    #[test]
    fn set_property_priority_without_dates_is_noop() {
        let prior = BlockDateSnapshot::default();
        let rec = set_property("priority", None, Some("A"));
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    #[test]
    fn set_property_repeat_keys_emit_all_dates() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        for key in [
            "repeat",
            "repeat-until",
            "repeat-count",
            "repeat_interval",
            "repeat_unit",
        ] {
            let rec = set_property(key, None, Some("++1w"));
            let ev = compute_dirty_event(&rec, &prior, today()).unwrap_or_else(|| {
                panic!("{key} should produce a DirtyEvent");
            });
            assert_eq!(ev.old_affected_dates, vec![date("2026-04-25")]);
            assert_eq!(ev.new_affected_dates, vec![date("2026-04-25")]);
        }
    }

    #[test]
    fn set_property_non_agenda_key_is_none() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        let rec = set_property("assignee", None, Some("alice"));
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── DeleteProperty ────────────────────────────────────────────────

    #[test]
    fn delete_property_due_date_emits_old_only() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        let rec = delete_property("due_date");
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(ev.old_affected_dates, vec![date("2026-04-25")]);
        assert!(ev.new_affected_dates.is_empty());
    }

    #[test]
    fn delete_property_todo_state_emits_both_halves() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        let rec = delete_property("todo_state");
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(ev.old_affected_dates, vec![date("2026-04-25")]);
        assert_eq!(ev.new_affected_dates, vec![date("2026-04-25")]);
    }

    #[test]
    fn delete_property_non_agenda_key_is_none() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        let rec = delete_property("assignee");
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── EditBlock ─────────────────────────────────────────────────────

    #[test]
    fn edit_block_emits_prior_dates_on_both_halves() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            scheduled_date: Some(date("2026-04-26")),
            ..BlockDateSnapshot::default()
        };
        let rec = edit_block();
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(
            ev.old_affected_dates,
            vec![date("2026-04-25"), date("2026-04-26")]
        );
        assert_eq!(
            ev.new_affected_dates,
            vec![date("2026-04-25"), date("2026-04-26")]
        );
    }

    #[test]
    fn edit_block_without_dates_is_none() {
        let prior = BlockDateSnapshot::default();
        let rec = edit_block();
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── DeleteBlock ───────────────────────────────────────────────────

    #[test]
    fn delete_block_emits_old_only() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            scheduled_date: Some(date("2026-04-26")),
            ..BlockDateSnapshot::default()
        };
        let rec = delete_block();
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert_eq!(
            ev.old_affected_dates,
            vec![date("2026-04-25"), date("2026-04-26")]
        );
        assert!(ev.new_affected_dates.is_empty());
    }

    #[test]
    fn delete_block_with_no_dates_is_none() {
        let prior = BlockDateSnapshot::default();
        let rec = delete_block();
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── RestoreBlock ──────────────────────────────────────────────────

    #[test]
    fn restore_block_of_previously_deleted_emits_new_only() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            was_deleted: true,
            ..BlockDateSnapshot::default()
        };
        let rec = restore_block();
        let ev = compute_dirty_event(&rec, &prior, today()).unwrap();
        assert!(ev.old_affected_dates.is_empty());
        assert_eq!(ev.new_affected_dates, vec![date("2026-04-25")]);
    }

    #[test]
    fn restore_block_of_not_deleted_is_none() {
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            was_deleted: false,
            ..BlockDateSnapshot::default()
        };
        let rec = restore_block();
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── Missing snapshot ──────────────────────────────────────────────

    #[test]
    fn all_ops_noop_when_block_missing() {
        let prior = BlockDateSnapshot {
            missing: true,
            ..BlockDateSnapshot::default()
        };
        assert!(compute_dirty_event(
            &set_property("due_date", Some("2026-04-25"), None),
            &prior,
            today()
        )
        .is_none());
        assert!(compute_dirty_event(&delete_property("due_date"), &prior, today()).is_none());
        assert!(compute_dirty_event(&edit_block(), &prior, today()).is_none());
        assert!(compute_dirty_event(&delete_block(), &prior, today()).is_none());
        assert!(compute_dirty_event(&restore_block(), &prior, today()).is_none());
    }

    // ── Irrelevant op types ───────────────────────────────────────────

    #[test]
    fn create_block_is_none() {
        let rec = make_record(&OpPayload::CreateBlock(crate::op::CreateBlockPayload {
            block_id: bid(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "hello".into(),
        }));
        let prior = BlockDateSnapshot::default();
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    #[test]
    fn add_tag_is_none() {
        let rec = make_record(&OpPayload::AddTag(crate::op::AddTagPayload {
            block_id: bid(),
            tag_id: BlockId::from_trusted("TAG-1"),
        }));
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    #[test]
    fn move_block_is_none() {
        let rec = make_record(&OpPayload::MoveBlock(crate::op::MoveBlockPayload {
            block_id: bid(),
            new_parent_id: None,
            new_position: 0,
        }));
        let prior = BlockDateSnapshot {
            due_date: Some(date("2026-04-25")),
            ..BlockDateSnapshot::default()
        };
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    #[test]
    fn purge_block_is_none() {
        // PurgeBlock follows a DeleteBlock that already emitted.
        let rec = make_record(&OpPayload::PurgeBlock(crate::op::PurgeBlockPayload {
            block_id: bid(),
        }));
        let prior = BlockDateSnapshot::default();
        assert!(compute_dirty_event(&rec, &prior, today()).is_none());
    }

    // ── block_id_of / parse_iso_date ──────────────────────────────────

    #[test]
    fn parse_iso_date_accepts_valid() {
        assert_eq!(parse_iso_date("2026-04-22"), Some(date("2026-04-22")));
    }

    #[test]
    fn parse_iso_date_rejects_invalid() {
        assert_eq!(parse_iso_date("2026/04/22"), None);
        assert_eq!(parse_iso_date(""), None);
        assert_eq!(parse_iso_date("abc"), None);
    }

    #[test]
    fn block_id_of_extracts_from_set_property() {
        let rec = set_property("due_date", Some("2026-04-25"), None);
        assert_eq!(block_id_of(&rec).unwrap(), Some("BLK-TEST-01".to_owned()));
    }

    #[test]
    fn block_id_of_none_for_attachment_ops() {
        let rec = make_record(&OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
            attachment_id: "att-1".into(),
            block_id: bid(),
            filename: "f.png".into(),
            fs_path: "/tmp/f.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 100,
        }));
        // AddAttachment has a block_id field too but per the
        // block_id_of helper we filter it out since attachment ops
        // don't interact with agenda dates.
        assert_eq!(block_id_of(&rec).unwrap(), None);
    }
}
