//! Property definitions in the engine (#5841): `SetPropertyDef`,
//! `RenamePropertyKey`, `RenamePropertyOption`, `RewriteProperties` and the
//! reads the SQL
//! `property_definitions` projection is rebuilt from.
//!
//! Under [`PROPERTY_DEFINITIONS_ROOT`] each key the space declares holds one
//! plain map value `{value_type, options}`, never a container: two devices
//! that declare one key concurrently write the same slot, and Loro's per-key
//! last-writer-wins keeps one whole definition rather than orphaning the
//! entries of a losing container.

use agaric_store::op::{PropertyDefState, RewritePropertiesPayload};

use super::*;

const FIELD_VALUE_TYPE: &str = "value_type";
const FIELD_OPTIONS: &str = "options";

/// `def` as the root stores it.
fn def_to_loro(def: &PropertyDefState) -> LoroValue {
    let options = def
        .options
        .as_deref()
        .map_or(LoroValue::Null, LoroValue::from);
    LoroValue::Map(
        vec![
            (
                FIELD_VALUE_TYPE.to_owned(),
                LoroValue::from(def.value_type.as_str()),
            ),
            (FIELD_OPTIONS.to_owned(), options),
        ]
        .into(),
    )
}

/// The definition the root holds under `key`.
fn def_from_loro(key: &str, value: &LoroValue) -> Result<PropertyDefState, AppError> {
    let shape = |what: &str| {
        AppError::validation(format!(
            "loro: property definition {key}: {what}, got {value:?}"
        ))
    };
    let LoroValue::Map(fields) = value else {
        return Err(shape("expected a map"));
    };
    let value_type = match fields.get(FIELD_VALUE_TYPE) {
        Some(LoroValue::String(s)) => s.to_string(),
        _ => return Err(shape("value_type is not a string")),
    };
    let options = match fields.get(FIELD_OPTIONS) {
        Some(LoroValue::String(s)) => Some(s.to_string()),
        None | Some(LoroValue::Null) => None,
        Some(_) => return Err(shape("options is neither a string nor null")),
    };
    Ok(PropertyDefState {
        value_type,
        options,
    })
}

/// `options` (a JSON array of strings) with `old` replaced by `new` in place,
/// compact as `JSON.stringify` writes it; `None` when they do not list `old`,
/// already list `new`, or do not parse, so a replay or a peer's concurrent edit
/// leaves the definition as it is.
fn renamed_options(options: Option<&str>, old: &str, new: &str) -> Option<String> {
    let mut list: Vec<String> = serde_json::from_str(options?).ok()?;
    if list.iter().any(|o| o == new) {
        return None;
    }
    let slot = list.iter_mut().find(|o| *o == old)?;
    new.clone_into(slot);
    serde_json::to_string(&list).ok()
}

impl LoroEngine {
    /// Mirrors `SetPropertyDef`: files `def` under `key`, or drops the key on
    /// `None`. Writing what the root already holds records no op.
    pub fn apply_set_property_def(
        &mut self,
        key: &str,
        def: Option<&PropertyDefState>,
    ) -> Result<(), AppError> {
        if self.put_property_def(key, def)? {
            self.doc.commit();
        }
        Ok(())
    }

    /// [`Self::apply_set_property_def`] without the commit; `false` when the
    /// root already held `def`.
    fn put_property_def(
        &mut self,
        key: &str,
        def: Option<&PropertyDefState>,
    ) -> Result<bool, AppError> {
        let root = self.doc.get_map(PROPERTY_DEFINITIONS_ROOT);
        let held = root.get(key).and_then(|voc| voc.into_value().ok());
        let wanted = def.map(def_to_loro);
        if held == wanted {
            return Ok(false);
        }
        match wanted {
            Some(value) => root.insert(key, value),
            None => root.delete(key),
        }
        .map_err(|e| AppError::validation(format!("loro: set_property_def {key}: {e}")))?;
        Ok(true)
    }

