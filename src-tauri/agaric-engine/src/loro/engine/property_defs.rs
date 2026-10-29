//! Property definitions in the engine (#5841): `SetPropertyDef` and the reads
//! the SQL `property_definitions` projection is rebuilt from.
//!
//! Under [`PROPERTY_DEFINITIONS_ROOT`] each key the space declares holds one
//! plain map value `{value_type, options}`, never a container: two devices
//! that declare one key concurrently write the same slot, and Loro's per-key
//! last-writer-wins keeps one whole definition rather than orphaning the
//! entries of a losing container.

use agaric_store::op::PropertyDefState;

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

impl LoroEngine {
    /// Mirrors `SetPropertyDef`: files `def` under `key`, or drops the key on
    /// `None`. Writing what the root already holds records no op.
    pub fn apply_set_property_def(
        &mut self,
        key: &str,
        def: Option<&PropertyDefState>,
    ) -> Result<(), AppError> {
        let root = self.doc.get_map(PROPERTY_DEFINITIONS_ROOT);
        let held = root.get(key).and_then(|voc| voc.into_value().ok());
        let wanted = def.map(def_to_loro);
        if held == wanted {
            return Ok(());
        }
        match wanted {
            Some(value) => root.insert(key, value),
            None => root.delete(key),
        }
        .map_err(|e| AppError::validation(format!("loro: set_property_def {key}: {e}")))?;
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
}
