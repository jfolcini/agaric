//! Snapshot import/export I/O for [`LoroEngine`].
//!
//! `export_snapshot` / `import` / `import_with_changed_blocks`, the cheap
//! `doc_handle` clone, and the legacy-v1 (flat-map) rejection (#332).

use super::*;

impl LoroEngine {
    /// A reference-clone of the engine's underlying `LoroDoc`.
    ///
    /// Loro's `LoroDoc::clone` is a *handle* clone — the cloned doc shares
    /// the same underlying document (see the loro 1.12 `impl Clone for
    /// LoroDoc` doc-comment), so this is O(1) and does NOT deep-copy the
    /// document state. Issue #153: the periodic-snapshot scheduler uses
    /// this to collect cheap handles under the registry mutex, drop the
    /// lock, then run the (comparatively slow) snapshot
    /// [`export`](loro::LoroDoc::export) outside the lock — so the engine
    /// mutex is held only for the O(1) handle clone, not for every
    /// per-space serialization.
    pub fn doc_handle(&self) -> LoroDoc {
        self.doc.clone()
    }
    /// Export the doc as a self-contained snapshot byte string.
    /// Phase 1 wires this into the `loro_batch` op-log payload (item
    /// 4 on the SPIKE-REPORT.md readiness checklist).
    ///
    /// #1584: stamps the current [`ENGINE_FORMAT_VERSION`] into
    /// [`ENGINE_META_ROOT`] before serializing so a later [`Self::import`] can
    /// positively assert the doc's shape instead of trusting arbitrary bytes.
    pub fn export_snapshot(&self) -> Result<Vec<u8>, AppError> {
        self.stamp_format_version();
        self.doc
            .export(ExportMode::Snapshot)
            .map_err(|e| AppError::Validation(format!("loro: export snapshot: {e}")))
    }
    /// Stamp the current [`ENGINE_FORMAT_VERSION`] into [`ENGINE_META_ROOT`]
    /// under [`FIELD_FORMAT_VERSION`] (#1584).
    ///
    /// Idempotent: only writes when the recorded version differs, so it adds at
    /// most one op per doc (mirrors [`Self::mark_sibling_order_current`]). The
    /// constant is a `u32` but Loro scalars are `i64`, so it is stored widened.
    pub(super) fn stamp_format_version(&self) {
        let meta: LoroMap = self.doc.get_map(ENGINE_META_ROOT);
        if Self::read_format_version(&meta) == Some(ENGINE_FORMAT_VERSION as i64) {
            return;
        }
        if let Err(e) = meta.insert(
            FIELD_FORMAT_VERSION,
            LoroValue::from(ENGINE_FORMAT_VERSION as i64),
        ) {
            tracing::warn!(error = %e, "failed to stamp engine format_version marker");
        }
    }
    /// Read the raw stamped [`FIELD_FORMAT_VERSION`] from an [`ENGINE_META_ROOT`]
    /// map. `None` distinguishes *absent* (legacy-unstamped, pre-#1584) from a
    /// *present* value so the import gate can treat the two differently. A
    /// present-but-non-`I64` value yields `Some(_)` only when it parses; the
    /// caller's gate rejects the non-integer case explicitly.
    fn read_format_version(meta: &LoroMap) -> Option<i64> {
        match meta.get(FIELD_FORMAT_VERSION)?.into_value() {
            Ok(LoroValue::I64(n)) => Some(n),
            _ => Some(i64::MIN), // present but unparseable → sentinel the gate rejects
        }
    }
    /// Reject an import whose stamped engine format version is newer than this
    /// build supports, or present but not a valid integer (#1584).
    ///
    /// Backward-compat reasoning for the **absent** case: every export produced
    /// before #1584 carries NO `format_version` stamp, yet those are perfectly
    /// valid v2 docs, and peers running an older build still produce unstamped
    /// snapshots we must round-trip with. So a *missing* stamp must NOT reject —
    /// it is treated as "legacy-unstamped, accept". The genuinely-old v1 case is
    /// already caught by [`Self::reject_legacy_v1_snapshot`]; this gate adds the
    /// forward guard (a future/unknown stamp) that the v1 check cannot express.
    ///
    /// * stamp == [`ENGINE_FORMAT_VERSION`] → ok.
    /// * stamp absent → ok (legacy-unstamped; see above).
    /// * stamp > [`ENGINE_FORMAT_VERSION`] → reject (newer than supported).
    /// * stamp present but not a valid `i64`, or `< 0` → reject (corrupt/unknown).
    pub(super) fn reject_unknown_format_version(&self) -> Result<(), AppError> {
        let meta: LoroMap = self.doc.get_map(ENGINE_META_ROOT);
        let Some(v) = Self::read_format_version(&meta) else {
            return Ok(()); // absent ⇒ legacy-unstamped, accept
        };
        let supported = i64::from(ENGINE_FORMAT_VERSION);
        if v == supported {
            return Ok(());
        }
        if v < 0 {
            return Err(AppError::Validation(format!(
                "loro: import: engine `{FIELD_FORMAT_VERSION}` stamp is present but not a valid \
                 version integer (corrupt or unknown snapshot); refusing to trust these bytes.",
            )));
        }
        if v > supported {
            return Err(AppError::Validation(format!(
                "loro: import: engine format version {v} is newer than this build supports \
                 (max {supported}); upgrade to a build that understands this snapshot.",
            )));
        }
        // v in [0, supported): an older-but-stamped format. v == 1 is the
        // retired flat-map model, which `reject_legacy_v1_snapshot` already
        // catches by structure; any other sub-current value is accepted here and
        // left to the existing structural checks (no historical stamped formats
        // below the current one exist, so this is a defensive no-op today).
        Ok(())
    }
    /// Import bytes previously produced by `export_snapshot` (or any
    /// other Loro export mode) into this doc.
    ///
    /// After importing, rejects any legacy v1 (flat-map) snapshot
    /// (#332 — the v1→v2 migration was retired once all snapshots were on
    /// v2) and rebuilds the `block_id → TreeID` index — the imported bytes
    /// may have created tree nodes the incremental index never saw.
    pub fn import(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| AppError::Validation(format!("loro: import: {e}")))?;
        self.reject_legacy_v1_snapshot()?;
        // #1584: positively gate the stamped engine format version before any
        // index work — a newer-than-supported (or corrupt) stamp is rejected up
        // front instead of trusting the bytes and failing later on projection.
        self.reject_unknown_format_version()?;
        self.rebuild_index();
        // A pre-#400 snapshot carries sibling order only in the `position`
        // meta; migrate it onto the fractional index exactly once. The guard (a
        // marker-less doc that still carries a legacy `position` meta) keeps
        // this a true "is pre-#400" signal — see the helper.
        //
        // Best-effort: a migration failure must NOT fail import. Propagating it
        // would make `rehydrate_registry` skip the space and the next op mint a
        // fresh EMPTY engine, diverging the CRDT from the populated SQL blocks
        // for the whole space. Log loudly and install the doc UNMIGRATED (tree
        // fractional / creation order); the next successful create/move
        // reprojects the affected sibling group (#400, review).
        self.migrate_legacy_sibling_order_best_effort();
        Ok(())
    }
    /// Import `bytes` into the doc and return every block_id present
    /// in the post-import block-hierarchy LoroTree, in parent-before-child
    /// pre-order so the caller's FK-ordered SQL projection succeeds.
    ///
    /// Sync-pull projection driver. The receiver's caller passes each
    /// returned block_id to
    /// [`crate::loro::projection::project_block_full_to_sql`] so the
    /// SQL `blocks` row mirrors the engine's post-import state.
    ///
    /// ## Why brute-force enumeration (not VersionRange-driven diff)
    ///
    /// Loro 1.12's [`loro::ImportStatus`] reports a
    /// [`loro::VersionRange`] (`success`) — the (peer, counter-range)
    /// span of accepted ops — but does NOT directly map to the set of
    /// block_ids whose state changed.  Translating a counter-range
    /// into changed-container-ids would require either
    /// (a) walking the op-log changes in that range and decoding their
    /// targets, or (b) subscribing to root-level diff events for the
    /// duration of the import.  Both add complexity for the day-4
    /// additive landing; the day-5 wiring or later can swap to a
    /// targeted enumeration once a benchmark shows the brute-force
    /// projection is on a hot path.
    ///
    /// The brute-force walk costs O(N_blocks) per sync-pull — same
    /// asymptotic shape as `count_alive_blocks` / `list_children_walk`
    /// — but sync-pull is a cold path bounded by the op-streaming
    /// cadence, so the cost is amortised against network latency.
    ///
    /// ## Edge cases
    ///
    /// * Soft-deleted blocks (those whose `deleted_at` slot is set)
    ///   ARE included in the returned vector — the projection helper
    ///   refreshes their core columns (content/parent/position) without
    ///   touching the SQL `deleted_at`, so the block stays soft-deleted.
    /// * If the import added zero new ops (peer was up-to-date), the
    ///   walk still returns every block_id — the projection helper
    ///   becomes a sequence of idempotent core-column UPSERTs, which
    ///   is correct but wasteful. A future iteration may short-circuit
    ///   on `ImportStatus.success.is_empty()` to skip the walk.
    pub fn import_with_changed_blocks(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<crate::ulid::BlockId>, AppError> {
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| AppError::Validation(format!("loro: import_with_changed_blocks: {e}")))?;
        self.reject_legacy_v1_snapshot()?;
        // #1584: same forward-version gate as `import` (see there) on the
        // sync-pull path — reject an unknown/newer stamp before projection.
        self.reject_unknown_format_version()?;
        self.rebuild_index();
        // Mirror `import`'s one-time legacy sibling-order migration so a pre-#400
        // doc arriving over the sync-pull path (not just a local snapshot) is
        // also reordered onto the fractional index before projection (#400).
        // Best-effort for the same reason as `import` — a migration error must
        // not abort the sync-pull and drop the space's engine.
        self.migrate_legacy_sibling_order_best_effort();

        // Enumerate every live block_id **parent-before-child** (pre-order
        // DFS from the tree roots) so the caller's Pass-A projection inserts
        // a parent's SQL row before any child's — the `blocks.parent_id`
        // self-FK rejects the reverse order. Soft-deleted nodes are
        // included (still live in the tree; the projection refreshes their
        // core columns without touching SQL `deleted_at`); hard-purged
        // nodes are absent from `children`/`roots` and so excluded.
        let tree = self.tree();
        let mut out: Vec<crate::ulid::BlockId> = Vec::with_capacity(self.index.len());
        let mut stack: Vec<TreeID> = tree.roots();
        // `roots()` is unordered; reverse so pre-order emits roots in a
        // stable forward order (cosmetic — FK-correctness only needs
        // parent-before-child, which the DFS guarantees regardless).
        stack.reverse();
        while let Some(node) = stack.pop() {
            if let Ok(meta) = tree.get_meta(node)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
            {
                out.push(crate::ulid::BlockId::from_trusted(&bid));
            }
            if let Some(mut children) = tree.children(TreeParentId::Node(node)) {
                children.reverse();
                stack.extend(children);
            }
        }
        Ok(out)
    }
    /// Reject a legacy v1 (flat-map) snapshot loudly (#332).
    ///
    /// PEND-80 Phase 3 (#331) moved the block hierarchy from a flat
    /// [`LEGACY_BLOCKS_ROOT`] `LoroMap` (format 1) to the [`BLOCKS_TREE_ROOT`]
    /// [`LoroTree`] (format 2), migrating old snapshots forward on every
    /// import. #332 retired that migration once every persisted snapshot had
    /// been re-saved as v2. A v2 doc never carries a non-empty legacy `blocks`
    /// map, so a non-empty one means a stray v1 snapshot — fail loudly with a
    /// clear error rather than silently producing an empty tree (downgrade to a
    /// pre-#332 build to migrate the data forward first).
    pub(super) fn reject_legacy_v1_snapshot(&self) -> Result<(), AppError> {
        let legacy: LoroMap = self.doc.get_map(LEGACY_BLOCKS_ROOT);
        if !legacy.is_empty() {
            return Err(AppError::Validation(format!(
                "loro: import: legacy v1 (flat-map) snapshot detected ({} block(s) under \
                 the deprecated `{}` root). The v1->v2 migration was removed in #332; open \
                 this data with a pre-#332 build first to migrate it forward.",
                legacy.len(),
                LEGACY_BLOCKS_ROOT,
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod format_version_tests {
    use super::*;

    /// (a) Round-trip: export stamps the current format version and import of
    /// that snapshot succeeds, with the stamp present in the receiving doc.
    #[test]
    fn export_stamps_and_import_round_trips() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("x", "content", "X", None, 0).unwrap();
        let bytes = a.export_snapshot().unwrap();

        // The exporting doc itself now carries the stamp.
        let meta_a: LoroMap = a.doc.get_map(ENGINE_META_ROOT);
        assert_eq!(
            LoroEngine::read_format_version(&meta_a),
            Some(i64::from(ENGINE_FORMAT_VERSION)),
            "export must stamp the current format version",
        );

        let mut b = LoroEngine::new();
        b.import(&bytes).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 1);
        let meta_b: LoroMap = b.doc.get_map(ENGINE_META_ROOT);
        assert_eq!(
            LoroEngine::read_format_version(&meta_b),
            Some(i64::from(ENGINE_FORMAT_VERSION)),
            "imported doc must carry the round-tripped stamp",
        );
    }

    /// (b) A doc stamped with a version GREATER than the supported one is
    /// rejected with a clear "newer than this build supports" error.
    #[test]
    fn import_rejects_newer_format_version() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("x", "content", "X", None, 0).unwrap();
        // Overwrite the stamp with a future version, then export those bytes.
        let meta: LoroMap = a.doc.get_map(ENGINE_META_ROOT);
        meta.insert(
            FIELD_FORMAT_VERSION,
            LoroValue::from(i64::from(ENGINE_FORMAT_VERSION) + 1),
        )
        .unwrap();
        a.doc.commit();
        let bytes = a.doc.export(ExportMode::Snapshot).unwrap();

        let mut b = LoroEngine::new();
        match b.import(&bytes).unwrap_err() {
            AppError::Validation(m) => assert!(
                m.contains("newer than this build supports"),
                "expected a newer-version rejection, got: {m}",
            ),
            other => panic!("expected Validation error, got {other:?}"),
        }
    }

    /// (b') A present-but-non-integer stamp is rejected as corrupt/unknown.
    #[test]
    fn import_rejects_non_integer_format_version() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("x", "content", "X", None, 0).unwrap();
        let meta: LoroMap = a.doc.get_map(ENGINE_META_ROOT);
        meta.insert(FIELD_FORMAT_VERSION, LoroValue::from("not-a-version"))
            .unwrap();
        a.doc.commit();
        let bytes = a.doc.export(ExportMode::Snapshot).unwrap();

        let mut b = LoroEngine::new();
        match b.import(&bytes).unwrap_err() {
            AppError::Validation(m) => assert!(
                m.contains("not a valid version integer"),
                "expected a corrupt-stamp rejection, got: {m}",
            ),
            other => panic!("expected Validation error, got {other:?}"),
        }
    }

    /// (c) Backward-compat: a doc with NO stamp (simulating a pre-#1584 export)
    /// still imports successfully — a missing stamp must never reject a valid v2
    /// snapshot produced by an older build / peer.
    #[test]
    fn import_accepts_unstamped_legacy_snapshot() {
        // Build a real v2 doc, then delete the stamp before exporting so the
        // bytes look exactly like a pre-#1584 export.
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("x", "content", "X", None, 0).unwrap();
        // export_snapshot stamps; clear it afterwards on the same doc and
        // re-export raw to drop the marker.
        let _ = a.export_snapshot().unwrap();
        let meta: LoroMap = a.doc.get_map(ENGINE_META_ROOT);
        meta.delete(FIELD_FORMAT_VERSION).unwrap();
        a.doc.commit();
        let bytes = a.doc.export(ExportMode::Snapshot).unwrap();

        // Sanity: these bytes carry no stamp.
        let probe = LoroDoc::new();
        probe.import(&bytes).unwrap();
        let probe_meta: LoroMap = probe.get_map(ENGINE_META_ROOT);
        assert_eq!(
            LoroEngine::read_format_version(&probe_meta),
            None,
            "test fixture must be unstamped to exercise the legacy path",
        );

        let mut b = LoroEngine::new();
        b.import(&bytes).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 1);
    }
}