    /// Mirrors `RenamePropertyKey`: every block holding `old_key` and no value
    /// under `new_key` (an explicit null counts as none, as SQL holds no row
    /// for it) gets the value under `new_key` instead, and the definition
    /// moves when the root declares `old_key` and not `new_key`. A block or a
    /// root already holding `new_key` keeps it, so a replay leaves a later
    /// write under `old_key` where it is. Nothing to move records no op.
    pub fn apply_rename_property_key(
        &mut self,
        old_key: &str,
        new_key: &str,
    ) -> Result<(), AppError> {
        let movable = self.blocks_movable(old_key, new_key)?;
        let rename_err =
            |e: loro::LoroError| AppError::validation(format!("loro: rename {old_key}: {e}"));
        for (block_props, value) in &movable {
            block_props
                .insert(new_key, value.clone())
                .map_err(rename_err)?;
            block_props.delete(old_key).map_err(rename_err)?;
        }
        let defs = self.doc.get_map(PROPERTY_DEFINITIONS_ROOT);
        let def_moves = defs.get(new_key).is_none();
        if let (Some(def), true) = (defs.get(old_key), def_moves) {
            let def = def.into_value().map_err(|_| {
                AppError::validation(format!(
                    "loro: property definition {old_key} is a container"
                ))
            })?;
            defs.insert(new_key, def).map_err(rename_err)?;
            defs.delete(old_key).map_err(rename_err)?;
        }
        self.doc.commit();
        Ok(())
    }

    /// The per-block maps [`Self::apply_rename_property_key`] moves a value
    /// in, with the value, collected before any is changed.
    fn blocks_movable(
        &self,
        old_key: &str,
        new_key: &str,
    ) -> Result<Vec<(LoroMap, LoroValue)>, AppError> {
        let mut movable = Vec::new();
        let mut err = None;
        self.doc
            .get_map(BLOCK_PROPERTIES_ROOT)
            .for_each(|block_id, voc| {
                if err.is_some() {
                    return;
                }
                let Some(block_props) = voc.into_container().ok().and_then(|c| c.into_map().ok())
                else {
                    err = Some(AppError::validation(format!(
                        "loro: rename block {block_id} props is not a LoroMap"
                    )));
                    return;
                };
                let Some(held) = block_props.get(old_key) else {
                    return;
                };
                let taken = block_props
                    .get(new_key)
                    .is_some_and(|voc| !matches!(voc.into_value(), Ok(LoroValue::Null)));
                match held.into_value() {
                    Ok(value) if !taken => movable.push((block_props, value)),
                    Ok(_) => {}
                    Err(_) => {
                        err = Some(AppError::validation(format!(
                            "loro: rename {block_id}/{old_key} expected scalar"
                        )));
                    }
                }
            });
        err.map_or(Ok(movable), Err)
    }

    /// Mirrors `RenamePropertyOption`: every block whose `key` holds the
    /// string `old` gets `new`, and the definition's options swap `old` for
    /// `new` in place when they hold `old` and not `new`. One commit; nothing
    /// to change records no op. Returns the definition the root holds after.
    pub fn apply_rename_property_option(
        &mut self,
        key: &str,
        old: &str,
        new: &str,
    ) -> Result<Option<PropertyDefState>, AppError> {
        let rename_err =
            |e: loro::LoroError| AppError::validation(format!("loro: rename option {key}: {e}"));
        for block_props in self.blocks_holding_str(key, old)? {
            block_props
                .insert(key, LoroValue::from(new))
                .map_err(rename_err)?;
        }
        let mut def = self.read_property_def(key)?;
        if let Some(def) = def.as_mut()
            && let Some(options) = renamed_options(def.options.as_deref(), old, new)
        {
            def.options = Some(options);
            self.put_property_def(key, Some(def))?;
        }
        self.doc.commit();
        Ok(def)
    }

