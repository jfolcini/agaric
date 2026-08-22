//! Reverse functions for attachment ops (add, delete, rename).

use agaric_core::error::AppError;
use agaric_store::op::OpPayload;
use agaric_store::op_log::OpRecord;
use sqlx::SqlitePool;

pub fn reverse_add_attachment(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: agaric_store::op::AddAttachmentPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::DeleteAttachment(
        agaric_store::op::DeleteAttachmentPayload {
            attachment_id: payload.attachment_id,
            // Carry forward the original `fs_path` so the reverse op can
            // unlink the file the AddAttachment created.
            fs_path: payload.fs_path,
        },
    ))
}

/// Point a reconstructed `add_attachment` reverse at the `fs_path` the row
/// actually held **when it was deleted**, rather than the one it was created
/// with (#3706 review).
///
/// The reverse of a `delete_attachment` is rebuilt from the original
/// `add_attachment` op, so every field it restores is the field the row was
/// *born* with. For `fs_path` that is wrong whenever something repointed the
/// live row in between, and three production paths do exactly that — all of
/// them moving a row onto a shared content-addressed blob:
///
/// * `recovery::attachment_blob_backfill` — repoints every row in a
///   content-hash group at the group's canonical blob file.
/// * `agaric_sync::sync_files::maybe_link_local_blob` — a row whose bytes are
///   missing is linked to a local blob that already holds them instead of
///   being re-requested.
/// * `agaric_sync::sync_files`' `FileOffer` skip path — an offered file whose
///   hash we already hold repoints the row at the blob we have.
///
/// After such a repoint the ORIGINAL path is referenced by nothing, so the
/// orphan GC reclaims it as a matter of course while the bytes stay perfectly
/// alive under the blob path. Reconstructing the reverse from the original
/// payload would then name a file that is gone: before #3706 that committed a
/// dangling row, and with the #3706 byte-existence guard it *refuses an undo
/// whose bytes are right there*. Both are wrong, and they are wrong for the
/// same reason — the reverse is naming the wrong file.
///
/// `DeleteAttachmentPayload::fs_path` is captured by
/// `delete_attachment_inner` from the LIVE row inside the delete's own
/// transaction, so it is the post-repoint value by construction. Adopting it
/// makes the undo restore the row exactly as it stood the instant before the
/// delete, which is what an undo is supposed to mean, and it keeps the
/// op-log's reverse op and the restored row naming the same file (the reverse
/// op is what replicates, so a divergence there would ship peers a path this
/// device never used).
///
/// It is applied in the *payload*, not at the guard, deliberately: the #3706
/// guard stats the payload's `fs_path` and the reverse `INSERT` stores the
/// payload's `fs_path` through one shared helper
/// (`commands::history::reverse_add_attachment_fs_path`), so correcting the
/// payload keeps checked-path and stored-path identical instead of
/// reintroducing the drift that helper exists to prevent.
///
/// # When the delete-time path is not usable
///
/// Empty only. `fs_path` is `#[serde(default)]` on
/// [`agaric_store::op::DeleteAttachmentPayload`] for op-log rows written
/// before C-3, which deserialize to `""`; those keep the original payload's
/// path, which is all that was ever recorded for them.
///
/// One other "is it stale too?" case resolves to *no worse than the
/// original*:
///
/// * A *peer's* delete op would carry that peer's device-local path, which is
///   meaningless here — but no reverse path can reach one: `revert_ops_in_tx`
///   calls `reject_replicated_targets` first, and every other undo/redo
///   target query filters `is_replicated = 0` (#2481/#2549).
///
/// # Residual: a LEGACY pre-C-3 delete of a repointed row false-refuses
///
/// "All that was ever recorded for them" is accurate but incomplete: for a
/// legacy delete it is also a REFUSAL CASE, structurally identical to the
/// redo residual below, and it deserves saying out loud rather than being
/// left as a fallback footnote.
///
/// A `delete_attachment` op written before C-3 carries no `fs_path` at all,
/// so this function has nothing to adopt and the reverse is reconstructed
/// from the ORIGINAL `add_attachment` payload — the pre-#3706-review
/// behaviour, for exactly the ops that predate the fix. If one of the three
/// repointers moved that row onto a shared blob at any time before the
/// delete, the original path is the one the ordinary sweep reclaimed, and
/// the #3706 byte-existence guard now refuses the undo — over bytes that are
/// alive and readable under the blob path the row actually held.
///
/// Same false refusal as the redo residual, same shape, different entry
/// point, and equally not closable from inside this function: the
/// information was never written. Closing it would mean reading the live row
/// — but for a legacy delete the row is already gone by undo time, so there
/// is nothing to read; the only real fix is the delete-time capture that C-3
/// added, which by definition cannot apply retroactively. The exposure
/// therefore shrinks on its own as pre-C-3 ops age out of op-log retention.
/// Strictly better than pre-#3706 either way (which would have committed a
/// row over the reclaimed path instead of refusing), but a false refusal, not
/// a fixed path.
///
/// # Residual: `filename` is still the CREATION-time name
///
/// The same staleness class this function fixes for `fs_path` remains
/// unfixed for `filename`, and for the same structural reason — every field
/// of the reconstructed `AddAttachmentPayload` is the field the row was
/// *born* with.
///
/// `rename_attachment` is a first-class op with its own forward apply and its
/// own reverse ([`reverse_rename_attachment`]), so `add → rename → delete →
/// undo` restores the PRE-rename filename: the user gets their attachment
/// back under a name they had already changed. The redo of the delete then
/// renames nothing back, because the rename op is not part of this undo at
/// all — it sits earlier in the stack, untouched.
///
/// The payload-adoption trick does not apply here:
/// [`agaric_store::op::DeleteAttachmentPayload`] carries `attachment_id` and
/// `fs_path` and nothing else, so unlike `fs_path` there is no delete-time
/// `filename` in the op log to adopt. Fixing it means either widening that
/// payload (a schema-adjacent change with its own `#[serde(default)]`
/// migration story, exactly like C-3's) or having the reverse read the live
/// row inside the delete's transaction — both deliberately out of scope for
/// the #3706 review, which is why this is documented rather than fixed.
///
/// Consequences are strictly cosmetic-plus: a wrong display name and a wrong
/// download name. Unlike a stale `fs_path` it cannot dangle the row or trip
/// the byte-existence guard, since `filename` is metadata and nothing
/// resolves bytes through it.
///
/// # Not stale: the other reconstructed fields
///
/// For completeness, the remaining `AddAttachmentPayload` fields are
/// creation-time values that are *supposed* to be creation-time values —
/// `mime_type` and `size_bytes` describe the bytes, which are immutable
/// under content addressing, and `attachment_id` / `block_id` are identity.
/// Only `fs_path` (fixed here) and `filename` (above) have first-class ops
/// that can change them behind the reverse's back.
///
/// # Residual: redo after undo-of-add can still false-refuse
///
/// A `delete_attachment` minted by [`reverse_add_attachment`] (the reverse of
/// undoing an `add_attachment`) copies the ADD payload's ORIGINAL `fs_path`
/// forward rather than reading the live row — see that function's doc. This
/// module's adoption fixes the case where a REAL `delete_attachment` observes
/// the repoint; it does nothing for a SYNTHETIC one that never does.
///
/// Concretely: add → something repoints the row onto a shared blob → the
/// ordinary sweep reclaims the now-orphaned original path (the bytes stay
/// alive under the blob) → undo the add (hard-deletes the row; the synthetic
/// `delete_attachment` this mints carries the ORIGINAL path, since
/// `reverse_add_attachment` never saw the repoint) → redo reconstructs the
/// `add_attachment` from that synthetic op, this function finds no
/// delete-time path to adopt (there is only the original, already-reclaimed
/// one), and the #3706 byte-existence guard refuses — over bytes that are
/// right there under the blob.
///
/// This is strictly better than pre-#3706 (which would have committed a row
/// over the reclaimed path instead of refusing), but it is a **false
/// refusal**, not a fully-fixed path. Closing it symmetrically would mean
/// [`reverse_add_attachment`] reading the live row instead of its own
/// payload — a wider change, deliberately not made in the #3706 review.
pub(super) fn adopt_delete_time_fs_path(
    delete_fs_path: &str,
    add_payload: &mut agaric_store::op::AddAttachmentPayload,
) {
    if delete_fs_path.is_empty() || delete_fs_path == add_payload.fs_path {
        return;
    }
    tracing::debug!(
        attachment_id = add_payload.attachment_id.as_str(),
        original = %add_payload.fs_path,
        at_delete = %delete_fs_path,
        "restoring a deleted attachment at the path it held when it was deleted, \
         not the one it was created with (#3706 review)"
    );
    add_payload.fs_path = delete_fs_path.to_owned();
}

