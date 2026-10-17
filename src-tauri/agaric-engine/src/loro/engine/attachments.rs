//! Attachment metadata in the engine (#5608): `AddAttachment` /
//! `DeleteAttachment` / `RenameAttachment` and the read the `attachments`
//! projection is rebuilt from.
//!
//! Under [`BLOCK_ATTACHMENTS_ROOT`] each block owns a map keyed by attachment
//! id, and each entry is a map of the op's fields. Both levels are mergeable
//! children (`ensure_mergeable_map`), so two devices that first touch one block
//! or one id share the container, and every field merges last-writer-wins on
//! its own.
//!
//! A delete stamps [`FIELD_DELETED_AT`] and never removes the key: deleting a
//! key only hides a mergeable child, which the next `ensure_mergeable_map`
//! resurfaces, so a key delete racing an add would bring the attachment back.
//! `deleted_at` is written only to change it: a delete sets it, an add over a
//! tombstone clears it, and an add over no tombstone leaves it absent, so a
//! concurrent backfill never outvotes a delete.
//!
//! The engine stores the op's values as given. Filename sanitising and
//! `fs_path` coercion happen where rows are written, and the bytes never enter
//! the doc.

use super::*;

const FIELD_FILENAME: &str = "filename";
const FIELD_MIME_TYPE: &str = "mime_type";
const FIELD_FS_PATH: &str = "fs_path";
const FIELD_SIZE_BYTES: &str = "size_bytes";
const FIELD_CREATED_AT: &str = "created_at";
const FIELD_CONTENT_HASH: &str = "content_hash";

/// The fields an `AddAttachment` writes into an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentFields {
    pub filename: String,
    pub mime_type: String,
    pub fs_path: String,
    pub size_bytes: i64,
    pub created_at: i64,
    /// Left as it stands when `None`.
    pub content_hash: Option<String>,
}

impl AttachmentFields {
    /// The fields of `p`, applied at `created_at`.
    pub fn from_payload(p: &agaric_store::op::AddAttachmentPayload, created_at: i64) -> Self {
        Self {
            filename: p.filename.clone(),
            mime_type: p.mime_type.clone(),
            fs_path: p.fs_path.clone(),
            size_bytes: p.size_bytes,
            created_at,
            content_hash: None,
        }
    }
}

/// One entry as the engine holds it. A tombstone keeps the fields it last had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineAttachment {
    pub attachment_id: String,
    pub fields: AttachmentFields,
    /// `Some` once deleted.
    pub deleted_at: Option<i64>,
}