    /// The per-block maps whose `key` holds the string `value`, collected
    /// before any is changed.
    fn blocks_holding_str(&self, key: &str, value: &str) -> Result<Vec<LoroMap>, AppError> {
        let mut holding = Vec::new();
        let mut err = None;
        self.doc
            .get_map(BLOCK_PROPERTIES_ROOT)
            .for_each(|block_id, voc| {
                if err.is_some() {
                    return;
                }
                let Some(block_props) = voc.into_container().ok().and_then(|c| c.into_map().ok())
                else {
                    err = Some(AppError::validation(format!(
                        "loro: rename option block {block_id} props is not a LoroMap"
                    )));
                    return;
                };
                let held = block_props.get(key).and_then(|voc| voc.into_value().ok());
                if matches!(held, Some(LoroValue::String(s)) if s.as_str() == value) {
                    holding.push(block_props);
                }
            });
        err.map_or(Ok(holding), Err)
    }

    /// Mirrors `RewriteProperties`: each definition write, then each value
    /// write (a value, or its removal), in one commit. A value of a block the
    /// doc no longer holds, one purged since the op was written, is dropped.
    pub fn apply_rewrite_properties(
        &mut self,
        p: &RewritePropertiesPayload,
    ) -> Result<(), AppError> {
        for write in &p.defs {
            self.put_property_def(&write.key, write.def.as_ref())?;
        }
        for write in &p.values {
            let block_id = write.block_id.as_str();
            if !self.contains_block(block_id) {
                continue;
            }
            match &write.value {
                Some(value) => self.put_property(block_id, &write.key, &value.into())?,
                None => {
                    self.remove_property(block_id, &write.key)?;
                }
            }
        }
        self.doc.commit();
        Ok(())
    }

    /// The definition of `key` the root holds.
    pub fn read_property_def(&self, key: &str) -> Result<Option<PropertyDefState>, AppError> {
        let Some(voc) = self.doc.get_map(PROPERTY_DEFINITIONS_ROOT).get(key) else {
            return Ok(None);
        };
        let value = voc.into_value().map_err(|_| {
            AppError::validation(format!("loro: property definition {key} is a container"))
        })?;
        def_from_loro(key, &value).map(Some)
    }

    /// Every definition the root holds, in key order.
    pub fn read_property_defs(&self) -> Result<Vec<(String, PropertyDefState)>, AppError> {
        let mut defs = Vec::new();
        let mut err = None;
        self.doc
            .get_map(PROPERTY_DEFINITIONS_ROOT)
            .for_each(|key, voc| {
                if err.is_some() {
                    return;
                }
                let read = voc
                    .into_value()
                    .map_err(|_| {
                        AppError::validation(format!(
                            "loro: property definition {key} is a container"
                        ))
                    })
                    .and_then(|value| def_from_loro(key, &value));
                match read {
                    Ok(def) => defs.push((key.to_owned(), def)),
                    Err(e) => err = Some(e),
                }
            });
        err.map_or(Ok(defs), Err)
    }