/// Reverse a `delete_attachment` op by reconstructing the `add_attachment`
/// payload that originally created the row.
///
/// # Performance characteristic
///
/// The lookup predicate is
/// `op_type = 'add_attachment' AND attachment_id = ?1`, served by the
/// partial index `idx_op_log_attachment_id` (migration 0064 / SQL-review
/// B-4). This is O(log N) on the number of attachment ops, mirroring the
/// `block_id` denormalisation done for the block-scoped reverse-op
/// lookups in `block_ops` and `property_ops` (migration 0030).
pub async fn reverse_delete_attachment(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: agaric_store::op::DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
    let attachment_id = payload.attachment_id.as_str();
    // (f): this query mirrors the
    // `(created_at < ?ts OR (created_at = ?ts AND seq < ?seq)) ORDER BY
    // created_at DESC, seq DESC LIMIT 1` "strictly before (ts, seq)"
    // shape used by `block_ops::find_prior_text`,
    // `block_ops::find_prior_position`, and
    // `property_ops::find_prior_property`. Reads the native indexed
    // `op_log.attachment_id` column (migration 0064 / SQL-review B-4)
    // — the partial index `idx_op_log_attachment_id` covers the
    // `WHERE attachment_id IS NOT NULL` subset, so `add_attachment`
    // and `delete_attachment` rows are O(log N) lookups.
    //
    // #382: the op_log PK is `(device_id, seq)` and `seq` is a PER-DEVICE
    // counter, so the "strictly before" predicate tie-breaks on the full
    // canonical `(created_at, seq, device_id)` total order — matching the
    // other reverse-op prior-context lookups and `commands/history.rs` /
    // `pagination/history.rs`.
    // #2549: `AND is_replicated = 0` — reconstruct the original
    // `add_attachment` from a locally-applied op only. A #2495 audit-only
    // replicated row (`is_replicated = 1`) was never applied to local state,
    // so restoring an attachment from it would resurrect a row this device
    // never held. Mirrors the block/property prior-state walks.
    let original = sqlx::query!(
        r#"SELECT payload FROM op_log
         WHERE op_type = 'add_attachment'
         AND attachment_id = ?1
         AND is_replicated = 0
         AND (created_at < ?2
              OR (created_at = ?2 AND (seq < ?3 OR (seq = ?3 AND device_id < ?4))))
         ORDER BY created_at DESC, seq DESC, device_id DESC
         LIMIT 1"#,
        attachment_id,
        record.created_at,
        record.seq,
        record.device_id
    )
    .fetch_optional(pool)
    .await?;
    match original {
        Some(row) => {
            let mut add_payload: agaric_store::op::AddAttachmentPayload =
                serde_json::from_str(&row.payload)?;
            // #3706 review: restore the row at the path it held AT DELETE
            // TIME, not at creation — see `adopt_delete_time_fs_path`.
            adopt_delete_time_fs_path(&payload.fs_path, &mut add_payload);
            Ok(OpPayload::AddAttachment(add_payload))
        }
        None => Err(AppError::NonReversible {
            op_type: "delete_attachment".into(),
        }),
    }
}

/// Reverse a `rename_attachment` op by swapping old and new filenames.
pub fn reverse_rename_attachment(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: agaric_store::op::RenameAttachmentPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RenameAttachment(
        agaric_store::op::RenameAttachmentPayload {
            attachment_id: payload.attachment_id,
            old_filename: payload.new_filename,
            new_filename: payload.old_filename,
        },
    ))
}
