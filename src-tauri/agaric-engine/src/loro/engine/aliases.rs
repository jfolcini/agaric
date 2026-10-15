//! Page aliases in the engine (#5387): `AddPageAlias` / `RemovePageAlias`
//! and the read the SQL projection is rebuilt from.
//!
//! Under [`PAGE_ALIASES_ROOT`] each page owns a map keyed by
//! [`page_alias_key`], whose value is the alias as written. Keying by the
//! folded alias makes two spellings of one alias unrepresentable on a page, so
//! concurrent edits merge alias by alias. The per-page map is a mergeable
//! child (`ensure_mergeable_map`): two devices that each give a page its first
//! alias create the same container, so neither device's entries are hidden by
//! the other's.

use super::*;

/// The key an alias is filed under: trimmed and ASCII-lowercased, the fold
/// `page_aliases.alias COLLATE NOCASE` compares with.
pub fn page_alias_key(alias: &str) -> String {
    alias.trim().to_ascii_lowercase()
}

impl LoroEngine {
    /// Mirrors `AddPageAlias`: files the trimmed `alias` under its key in
    /// `page_id`'s alias map, replacing the spelling held there. Re-adding the
    /// same spelling records no op.
    pub fn apply_add_page_alias(&mut self, page_id: &str, alias: &str) -> Result<(), AppError> {
        let alias = alias.trim();
        if alias.is_empty() {
            return Err(AppError::validation(format!(
                "loro: add_page_alias page {page_id}: alias is empty"
            )));
        }
        let page_map = self
            .doc
            .get_map(PAGE_ALIASES_ROOT)
            .ensure_mergeable_map(page_id)
            .map_err(|e| {
                AppError::validation(format!("loro: add_page_alias page {page_id}: {e}"))
            })?;
        page_map
            .insert(&page_alias_key(alias), LoroValue::from(alias))
            .map_err(|e| {
                AppError::validation(format!(
                    "loro: add_page_alias page {page_id} alias {alias}: {e}"
                ))
            })?;
        self.doc.commit();
        Ok(())
    }

    /// Mirrors `RemovePageAlias`: drops whatever spelling `page_id` holds
    /// under `alias`'s key. A no-op when it holds none.
    pub fn apply_remove_page_alias(&mut self, page_id: &str, alias: &str) -> Result<(), AppError> {
        let Some(page_map) = self.page_alias_map(page_id)? else {
            return Ok(());
        };
        let key = page_alias_key(alias);
        if page_map.get(&key).is_none() {
            return Ok(());
        }
        page_map.delete(&key).map_err(|e| {
            AppError::validation(format!(
                "loro: remove_page_alias page {page_id} alias {alias}: {e}"
            ))
        })?;
        self.doc.commit();
        Ok(())
    }

    /// `page_id`'s aliases as written, in key order; `None` when the page has
    /// never held one in the engine, so a reprojection leaves alone the SQL
    /// rows the boot backfill has not reached yet.
    pub fn read_page_aliases(&self, page_id: &str) -> Result<Option<Vec<String>>, AppError> {
        let Some(page_map) = self.page_alias_map(page_id)? else {
            return Ok(None);
        };
        let mut aliases = Vec::new();
        let mut err = None;
        page_map.for_each(|key, voc| match voc.into_value() {
            Ok(LoroValue::String(s)) => aliases.push((*s).clone()),
            other => {
                err.get_or_insert_with(|| {
                    AppError::validation(format!(
                        "loro: read_page_aliases page {page_id} key {key}: \
                         expected a string, got {other:?}"
                    ))
                });
            }
        });
        err.map_or(Ok(Some(aliases)), Err)
    }

    /// The alias map `page_id` holds, if any.
    fn page_alias_map(&self, page_id: &str) -> Result<Option<LoroMap>, AppError> {
        let Some(voc) = self.doc.get_map(PAGE_ALIASES_ROOT).get(page_id) else {
            return Ok(None);
        };
        voc.into_container()
            .ok()
            .and_then(|c| c.into_map().ok())
            .map(Some)
            .ok_or_else(|| {
                AppError::validation(format!(
                    "loro: page {page_id}'s alias slot is not a LoroMap"
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::LoroEngine;

    const PAGE: &str = "01HZ0000000000000000000P01";

    fn peer(device: &str) -> LoroEngine {
        let mut engine = LoroEngine::with_peer_id(device).expect("peer");
        engine
            .apply_create_block(PAGE, "page", "Planning", None, 0)
            .expect("create page");
        engine
    }

    fn merge_both_ways(a: &mut LoroEngine, b: &mut LoroEngine) {
        let a_bytes = a.export_snapshot().expect("export a");
        let b_bytes = b.export_snapshot().expect("export b");
        a.import(&b_bytes).expect("a imports b");
        b.import(&a_bytes).expect("b imports a");
    }

    #[test]
    fn add_files_one_entry_per_folded_key_and_remove_drops_it() {
        let mut e = peer("dev-a");
        e.apply_add_page_alias(PAGE, "  Plans ").expect("add");
        e.apply_add_page_alias(PAGE, "roadmap").expect("add");
        e.apply_add_page_alias(PAGE, "PLANS").expect("respell");
        assert_eq!(
            e.read_page_aliases(PAGE).unwrap().unwrap(),
            vec!["PLANS".to_owned(), "roadmap".to_owned()],
            "a second spelling of an alias replaces the first, trimmed"
        );
        e.apply_remove_page_alias(PAGE, "plans").expect("remove");
        e.apply_remove_page_alias(PAGE, "absent")
            .expect("remove absent");
        assert_eq!(
            e.read_page_aliases(PAGE).unwrap().unwrap(),
            vec!["roadmap".to_owned()],
            "remove drops the entry under the folded key and ignores an absent one"
        );
    }

    #[test]
    fn add_refuses_an_alias_that_trims_to_nothing() {
        let mut e = peer("dev-a");
        let err = e.apply_add_page_alias(PAGE, "   ").unwrap_err();
        assert!(
            matches!(err, agaric_core::error::AppError::Validation { .. }),
            "an empty alias is a validation error, got {err:?}"
        );
        assert_eq!(e.read_page_aliases(PAGE).unwrap(), None, "nothing filed");
    }

    #[test]
    fn concurrent_first_adds_of_one_alias_merge_to_one_entry() {
        let mut a = peer("dev-a");
        let mut b = LoroEngine::with_peer_id("dev-b").expect("peer b");
        b.import(&a.export_snapshot().unwrap())
            .expect("share the page");
        a.apply_add_page_alias(PAGE, "plans").expect("a adds");
        b.apply_add_page_alias(PAGE, "Plans").expect("b adds");
        b.apply_add_page_alias(PAGE, "roadmap")
            .expect("b adds another");
        merge_both_ways(&mut a, &mut b);
        let on_a = a.read_page_aliases(PAGE).unwrap().unwrap();
        assert_eq!(
            Some(&on_a),
            b.read_page_aliases(PAGE).unwrap().as_ref(),
            "peers converge"
        );
        assert_eq!(
            on_a.len(),
            2,
            "one entry for `plans`, and b's `roadmap` survives"
        );
        assert!(
            on_a.contains(&"roadmap".to_owned()),
            "the second first-add is not hidden"
        );
    }

    #[test]
    fn purge_drops_the_page_alias_map() {
        let mut e = peer("dev-a");
        e.apply_add_page_alias(PAGE, "plans").expect("add");
        e.apply_purge_block(PAGE).expect("purge");
        assert_eq!(
            e.read_page_aliases(PAGE).unwrap(),
            None,
            "a purged page keeps no aliases in the doc"
        );
    }
}