    /// Every block of the doc holding a value under `key`, with the value: the
    /// rows a change of the key's type re-types.
    pub fn read_property_holders(
        &self,
        key: &str,
    ) -> Result<Vec<(String, PropertyValue)>, AppError> {
        let mut holders = Vec::new();
        let mut err = None;
        self.doc
            .get_map(BLOCK_PROPERTIES_ROOT)
            .for_each(|block_id, voc| {
                if err.is_some() {
                    return;
                }
                let Some(block_props) = voc.into_container().ok().and_then(|c| c.into_map().ok())
                else {
                    err = Some(AppError::validation(format!(
                        "loro: read_property_holders block {block_id} props is not a LoroMap"
                    )));
                    return;
                };
                let Some(held) = block_props.get(key) else {
                    return;
                };
                let value = held
                    .into_value()
                    .map_err(|_| {
                        AppError::validation(format!(
                            "loro: read_property_holders {block_id}/{key} expected scalar"
                        ))
                    })
                    .and_then(PropertyValue::from_loro);
                match value {
                    Ok(value) => holders.push((block_id.to_owned(), value)),
                    Err(e) => err = Some(e),
                }
            });
        err.map_or(Ok(holders), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(value_type: &str, options: Option<&str>) -> PropertyDefState {
        PropertyDefState {
            value_type: value_type.to_owned(),
            options: options.map(str::to_owned),
        }
    }

    fn merge_both_ways(a: &mut LoroEngine, b: &mut LoroEngine) {
        let a_bytes = a.export_snapshot().expect("export a");
        let b_bytes = b.export_snapshot().expect("export b");
        a.import(&b_bytes).expect("a imports b");
        b.import(&a_bytes).expect("b imports a");
    }

    #[test]
    fn create_edit_and_delete_read_back() {
        let mut e = LoroEngine::with_peer_id("dev-a").expect("peer");
        e.apply_set_property_def("stage", Some(&def("select", Some(r#"["a"]"#))))
            .expect("create");
        e.apply_set_property_def("due2", Some(&def("date", None)))
            .expect("create");
        assert_eq!(
            e.read_property_def("stage").unwrap(),
            Some(def("select", Some(r#"["a"]"#))),
            "a created definition reads back whole"
        );
        e.apply_set_property_def("stage", Some(&def("select", Some(r#"["a","b"]"#))))
            .expect("edit");
        e.apply_set_property_def("due2", None).expect("delete");
        assert_eq!(
            e.read_property_defs().unwrap(),
            vec![("stage".to_owned(), def("select", Some(r#"["a","b"]"#)))],
            "the edit replaced the options and the delete dropped the key"
        );
        assert_eq!(e.read_property_def("due2").unwrap(), None, "deleted");
    }

    #[test]
    fn concurrent_edits_of_one_key_converge_to_one_definition() {
        let mut a = LoroEngine::with_peer_id("dev-a").expect("peer a");
        let mut b = LoroEngine::with_peer_id("dev-b").expect("peer b");
        a.apply_set_property_def("stage", Some(&def("select", Some(r#"["a"]"#))))
            .expect("a declares");
        b.apply_set_property_def("stage", Some(&def("select", Some(r#"["b"]"#))))
            .expect("b declares");
        b.apply_set_property_def("url", Some(&def("text", None)))
            .expect("b declares another key");
        merge_both_ways(&mut a, &mut b);
        let on_a = a.read_property_defs().unwrap();
        assert_eq!(on_a, b.read_property_defs().unwrap(), "peers converge");
        assert_eq!(on_a.len(), 2, "one definition per key");
        assert!(
            [
                def("select", Some(r#"["a"]"#)),
                def("select", Some(r#"["b"]"#))
            ]
            .contains(&on_a[0].1),
            "the key keeps one writer's whole definition, got {:?}",
            on_a[0].1
        );
    }

    #[test]
    fn writing_the_held_definition_records_no_op() {
        let mut e = LoroEngine::with_peer_id("dev-a").expect("peer");
        e.apply_set_property_def("stage", Some(&def("text", None)))
            .expect("create");
        let before = e.doc.oplog_frontiers();
        e.apply_set_property_def("stage", Some(&def("text", None)))
            .expect("re-apply");
        e.apply_set_property_def("absent", None)
            .expect("delete of an absent key");
        assert_eq!(
            e.doc.oplog_frontiers(),
            before,
            "a replayed op leaves the doc as it was"
        );
    }

    /// An engine of `peer` whose blocks `B1`, `B2` and `B3` hold `project`
    /// (`p1`, `p2`, `p3`), declared text.
    fn holding_project(peer: &str) -> LoroEngine {
        let mut e = LoroEngine::with_peer_id(peer).expect("peer");
        e.apply_set_property_def("project", Some(&def("text", None)))
            .expect("declare");
        for (id, value) in [("B1", "p1"), ("B2", "p2"), ("B3", "p3")] {
            e.apply_create_block(id, "content", id, None, 0)
                .expect("create block");
            e.apply_set_property(id, "project", Some(value))
                .expect("set");
        }
        e
    }

    /// Every block's `key` value, by block id.
    fn values_of(e: &LoroEngine, key: &str) -> Vec<(String, PropertyValue)> {
        let mut holders = e.read_property_holders(key).unwrap();
        holders.sort_by(|a, b| a.0.cmp(&b.0));
        holders
    }

    fn text(id: &str, value: &str) -> (String, PropertyValue) {
        (id.to_owned(), PropertyValue::Str(value.to_owned()))
    }

    #[test]
    fn rename_moves_every_value_and_the_definition() {
        let mut e = holding_project("dev-a");
        e.apply_rename_property_key("project", "area")
            .expect("rename");
        assert_eq!(
            values_of(&e, "area"),
            vec![text("B1", "p1"), text("B2", "p2"), text("B3", "p3")],
            "every value moved"
        );
        assert!(values_of(&e, "project").is_empty(), "none stayed behind");
        assert_eq!(
            e.read_property_def("area").unwrap(),
            Some(def("text", None))
        );
        assert_eq!(e.read_property_def("project").unwrap(), None);
    }

    /// Boot replay can meet the rename again after a later write under the
    /// old key: the block already holding the new key keeps both values.
    #[test]
    fn a_replayed_rename_leaves_a_later_old_key_write_where_it_is() {
        let mut e = holding_project("dev-a");
        e.apply_rename_property_key("project", "area")
            .expect("rename");
        e.apply_set_property("B1", "project", Some("later"))
            .expect("a later write");
        e.apply_rename_property_key("project", "area")
            .expect("replay");
        assert_eq!(
            values_of(&e, "area"),
            vec![text("B1", "p1"), text("B2", "p2"), text("B3", "p3")],
            "the renamed value is not overwritten"
        );
        assert_eq!(
            values_of(&e, "project"),
            vec![text("B1", "later")],
            "the later write stays under its key"
        );
    }

    #[test]
    fn a_second_rename_apply_records_no_op() {
        let mut e = holding_project("dev-a");
        e.apply_rename_property_key("project", "area")
            .expect("rename");
        let before = e.doc.oplog_frontiers();
        e.apply_rename_property_key("project", "area")
            .expect("re-apply");
        assert_eq!(e.doc.oplog_frontiers(), before, "nothing left to move");
    }

    /// A peer that writes the old key without having seen the rename: its
    /// value meets the rename's delete of the slot and Loro keeps one of the
    /// two, the same on both peers; every other block holds the new key.
    #[test]
    fn a_concurrent_write_of_the_old_key_converges() {
        let mut a = holding_project("dev-a");
        let mut b = LoroEngine::with_peer_id("dev-b").expect("peer b");
        b.import(&a.export_snapshot().unwrap()).expect("b joins");
        a.apply_rename_property_key("project", "area")
            .expect("a renames");
        b.apply_set_property("B1", "project", Some("from-b"))
            .expect("b writes the old key");
        merge_both_ways(&mut a, &mut b);
        assert_eq!(
            values_of(&a, "project"),
            values_of(&b, "project"),
            "peers converge"
        );
        assert_eq!(values_of(&a, "area"), values_of(&b, "area"));
        assert_eq!(
            values_of(&a, "area"),
            vec![text("B1", "p1"), text("B2", "p2"), text("B3", "p3")],
            "the rename's moves survive the concurrent write"
        );
        assert!(
            values_of(&a, "project")
                .iter()
                .all(|holder| *holder == text("B1", "from-b")),
            "only the peer's own write can remain under the old key"
        );
    }

    /// Two devices rename one key differently: both new keys exist, with the
    /// same values, and merging one into the other loses nothing.
    #[test]
    fn two_renames_of_one_key_keep_both_and_a_merge_loses_nothing() {
        let mut a = holding_project("dev-a");
        let mut b = LoroEngine::with_peer_id("dev-b").expect("peer b");
        b.import(&a.export_snapshot().unwrap()).expect("b joins");
        a.apply_rename_property_key("project", "area")
            .expect("a renames");
        b.apply_rename_property_key("project", "domain")
            .expect("b renames");
        merge_both_ways(&mut a, &mut b);
        let all = vec![text("B1", "p1"), text("B2", "p2"), text("B3", "p3")];
        assert_eq!(values_of(&a, "area"), all, "A's key holds every value");
        assert_eq!(values_of(&a, "domain"), all, "and B's key too");
        assert!(values_of(&a, "project").is_empty());
        assert_eq!(
            a.read_property_defs().unwrap(),
            b.read_property_defs().unwrap()
        );
        assert_eq!(
            a.read_property_defs()
                .unwrap()
                .into_iter()
                .map(|(key, _)| key)
                .collect::<Vec<_>>(),
            vec!["area".to_owned(), "domain".to_owned()]
        );

        // Every block holds both keys, so merging `domain` into `area` drops
        // each `domain` value, which equals the `area` value it keeps.
        let merge = RewritePropertiesPayload {
            space_id: agaric_core::ulid::BlockId::from_trusted("SPACE"),
            reason: agaric_store::op::RewriteReason::Merge,
            defs: vec![agaric_store::op::PropertyDefWrite {
                key: "domain".into(),
                def: None,
                prior: Some(def("text", None)),
            }],
            values: ["B1", "B2", "B3"]
                .into_iter()
                .zip(["p1", "p2", "p3"])
                .map(|(id, value)| agaric_store::op::PropertyValueWrite {
                    block_id: agaric_core::ulid::BlockId::from_trusted(id),
                    key: "domain".into(),
                    value: None,
                    prior: Some(agaric_store::op::PropertyValueFields {
                        value_text: Some(value.into()),
                        ..Default::default()
                    }),
                })
                .collect(),
        };
        a.apply_rewrite_properties(&merge).expect("merge");
        assert_eq!(values_of(&a, "area"), all, "nothing lost");
        assert!(values_of(&a, "domain").is_empty());
        assert_eq!(a.read_property_def("domain").unwrap(), None);
    }

    /// A rewrite's writes land in one commit, and a write to a block the doc
    /// no longer holds is dropped rather than giving it a property map.
    #[test]
    fn a_rewrite_writes_values_and_skips_a_purged_block() {
        let mut e = holding_project("dev-a");
        e.apply_purge_block("B3").expect("purge");
        let value = |v: &str| agaric_store::op::PropertyValueFields {
            value_text: Some(v.into()),
            ..Default::default()
        };
        let write = |id: &str, key: &str, v: Option<&str>| agaric_store::op::PropertyValueWrite {
            block_id: agaric_core::ulid::BlockId::from_trusted(id),
            key: key.into(),
            value: v.map(value),
            prior: None,
        };
        let rewrite = RewritePropertiesPayload {
            space_id: agaric_core::ulid::BlockId::from_trusted("SPACE"),
            reason: agaric_store::op::RewriteReason::Merge,
            defs: Vec::new(),
            values: vec![
                write("B1", "project", None),
                write("B1", "area", Some("p1")),
                write("B3", "area", Some("p3")),
            ],
        };
        e.apply_rewrite_properties(&rewrite).expect("rewrite");
        assert_eq!(values_of(&e, "area"), vec![text("B1", "p1")]);
        assert_eq!(values_of(&e, "project"), vec![text("B2", "p2")]);
        assert!(
            e.doc.get_map(BLOCK_PROPERTIES_ROOT).get("B3").is_none(),
            "the purged block gets no property map"
        );
    }

    #[test]
    fn holders_are_the_blocks_holding_the_key() {
        let mut e = LoroEngine::with_peer_id("dev-a").expect("peer");
        for id in ["B1", "B2", "B3"] {
            e.apply_create_block(id, "content", id, None, 0)
                .expect("create block");
        }
        e.apply_set_property("B1", "due2", Some("2026-11-03"))
            .expect("set");
        e.apply_set_property("B3", "due2", Some("2026-11-04"))
            .expect("set");
        e.apply_set_property("B2", "other", Some("x")).expect("set");
        let mut holders = e.read_property_holders("due2").unwrap();
        holders.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            holders,
            vec![
                ("B1".to_owned(), PropertyValue::Str("2026-11-03".to_owned())),
                ("B3".to_owned(), PropertyValue::Str("2026-11-04".to_owned())),
            ],
            "only the blocks holding the key, with their values"
        );
    }

    /// An engine whose `stage` is a select of `draft, review, done`; `B1`
    /// and `B3` hold `review`, `B2` holds `draft`.
    fn holding_stage() -> LoroEngine {
        let mut e = LoroEngine::with_peer_id("dev-a").expect("peer");
        e.apply_set_property_def(
            "stage",
            Some(&def("select", Some(r#"["draft","review","done"]"#))),
        )
        .expect("declare");
        for (id, value) in [("B1", "review"), ("B2", "draft"), ("B3", "review")] {
            e.apply_create_block(id, "content", id, None, 0)
                .expect("create block");
            e.apply_set_property(id, "stage", Some(value)).expect("set");
        }
        e
    }

    #[test]
    fn an_option_rename_changes_only_the_keys_string_values_and_the_options_in_place() {
        let mut e = holding_stage();
        e.apply_create_block("B4", "content", "B4", None, 0)
            .expect("create block");
        e.put_property("B4", "stage", &PropertyValue::Num(7.0))
            .expect("a number under the key");
        e.apply_set_property("B2", "other", Some("review"))
            .expect("the old name under another key");
        let after = e
            .apply_rename_property_option("stage", "review", "in_review")
            .expect("rename");
        assert_eq!(
            values_of(&e, "stage"),
            vec![
                text("B1", "in_review"),
                text("B2", "draft"),
                text("B3", "in_review"),
                ("B4".to_owned(), PropertyValue::Num(7.0)),
            ],
            "only the key's string values equal to the old name are renamed"
        );
        assert_eq!(
            values_of(&e, "other"),
            vec![text("B2", "review")],
            "another key holding the old name is untouched"
        );
        let renamed = def("select", Some(r#"["draft","in_review","done"]"#));
        assert_eq!(
            after,
            Some(renamed.clone()),
            "the definition after is returned"
        );
        assert_eq!(
            e.read_property_def("stage").unwrap(),
            Some(renamed),
            "the option is replaced in place, the order kept"
        );
    }

    #[test]
    fn a_second_option_rename_apply_records_no_op() {
        let mut e = holding_stage();
        e.apply_rename_property_option("stage", "review", "in_review")
            .expect("rename");
        let before = e.doc.oplog_frontiers();
        e.apply_rename_property_option("stage", "review", "in_review")
            .expect("re-apply");
        assert_eq!(e.doc.oplog_frontiers(), before, "nothing left to rename");
    }

    /// The options are rewritten only when they list the old name and not
    /// the new one: a peer's concurrent edit can leave either.
    #[test]
    fn an_option_rename_leaves_options_without_old_or_with_new_alone() {
        for options in [r#"["draft","done"]"#, r#"["review","in_review"]"#] {
            let mut e = holding_stage();
            e.apply_set_property_def("stage", Some(&def("select", Some(options))))
                .expect("redeclare");
            let after = e
                .apply_rename_property_option("stage", "review", "in_review")
                .expect("rename");
            assert_eq!(
                after,
                Some(def("select", Some(options))),
                "{options} stays as it was"
            );
            assert_eq!(
                values_of(&e, "stage")[0],
                text("B1", "in_review"),
                "the values are renamed all the same"
            );
        }
    }
}