impl LoroEngine {
    /// Mirrors `AddAttachment`: writes `fields` into `block_id`'s entry for
    /// `attachment_id` and clears a tombstone it holds.
    pub fn apply_add_attachment(
        &mut self,
        block_id: &str,
        attachment_id: &str,
        fields: &AttachmentFields,
    ) -> Result<(), AppError> {
        let ctx = || format!("loro: add_attachment {attachment_id} on block {block_id}");
        let entry = self
            .doc
            .get_map(BLOCK_ATTACHMENTS_ROOT)
            .ensure_mergeable_map(block_id)
            .and_then(|block| block.ensure_mergeable_map(attachment_id))
            .map_err(|e| AppError::validation(format!("{}: {e}", ctx())))?;
        let mut writes: Vec<(&str, LoroValue)> = vec![
            (FIELD_FILENAME, LoroValue::from(fields.filename.as_str())),
            (FIELD_MIME_TYPE, LoroValue::from(fields.mime_type.as_str())),
            (FIELD_FS_PATH, LoroValue::from(fields.fs_path.as_str())),
            (FIELD_SIZE_BYTES, LoroValue::from(fields.size_bytes)),
            (FIELD_CREATED_AT, LoroValue::from(fields.created_at)),
        ];
        if let Some(hash) = &fields.content_hash {
            writes.push((FIELD_CONTENT_HASH, LoroValue::from(hash.as_str())));
        }
        for (key, value) in writes {
            entry
                .insert(key, value)
                .map_err(|e| AppError::validation(format!("{}: {key}: {e}", ctx())))?;
        }
        if entry.get(FIELD_DELETED_AT).is_some() {
            entry
                .delete(FIELD_DELETED_AT)
                .map_err(|e| AppError::validation(format!("{}: clear deleted_at: {e}", ctx())))?;
        }
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `DeleteAttachment`: stamps the entry deleted. An entry the doc
    /// lacks gets the stamp alone, so the delete still wins when an add of it
    /// arrives from a peer.
    pub fn apply_delete_attachment(
        &mut self,
        block_id: &str,
        attachment_id: &str,
        deleted_at: i64,
    ) -> Result<(), AppError> {
        let entry = self
            .doc
            .get_map(BLOCK_ATTACHMENTS_ROOT)
            .ensure_mergeable_map(block_id)
            .and_then(|block| block.ensure_mergeable_map(attachment_id))
            .and_then(|entry| {
                entry.insert(FIELD_DELETED_AT, LoroValue::from(deleted_at))?;
                Ok(entry)
            });
        entry.map_err(|e| {
            AppError::validation(format!(
                "loro: delete_attachment {attachment_id} on block {block_id}: {e}"
            ))
        })?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `RenameAttachment`. A no-op for an entry the doc lacks: a
    /// rename alone must not create one.
    pub fn apply_rename_attachment(
        &mut self,
        block_id: &str,
        attachment_id: &str,
        filename: &str,
    ) -> Result<(), AppError> {
        let Some(entry) = self.attachment_entry(block_id, attachment_id)? else {
            return Ok(());
        };
        entry
            .insert(FIELD_FILENAME, LoroValue::from(filename))
            .map_err(|e| {
                AppError::validation(format!(
                    "loro: rename_attachment {attachment_id} on block {block_id}: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }

    /// `block_id`'s entries, tombstones included, in id order; `None` when the
    /// block holds no attachment map, so a reprojection leaves alone the rows
    /// the boot backfill has not reached yet.
    pub fn read_attachments(
        &self,
        block_id: &str,
    ) -> Result<Option<Vec<EngineAttachment>>, AppError> {
        let Some(block) = self.attachment_block_map(block_id)? else {
            return Ok(None);
        };
        let mut ids = Vec::new();
        block.for_each(|id, _| ids.push(id.to_owned()));
        let mut entries = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = self.attachment_entry(block_id, &id)? {
                entries.push(read_entry(&entry, &id)?);
            }
        }
        Ok(Some(entries))
    }

    /// The block whose map holds `attachment_id`, if any.
    pub fn attachment_block(&self, attachment_id: &str) -> Option<String> {
        let root = self.doc.get_map(BLOCK_ATTACHMENTS_ROOT);
        let mut found = None;
        root.for_each(|block_id, voc| {
            if found.is_none()
                && let Some(block) = voc.into_container().ok().and_then(|c| c.into_map().ok())
                && block.get(attachment_id).is_some()
            {
                found = Some(block_id.to_owned());
            }
        });
        found
    }

    /// The attachment map `block_id` holds, if any.
    fn attachment_block_map(&self, block_id: &str) -> Result<Option<LoroMap>, AppError> {
        let Some(voc) = self.doc.get_map(BLOCK_ATTACHMENTS_ROOT).get(block_id) else {
            return Ok(None);
        };
        voc.into_container()
            .ok()
            .and_then(|c| c.into_map().ok())
            .map(Some)
            .ok_or_else(|| {
                AppError::validation(format!(
                    "loro: block {block_id}'s attachment slot is not a LoroMap"
                ))
            })
    }

    /// The entry for `attachment_id` under `block_id`, if any.
    fn attachment_entry(
        &self,
        block_id: &str,
        attachment_id: &str,
    ) -> Result<Option<LoroMap>, AppError> {
        let Some(block) = self.attachment_block_map(block_id)? else {
            return Ok(None);
        };
        let Some(voc) = block.get(attachment_id) else {
            return Ok(None);
        };
        voc.into_container()
            .ok()
            .and_then(|c| c.into_map().ok())
            .map(Some)
            .ok_or_else(|| {
                AppError::validation(format!(
                    "loro: attachment {attachment_id} on block {block_id} is not a LoroMap"
                ))
            })
    }
}

/// An entry's fields. A field the entry lacks reads as empty or zero: only a
/// delete of an entry the doc never held writes an entry without them, and
/// that entry is a tombstone, whose fields no row is written from.
fn read_entry(entry: &LoroMap, attachment_id: &str) -> Result<EngineAttachment, AppError> {
    let string = |key: &str| -> Result<Option<String>, AppError> {
        match read_value(entry, key)? {
            None => Ok(None),
            Some(LoroValue::String(s)) => Ok(Some((*s).clone())),
            Some(other) => Err(AppError::validation(format!(
                "loro: attachment {attachment_id} {key}: expected a string, got {other:?}"
            ))),
        }
    };
    let int = |key: &str| -> Result<Option<i64>, AppError> {
        match read_value(entry, key)? {
            None => Ok(None),
            Some(LoroValue::I64(n)) => Ok(Some(n)),
            Some(other) => Err(AppError::validation(format!(
                "loro: attachment {attachment_id} {key}: expected an integer, got {other:?}"
            ))),
        }
    };
    Ok(EngineAttachment {
        attachment_id: attachment_id.to_owned(),
        fields: AttachmentFields {
            filename: string(FIELD_FILENAME)?.unwrap_or_default(),
            mime_type: string(FIELD_MIME_TYPE)?.unwrap_or_default(),
            fs_path: string(FIELD_FS_PATH)?.unwrap_or_default(),
            size_bytes: int(FIELD_SIZE_BYTES)?.unwrap_or_default(),
            created_at: int(FIELD_CREATED_AT)?.unwrap_or_default(),
            content_hash: string(FIELD_CONTENT_HASH)?,
        },
        deleted_at: int(FIELD_DELETED_AT)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{AttachmentFields, EngineAttachment, LoroEngine};

    const BLOCK: &str = "01HZ0000000000000000000B01";
    const ATT: &str = "01HZ0000000000000000000A01";
    const ATT_2: &str = "01HZ0000000000000000000A02";

    fn fields(filename: &str) -> AttachmentFields {
        AttachmentFields {
            filename: filename.to_owned(),
            mime_type: "image/png".to_owned(),
            fs_path: format!("attachments/{ATT}"),
            size_bytes: 3,
            created_at: 1_000,
            content_hash: None,
        }
    }

    fn peer(device: &str) -> LoroEngine {
        let mut engine = LoroEngine::with_peer_id(device).expect("peer");
        engine
            .apply_create_block(BLOCK, "content", "img", None, 0)
            .expect("create block");
        engine
    }

    /// `a` and a second peer that imported `a`'s state.
    fn pair() -> (LoroEngine, LoroEngine) {
        let a = peer("dev-a");
        let mut b = LoroEngine::with_peer_id("dev-b").expect("peer b");
        b.import(&a.export_snapshot().unwrap()).expect("share");
        (a, b)
    }

    fn merge_both_ways(a: &mut LoroEngine, b: &mut LoroEngine) {
        let a_bytes = a.export_snapshot().expect("export a");
        let b_bytes = b.export_snapshot().expect("export b");
        a.import(&b_bytes).expect("a imports b");
        b.import(&a_bytes).expect("b imports a");
    }

    fn entries(e: &LoroEngine) -> Vec<EngineAttachment> {
        e.read_attachments(BLOCK).unwrap().unwrap_or_default()
    }

    fn converged(a: &LoroEngine, b: &LoroEngine) -> Vec<EngineAttachment> {
        let on_a = entries(a);
        assert_eq!(on_a, entries(b), "peers converge");
        on_a
    }

    #[test]
    fn add_rename_delete_and_re_add_read_back() {
        let mut e = peer("dev-a");
        assert_eq!(e.read_attachments(BLOCK).unwrap(), None, "no map yet");
        e.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        e.apply_rename_attachment(BLOCK, ATT, "b.png")
            .expect("rename");
        assert_eq!(
            entries(&e),
            vec![EngineAttachment {
                attachment_id: ATT.to_owned(),
                fields: fields("b.png"),
                deleted_at: None,
            }],
            "the add's fields under the renamed name"
        );
        e.apply_delete_attachment(BLOCK, ATT, 2_000)
            .expect("delete");
        assert_eq!(
            entries(&e)[0].deleted_at,
            Some(2_000),
            "a delete is a tombstone"
        );
        e.apply_add_attachment(BLOCK, ATT, &fields("b.png"))
            .expect("re-add");
        assert_eq!(
            entries(&e)[0].deleted_at,
            None,
            "a re-add clears the tombstone"
        );
        assert_eq!(e.attachment_block(ATT).as_deref(), Some(BLOCK));
        assert_eq!(e.attachment_block(ATT_2), None);
    }

    #[test]
    fn a_rename_of_an_entry_the_doc_lacks_creates_nothing() {
        let mut e = peer("dev-a");
        e.apply_rename_attachment(BLOCK, ATT, "x.png")
            .expect("rename");
        assert_eq!(e.read_attachments(BLOCK).unwrap(), None, "no map created");
        assert_eq!(e.attachment_block(ATT), None);
    }

    #[test]
    fn concurrent_adds_of_different_ids_both_survive() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("a adds");
        b.apply_add_attachment(BLOCK, ATT_2, &fields("b.png"))
            .expect("b adds");
        merge_both_ways(&mut a, &mut b);
        let ids: Vec<String> = converged(&a, &b)
            .into_iter()
            .map(|e| e.attachment_id)
            .collect();
        assert_eq!(
            ids,
            vec![ATT.to_owned(), ATT_2.to_owned()],
            "neither first add hides the other"
        );
    }

    #[test]
    fn one_id_added_on_two_devices_merges_to_one_entry() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("a adds");
        b.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("b adds");
        merge_both_ways(&mut a, &mut b);
        assert_eq!(converged(&a, &b).len(), 1, "one entry, one container");
    }

    #[test]
    fn concurrent_renames_resolve_to_one_name() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        b.import(&a.export_snapshot().unwrap()).expect("share add");
        a.apply_rename_attachment(BLOCK, ATT, "from-a.png")
            .expect("a renames");
        b.apply_rename_attachment(BLOCK, ATT, "from-b.png")
            .expect("b renames");
        merge_both_ways(&mut a, &mut b);
        let name = converged(&a, &b)[0].fields.filename.clone();
        assert!(
            name == "from-a.png" || name == "from-b.png",
            "one of the two renames wins, got {name}"
        );
    }

    #[test]
    fn a_delete_beats_a_concurrent_rename_on_both_devices() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        b.import(&a.export_snapshot().unwrap()).expect("share add");
        a.apply_delete_attachment(BLOCK, ATT, 2_000)
            .expect("a deletes");
        b.apply_rename_attachment(BLOCK, ATT, "renamed.png")
            .expect("b renames");
        merge_both_ways(&mut a, &mut b);
        let entry = converged(&a, &b).remove(0);
        assert_eq!(entry.deleted_at, Some(2_000), "deleted on both devices");
        assert_eq!(entry.fields.filename, "renamed.png", "under the new name");
    }

    #[test]
    fn a_delete_beats_a_concurrent_add_of_the_same_id() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        b.import(&a.export_snapshot().unwrap()).expect("share add");
        a.apply_delete_attachment(BLOCK, ATT, 2_000)
            .expect("a deletes");
        // A second device seeding the same row writes no `deleted_at`.
        b.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("b seeds");
        merge_both_ways(&mut a, &mut b);
        assert_eq!(
            converged(&a, &b)[0].deleted_at,
            Some(2_000),
            "a backfill of a live row does not outvote a delete"
        );
    }

    #[test]
    fn a_re_add_after_a_merged_delete_brings_the_entry_back_everywhere() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        a.apply_delete_attachment(BLOCK, ATT, 2_000)
            .expect("delete");
        merge_both_ways(&mut a, &mut b);
        b.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("b undoes the delete");
        merge_both_ways(&mut a, &mut b);
        assert_eq!(
            converged(&a, &b)[0].deleted_at,
            None,
            "the later re-add wins"
        );
    }

    #[test]
    fn a_delete_of_an_entry_the_doc_lacks_wins_over_the_add_when_it_arrives() {
        let (mut a, mut b) = pair();
        a.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("a adds");
        b.apply_delete_attachment(BLOCK, ATT, 2_000)
            .expect("b deletes an entry it never saw");
        merge_both_ways(&mut a, &mut b);
        let entry = converged(&a, &b).remove(0);
        assert_eq!(entry.deleted_at, Some(2_000), "the stamp merges in");
        assert_eq!(entry.fields, fields("a.png"), "beside the add's fields");
    }

    /// An import that only touches attachment entries reprojects their block
    /// alone; an unrecognised root would reproject the whole tree instead.
    #[test]
    fn an_imported_attachment_change_reprojects_only_its_block() {
        use crate::loro::engine::TagScope;
        let (mut a, mut b) = pair();
        let other = "01HZ0000000000000000000B02";
        a.apply_create_block(other, "content", "other", None, 1)
            .expect("second block");
        b.import(&a.export_snapshot().unwrap()).expect("share it");
        let steps: [&dyn Fn(&mut LoroEngine); 3] = [
            &|e| {
                e.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
                    .unwrap()
            },
            &|e| e.apply_rename_attachment(BLOCK, ATT, "b.png").unwrap(),
            &|e| e.apply_delete_attachment(BLOCK, ATT, 2_000).unwrap(),
        ];
        for step in steps {
            step(&mut a);
            let delta = b
                .import_with_changed_purged_tagscope(&a.export_snapshot().unwrap())
                .expect("import");
            assert_eq!(
                delta.changed,
                vec![agaric_core::ulid::BlockId::from_trusted(BLOCK)],
                "only the attachment's block is reprojected"
            );
            assert_ne!(delta.tag_scope, TagScope::Global, "no whole-tree fallback");
        }
    }

    #[test]
    fn purge_drops_the_blocks_attachment_map() {
        let mut e = peer("dev-a");
        e.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        e.apply_purge_block(BLOCK).expect("purge");
        assert_eq!(e.read_attachments(BLOCK).unwrap(), None, "map gone");
        assert_eq!(e.attachment_block(ATT), None, "and no probe finds it");
    }

    /// The hazard the tombstone exists for: a block's map that a purge hid
    /// comes back whole the next time it is ensured, entries and all. Only a
    /// tombstone written into the entry survives that; a removed key would
    /// have come back live.
    #[test]
    fn a_hidden_map_resurfaces_with_its_entries_and_their_tombstones() {
        let mut e = peer("dev-a");
        e.apply_add_attachment(BLOCK, ATT, &fields("a.png"))
            .expect("add");
        e.apply_add_attachment(BLOCK, ATT_2, &fields("b.png"))
            .expect("add second");
        e.apply_delete_attachment(BLOCK, ATT_2, 2_000)
            .expect("delete second");
        e.apply_purge_block(BLOCK).expect("purge hides the map");
        e.apply_create_block(BLOCK, "content", "img", None, 0)
            .expect("the block comes back");
        let new_id = "01HZ0000000000000000000A03";
        e.apply_add_attachment(BLOCK, new_id, &fields("c.png"))
            .expect("an add ensures the map again");
        let states: Vec<(String, Option<i64>)> = entries(&e)
            .into_iter()
            .map(|a| (a.attachment_id, a.deleted_at))
            .collect();
        assert_eq!(
            states,
            vec![
                (ATT.to_owned(), None),
                (ATT_2.to_owned(), Some(2_000)),
                (new_id.to_owned(), None),
            ],
            "the old entries resurface as they were; the tombstone holds"
        );
    }
}
