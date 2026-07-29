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
    /// document state. Issue #153 (+ #2205): the periodic-snapshot
    /// scheduler uses this to collect a cheap handle under the per-space
    /// engine mutex, drop the lock, then run the (comparatively slow)
    /// snapshot [`export`](loro::LoroDoc::export) outside the lock — so
    /// the engine mutex is held only for the O(1) handle clone, not for
    /// every per-space serialization.
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
            .map_err(|e| AppError::validation(format!("loro: export snapshot: {e}")))
    }
    /// Stamp the current [`ENGINE_FORMAT_VERSION`] into [`ENGINE_META_ROOT`]
    /// under [`FIELD_FORMAT_VERSION`] (#1584).
    ///
    /// Idempotent: only writes when the recorded version differs, so it adds at
    /// most one op per doc (mirrors [`Self::mark_sibling_order_current`]). The
    /// constant is a `u32` but Loro scalars are `i64`, so it is stored widened.
    pub(super) fn stamp_format_version(&self) {
        let meta: LoroMap = self.doc.get_map(ENGINE_META_ROOT);
        if Self::read_format_version(&meta) == Some(i64::from(ENGINE_FORMAT_VERSION)) {
            return;
        }
        if let Err(e) = meta.insert(
            FIELD_FORMAT_VERSION,
            LoroValue::from(i64::from(ENGINE_FORMAT_VERSION)),
        ) {
            tracing::warn!(error = %e, "failed to stamp engine format_version marker");
        }
    }
    /// Read the raw stamped [`FIELD_FORMAT_VERSION`] from an [`ENGINE_META_ROOT`]
    /// map. Tri-state:
    ///
    /// * field absent → `None` (legacy-unstamped, pre-#1584).
    /// * field present and a valid `I64` → `Some(n)` (the stamped version).
    /// * field present but **not** an `I64` → `Some(i64::MIN)`, a negative
    ///   sentinel. (`i64::MIN` is `< 0`, so the caller's gate
    ///   ([`Self::reject_unknown_format_version`]) rejects it via its `v < 0`
    ///   corrupt/unknown branch.)
    ///
    /// `None` distinguishes *absent* (accept as legacy-unstamped) from a
    /// *present* value so the import gate can treat the two differently.
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
            return Err(AppError::validation(format!(
                "loro: import: engine `{FIELD_FORMAT_VERSION}` stamp is present but not a valid \
                 version integer (corrupt or unknown snapshot); refusing to trust these bytes.",
            )));
        }
        if v > supported {
            return Err(AppError::validation(format!(
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
        // #2036: capture pre-import oplog frontiers for the no-op short-circuit
        // below.
        let before_frontiers = self.doc.oplog_frontiers();
        self.doc
            .import(bytes)
            .map(|_status| ())
            .map_err(|e| AppError::validation(format!("loro: import: {e}")))?;
        self.reject_legacy_v1_snapshot()?;
        // #1584: positively gate the stamped engine format version before any
        // index work — a newer-than-supported (or corrupt) stamp is rejected up
        // front instead of trusting the bytes and failing later on projection.
        self.reject_unknown_format_version()?;
        // #2036: no-op short-circuit — if the import appended zero ops (the doc
        // already had everything in `bytes`), the materialised state is
        // unchanged and `self.index` is still current, so the O(N_live)
        // `rebuild_index` + one-time sibling-order migration scan below are pure
        // waste. Frontiers compare equal iff nothing was appended to the oplog.
        if self.doc.oplog_frontiers() == before_frontiers {
            return Ok(());
        }
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
    /// Import `bytes` into the doc and return the block_ids whose
    /// projected state it changed, in parent-before-child order so the
    /// caller's FK-ordered SQL projection succeeds.
    ///
    /// Sync-pull projection driver. The receiver's caller passes each
    /// returned block_id to
    /// [`crate::loro::projection::project_block_full_to_sql`] so the
    /// SQL `blocks` row mirrors the engine's post-import state.
    ///
    /// #2036/#2264: for recognised incremental delta shapes the set is
    /// resolved from a scoped root-level diff subscription active for the
    /// import's duration and is bounded by the delta, NOT the vault; a
    /// snapshot import or an unrecognised diff shape falls back to the
    /// historical full live-tree enumeration. See
    /// [`Self::import_with_changed_purged_tagscope`] (the shared body)
    /// for the resolution rules.
    ///
    /// ## Edge cases
    ///
    /// * Soft-deleted blocks (those whose `deleted_at` slot is set)
    ///   ARE included in the returned vector — the projection helper
    ///   refreshes their core columns (content/parent/position) without
    ///   touching the SQL `deleted_at`, so the block stays soft-deleted.
    /// * If the import added zero new ops (peer was up-to-date), the
    ///   walk is skipped entirely and an empty `(changed, purged)` pair
    ///   is returned (#2036 no-op short-circuit, keyed off the oplog
    ///   frontiers being unchanged across `doc.import`) — a redelivered
    ///   update no longer costs a full reproject.
    pub fn import_with_changed_blocks(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<agaric_core::ulid::BlockId>, AppError> {
        // Thin wrapper over the changed+purged variant — discard the purged
        // delta so existing callers keep their `Vec<BlockId>` contract. The
        // shared body lives in `import_with_changed_and_purged_blocks` so the
        // import/rebuild/DFS logic is not duplicated.
        self.import_with_changed_and_purged_blocks(bytes)
            .map(|(changed, _purged)| changed)
    }

    /// Like [`Self::import_with_changed_blocks`] but ALSO returns the set of
    /// block_ids hard-purged (`PurgeBlock`) by THIS import.
    ///
    /// ## Why a separate purged delta (#2128)
    ///
    /// `import_with_changed_blocks` enumerates only the LIVE tree, so a remote
    /// `PurgeBlock` — which `tree.delete`s the seed and prunes the whole
    /// subtree (seed + descendants) from `self.index` — is INVISIBLE to the
    /// returned changed-blocks vector. The inbound projection loop therefore
    /// never hard-deletes the purged rows from SQL, leaving the block row and
    /// every descendant + derived-cache row behind → silent divergence.
    ///
    /// The purged set is computed as a pure index delta:
    /// `(block ids in `self.index` BEFORE `doc.import`) − (block ids AFTER the
    /// rebuild)`. Because `apply_purge_block` removed the entire subtree from
    /// the index and `rebuild_index()` only re-adds live tree nodes, this
    /// difference is exactly the seed + all descendants purged by this import.
    /// A block that merely moved/changed but stayed live is present in both
    /// snapshots and so is NOT in the delta. The caller projects the changed
    /// (live) set with the A/B/C passes and the purged set with a final
    /// hard-delete pass.
    pub fn import_with_changed_and_purged_blocks(
        &mut self,
        bytes: &[u8],
    ) -> Result<
        (
            Vec<agaric_core::ulid::BlockId>,
            Vec<agaric_core::ulid::BlockId>,
        ),
        AppError,
    > {
        // Thin compatibility wrapper — discard the tag-inheritance scope and
        // the #3162 rank-only hint (dropping the hint just means these callers
        // fully reproject every changed block, exactly as they always have).
        // The shared body lives in `import_with_changed_purged_tagscope`.
        self.import_with_changed_purged_tagscope(bytes)
            .map(|delta| (delta.changed, delta.purged))
    }

    /// Sync-pull import driver returning the changed (live) blocks to reproject,
    /// the hard-purged blocks, AND the [`TagScope`] telling the caller how to
    /// refresh the derived `block_tag_inherited` cache (#2036 stage 2/3).
    ///
    /// ## Incremental fast path vs brute-force fallback
    ///
    /// `doc.import` is subscribed for the duration of the import so the
    /// resulting [`loro::event::DiffEvent`] reveals exactly which containers
    /// changed. Each changed container is mapped back to the block(s) whose
    /// projected SQL state it affects:
    ///
    /// * a node meta-map / content `LoroText` change → that node's block
    ///   (`Index::Node(TreeID)` carried in the diff `path`);
    /// * a `block_properties` / `block_tags` sub-map change → its `block_id`
    ///   (the `Index::Key` in the diff `path`, or the updated keys of a
    ///   root-level map diff);
    /// * a `blocks_tree` structural change (create / move / delete) → the
    ///   moved node PLUS the siblings at the affected parent(s) whose dense
    ///   `position` rank actually shifted, i.e. those from the lowest index the
    ///   diff touched in that parent onwards (`TreeDiffItem.action` carries
    ///   `parent` / `old_parent` and the corresponding `index` / `old_index`;
    ///   see `DiffCapture::affected_parents`). Those siblings are reported
    ///   separately in [`ImportDelta::rank_only`] so the caller can refresh
    ///   just their core columns (#3162).
    ///
    /// Soft-delete / restore need NO special handling: they are meta-map
    /// changes (the seed only), and Pass C of the caller re-derives the SQL
    /// cascade to descendants from the seed. Hard-purge is captured by the
    /// index delta below (and the caller's Pass D removes its derived rows).
    ///
    /// If ANY diff is shaped in a way the resolver does not recognise (an
    /// unknown root/container, an `is_unknown` diff, or — defensively — the
    /// one-time legacy sibling-order migration appending ops after import),
    /// the method FALLS BACK to the historical brute-force enumeration of the
    /// whole live tree and a [`TagScope::Global`] rebuild. Correctness is thus
    /// never worse than the pre-#2036 behaviour; only the recognised (and
    /// overwhelmingly common) shapes take the O(changed) fast path.
    pub fn import_with_changed_purged_tagscope(
        &mut self,
        bytes: &[u8],
    ) -> Result<ImportDelta, AppError> {
        self.import_payload_with_changed_purged_tagscope(ImportPayload::Single(bytes))
    }

    /// #3164 — batched sibling of [`Self::import_with_changed_purged_tagscope`]:
    /// import MANY blobs and return the ONE [`ImportDelta`] describing their
    /// combined effect.
    ///
    /// ## Why this collapses the projection, not just the decode
    ///
    /// `LoroDoc::import_batch` (`loro-internal-1.13.6/src/loro.rs:1397-1488`)
    /// force-detaches the doc for the whole batch (`set_detached(true)` while
    /// holding the txn mutex), runs `_import_with` per blob — which appends to
    /// the `OpLog` ONLY, since a detached doc does not update `DocState` — and
    /// then re-attaches exactly once via `_checkout_to_latest_with_guard`. The
    /// `DiffEvent` this method subscribes to is therefore emitted **once for
    /// the whole batch**, not once per blob, so the resolver below sees a
    /// single union diff and the caller projects a single union set. (The
    /// `bytes.len() == 1` early return at `loro.rs:1402` delegates straight to
    /// `import`, so a one-blob batch is bit-identical to the single path.)
    ///
    /// ## Error shape callers must handle
    ///
    /// `import_batch` is NOT atomic: a per-blob failure is *remembered* and
    /// returned after the re-attach (`loro.rs:1459-1478`), so blobs that
    /// decoded fine have already landed in the oplog and the state. An `Err`
    /// here therefore means "an unknown subset was imported" — callers must
    /// treat it as "project nothing, delete nothing" and retry per blob.
    ///
    /// `import_batch` also SORTS the blobs (by export mode, then descending
    /// change count — `loro.rs:1411-1415`). That is safe: every blob is
    /// appended to the oplog before the single re-attach, and loro buffers a
    /// blob whose deps have not arrived yet in `pending_changes`, so the final
    /// oplog (and hence the union diff) does not depend on the input order.
    pub fn import_batch_with_changed_purged_tagscope(
        &mut self,
        blobs: &[Vec<u8>],
    ) -> Result<ImportDelta, AppError> {
        self.import_payload_with_changed_purged_tagscope(ImportPayload::Batch(blobs))
    }

    /// Shared body of the single- and batch-import drivers. Everything after
    /// the `doc.import*` call is payload-agnostic: the diff capture, the
    /// no-op short-circuit, the legacy-migration fallback and the changed /
    /// purged / tag-scope resolution all read post-import engine state.
    fn import_payload_with_changed_purged_tagscope(
        &mut self,
        payload: ImportPayload<'_>,
    ) -> Result<ImportDelta, AppError> {
        // #2036: capture pre-import oplog frontiers for the no-op short-circuit.
        let before_frontiers = self.doc.oplog_frontiers();

        // Subscribe to the root so the import's diff is captured. The callback
        // only records owned diff metadata (container ids, paths, tree items);
        // block-id resolution happens after the import, against post-import
        // engine state.
        let capture = std::sync::Arc::new(std::sync::Mutex::new(DiffCapture::default()));
        let subscription = {
            let capture = std::sync::Arc::clone(&capture);
            self.doc
                .subscribe_root(std::sync::Arc::new(move |ev: loro::event::DiffEvent| {
                    let mut cap = capture.lock().expect("diff capture mutex poisoned");
                    for cd in &ev.events {
                        classify_import_diff(cd, &mut cap);
                    }
                }))
        };

        let import_result = match payload {
            ImportPayload::Single(bytes) => self.doc.import(bytes).map(|_status| ()),
            // #3164: one detached append per blob, ONE re-attach ⇒ ONE diff
            // event for the whole batch (see the fn docs for the citation).
            ImportPayload::Batch(blobs) => self.doc.import_batch(blobs).map(|_status| ()),
        };
        // Flush so the import diff is delivered to the subscriber, then
        // unsubscribe before any local migration ops below.
        self.doc.commit();
        drop(subscription);
        import_result
            .map_err(|e| AppError::validation(format!("loro: import_with_changed_blocks: {e}")))?;
        self.reject_legacy_v1_snapshot()?;
        // #1584: same forward-version gate as `import` on the sync-pull path.
        self.reject_unknown_format_version()?;

        // #2036: no-op short-circuit — zero ops appended ⇒ state unchanged ⇒
        // nothing to reproject, purge, or re-inherit.
        if self.doc.oplog_frontiers() == before_frontiers {
            return Ok(ImportDelta {
                changed: Vec::new(),
                rank_only: Vec::new(),
                purged: Vec::new(),
                tag_scope: TagScope::Subtrees(Vec::new()),
            });
        }
        let after_import_frontiers = self.doc.oplog_frontiers();

        // One-time legacy sibling-order migration (#400). It operates on the doc
        // tree (not `self.index`), so it is order-independent w.r.t. the rebuild
        // below. If it appended reorder ops, those sibling shifts are NOT in the
        // captured import diff — force the brute-force fallback so they are not
        // missed.
        self.migrate_legacy_sibling_order_best_effort();
        let migrated = self.doc.oplog_frontiers() != after_import_frontiers;

        let cap = std::mem::take(&mut *capture.lock().expect("diff capture mutex poisoned"));

        // #2036 follow-up: `rebuild_index` (an O(N_live) tree meta-walk) and the
        // two index-key clones for the purged delta are needed ONLY when the
        // import changed the tree STRUCTURE (a node created / moved / deleted), or
        // when we are falling back. A content / property / tag edit touches no
        // tree node, so `self.index` is already current and nothing was purged —
        // take the truly-O(changed) fast path and skip all of it.
        if !cap.has_tree_diff && !cap.fallback && !migrated {
            // No tree diff ⇒ `affected_parents` is empty ⇒ `rank_only` is too.
            let (changed, rank_only) = self.resolve_changed_blocks(&cap);
            let tag_scope = TagScope::Subtrees(self.resolve_tag_scope(&cap));
            return Ok(ImportDelta {
                changed,
                rank_only,
                purged: Vec::new(),
                tag_scope,
            });
        }

        // Structural / fallback path: rebuild the index and compute the purged
        // delta (#2128: ids live before the import but gone after the rebuild).
        let before: std::collections::HashSet<String> = self.index.keys().cloned().collect();
        self.rebuild_index();
        let after: std::collections::HashSet<String> = self.index.keys().cloned().collect();
        let purged: Vec<agaric_core::ulid::BlockId> = before
            .difference(&after)
            .map(|s| agaric_core::ulid::BlockId::from_trusted(s))
            .collect();

        if cap.fallback || migrated {
            // Brute-force: reproject the whole live tree + globally rebuild the
            // inherited-tag cache. Identical to the pre-#2036 behaviour. No
            // rank-only hint here — the fallback exists precisely because we
            // could not resolve WHAT changed, so every block gets the full
            // projection.
            return Ok(ImportDelta {
                changed: self.enumerate_live_preorder(),
                rank_only: Vec::new(),
                purged,
                tag_scope: TagScope::Global,
            });
        }

        // Recognised structural change (create / move / delete): resolve the
        // precise changed set (incl. the siblings whose rank actually shifted)
        // + scoped tag inheritance.
        let (changed, rank_only) = self.resolve_changed_blocks(&cap);
        let tag_scope = TagScope::Subtrees(self.resolve_tag_scope(&cap));
        Ok(ImportDelta {
            changed,
            rank_only,
            purged,
            tag_scope,
        })
    }

    /// Full live-tree enumeration in parent-before-child pre-order, exposed
    /// for the #535 recovery-replay projection fallback (#2264 review): when
    /// a write-ahead inbox slot's bytes are re-imported into a doc that
    /// ALREADY holds every op (`loro_doc_state` was persisted ahead of the
    /// crashed SQL projection), the import diff is empty and says nothing
    /// about SQL state — the caller reprojects this full set instead of
    /// trusting the no-op.
    pub fn live_blocks_preorder(&self) -> Vec<agaric_core::ulid::BlockId> {
        self.enumerate_live_preorder()
    }

    /// Brute-force enumeration of every live block_id in parent-before-child
    /// pre-order (the historical sync-pull projection driver; also the #2036
    /// fast-path fallback). The FK-ordered caller relies on a parent's row
    /// being projected before any child's.
    fn enumerate_live_preorder(&self) -> Vec<agaric_core::ulid::BlockId> {
        let tree = self.tree();
        let mut out: Vec<agaric_core::ulid::BlockId> = Vec::with_capacity(self.index.len());
        let mut stack: Vec<TreeID> = tree.roots();
        stack.reverse();
        while let Some(node) = stack.pop() {
            if let Ok(meta) = tree.get_meta(node)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
            {
                out.push(agaric_core::ulid::BlockId::from_trusted(&bid));
            }
            if let Some(mut children) = tree.children(TreeParentId::Node(node)) {
                children.reverse();
                stack.extend(children);
            }
        }
        out
    }

    /// Resolve a [`DiffCapture`] into the precise set of LIVE blocks to
    /// reproject, ordered parent-before-child (by tree depth, so a created
    /// parent is projected before its created child — the caller's `parent_id`
    /// self-FK demands it). Purged ids are excluded (handled by the purged
    /// delta + caller Pass D).
    ///
    /// Returns `(changed, rank_only)`. `rank_only` is a strict SUBSET of
    /// `changed` listing the blocks that are in the set ONLY because a sibling
    /// rank shift moved their dense `position` — nothing else about them
    /// changed in this import (#3162). See [`ImportDelta`] for the contract.
    fn resolve_changed_blocks(
        &self,
        cap: &DiffCapture,
    ) -> (
        Vec<agaric_core::ulid::BlockId>,
        Vec<agaric_core::ulid::BlockId>,
    ) {
        let tree = self.tree();
        let mut set: std::collections::HashSet<String> = cap.block_id_keys.clone();
        for tid in &cap.node_ids {
            if let Ok(meta) = tree.get_meta(*tid)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
            {
                set.insert(bid);
            }
        }
        // Blocks this import touched for a reason OTHER than a sibling rank
        // shift: a property / tag / content / meta edit (gathered above) or a
        // structural create / move / delete (`struct_roots`, the diff items'
        // own targets). These ALWAYS need the full projection and must never be
        // demoted to the rank-only path. Adding `struct_roots` to `set` too is
        // belt-and-braces: a created / moved node is always a child of its
        // affected parent at an index >= that parent's minimum, so the sibling
        // walk below would reach it anyway — but relying on that is a needless
        // load-bearing subtlety in the one place where a miss means silent
        // CRDT-vs-SQL divergence.
        let mut full: std::collections::HashSet<String> = set.clone();
        for tid in &cap.struct_roots {
            if let Ok(meta) = tree.get_meta(*tid)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
            {
                full.insert(bid.clone());
                set.insert(bid);
            }
        }
        // Sibling rank shifts (#3162): ONLY the children from the lowest index
        // this import touched in that parent onwards can have a different dense
        // rank — see `DiffCapture::affected_parents` for the proof. An append
        // (the common inbound shape) starts at the end and touches none.
        let mut rank_only: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (parent, lowest) in &cap.affected_parents {
            let Some(children) = tree.children(*parent) else {
                continue;
            };
            for c in children.iter().skip(*lowest) {
                if let Ok(meta) = tree.get_meta(*c)
                    && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
                {
                    if !full.contains(&bid) {
                        rank_only.insert(bid.clone());
                    }
                    set.insert(bid);
                }
            }
        }
        // Live blocks only (a purged/deleted-from-tree id that surfaced via a
        // root-map key removal is dropped here; the purged delta covers it).
        set.retain(|b| self.index.contains_key(b));
        rank_only.retain(|b| self.index.contains_key(b));

        let mut ranked: Vec<(usize, String)> = set
            .into_iter()
            .map(|b| (self.tree_depth_of(&b, &tree), b))
            .collect();
        ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let changed = ranked
            .into_iter()
            .map(|(_, b)| agaric_core::ulid::BlockId::from_trusted(&b))
            .collect();

        let mut rank_only: Vec<String> = rank_only.into_iter().collect();
        rank_only.sort_unstable();
        let rank_only = rank_only
            .iter()
            .map(|b| agaric_core::ulid::BlockId::from_trusted(b))
            .collect();
        (changed, rank_only)
    }

    /// Resolve the subtree roots whose inherited-tag rows may have shifted:
    /// blocks whose direct tags changed, and structurally created/moved nodes
    /// (their subtree re-inherits a new ancestor chain). Deduplicated to the
    /// TOP-MOST roots so a snapshot-shaped import recomputes each tree once
    /// rather than once per node.
    fn resolve_tag_scope(&self, cap: &DiffCapture) -> Vec<agaric_core::ulid::BlockId> {
        let tree = self.tree();
        let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
        for b in &cap.tag_changed {
            if self.index.contains_key(b) {
                set.insert(b.clone());
            }
        }
        for tid in &cap.struct_roots {
            if let Ok(meta) = tree.get_meta(*tid)
                && let Ok(bid) = read_string(&meta, FIELD_BLOCK_ID)
                && self.index.contains_key(&bid)
            {
                set.insert(bid);
            }
        }
        // Drop any root that is a descendant of another root in the set — its
        // subtree recompute is already covered by the ancestor's.
        let owned: Vec<String> = set.iter().cloned().collect();
        owned
            .into_iter()
            .filter(|b| !self.has_ancestor_in(b, &set, &tree))
            .map(|b| agaric_core::ulid::BlockId::from_trusted(&b))
            .collect()
    }

    /// Number of `Node` ancestors of `block_id` (root depth = 0).
    fn tree_depth_of(&self, block_id: &str, tree: &LoroTree) -> usize {
        let Some(&node) = self.index.get(block_id) else {
            return 0;
        };
        let mut depth = 0usize;
        let mut cur = node;
        while let Some(TreeParentId::Node(p)) = tree.parent(cur) {
            depth += 1;
            cur = p;
            // Defensive bound against a pathological cycle (the tree is
            // convergent/cycle-safe, so this never trips in practice).
            if depth > 1_000_000 {
                break;
            }
        }
        depth
    }

    /// Whether any strict ancestor of `block_id` is present in `set`.
    fn has_ancestor_in(
        &self,
        block_id: &str,
        set: &std::collections::HashSet<String>,
        tree: &LoroTree,
    ) -> bool {
        let Some(&node) = self.index.get(block_id) else {
            return false;
        };
        let mut cur = node;
        let mut guard = 0usize;
        while let Some(TreeParentId::Node(p)) = tree.parent(cur) {
            if let Ok(meta) = tree.get_meta(p)
                && let Ok(pb) = read_string(&meta, FIELD_BLOCK_ID)
                && set.contains(&pb)
            {
                return true;
            }
            cur = p;
            guard += 1;
            if guard > 1_000_000 {
                break;
            }
        }
        false
    }
    /// Reject a legacy v1 (flat-map) snapshot loudly (#332).
    ///
    /// Phase 3 (#331) moved the block hierarchy from a flat
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
            return Err(AppError::validation(format!(
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

/// #3164 — what to feed the shared import driver: one blob, or a batch that
/// must be imported as a single diff-producing unit.
///
/// Exists so the single- and batch-import entry points share one body (and
/// therefore one set of no-op / migration / resolver invariants) instead of
/// forking a second copy of the ~100-line resolution flow.
#[derive(Debug, Clone, Copy)]
pub enum ImportPayload<'a> {
    /// A single inbound blob — the live `apply_remote` shape.
    Single(&'a [u8]),
    /// Many blobs imported via `LoroDoc::import_batch`, yielding ONE diff.
    Batch(&'a [Vec<u8>]),
}

/// What an incremental import changed, as resolved from the Loro import diff.
///
/// `changed` keeps its historical meaning exactly: every LIVE block whose
/// projected SQL state this import may have altered, ordered
/// parent-before-child for the caller's `parent_id` self-FK.
///
/// `rank_only` is a strict SUBSET of `changed` carrying an optimisation HINT
/// (#3162): for those blocks the ONLY projected column that can differ is the
/// dense sibling `position` — they are in the set solely because a create /
/// move / delete elsewhere in their sibling group shifted their rank, and the
/// import carried no property, tag, content, structural or soft-delete change
/// for them (the resolver excludes anything it saw through another channel).
/// A consumer may therefore project just their core columns and skip the
/// property / tag / soft-delete passes.
///
/// The hint is safe by construction: it can only ever REMOVE work for blocks
/// already in `changed`, never remove a block from `changed`. A consumer that
/// ignores `rank_only` entirely and fully reprojects everything in `changed`
/// is exactly as correct as pre-#3162 — which is what
/// [`LoroEngine::import_with_changed_and_purged_blocks`] does.
#[derive(Debug)]
pub struct ImportDelta {
    /// Live blocks to reproject, parent-before-child. Superset of `rank_only`.
    pub changed: Vec<agaric_core::ulid::BlockId>,
    /// Subset of `changed` whose only altered projected column is `position`.
    pub rank_only: Vec<agaric_core::ulid::BlockId>,
    /// Blocks hard-purged by this import (caller's Pass D).
    pub purged: Vec<agaric_core::ulid::BlockId>,
    /// How to refresh the derived inherited-tag cache.
    pub tag_scope: TagScope,
}

/// How the caller must refresh the derived `block_tag_inherited` cache after an
/// import (#2036 stage 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagScope {
    /// Recompute inherited-tag rows only for these subtree roots' subtrees
    /// (top-most roots; deduped). An empty vector means nothing to recompute.
    Subtrees(Vec<agaric_core::ulid::BlockId>),
    /// The import could not be resolved incrementally — rebuild the whole
    /// inherited-tag cache.
    Global,
}

/// Owned, post-import-resolvable summary of a Loro import diff, accumulated by
/// [`classify_import_diff`] inside the `subscribe_root` callback (#2036).
#[derive(Default)]
struct DiffCapture {
    /// Any diff whose shape the resolver does not recognise sets this, forcing
    /// the brute-force fallback.
    fallback: bool,
    /// Tree nodes whose meta-map / content changed (from `Index::Node` in the
    /// diff path) — resolved to block_ids after import.
    node_ids: std::collections::HashSet<TreeID>,
    /// Block ids touched via the `block_properties` / `block_tags` roots.
    block_id_keys: std::collections::HashSet<String>,
    /// Subset of `block_id_keys` whose `block_tags` changed (drives tag scope).
    tag_changed: std::collections::HashSet<String>,
    /// Structurally created/moved nodes (drive tag-inheritance subtree roots).
    struct_roots: std::collections::HashSet<TreeID>,
    /// Parents whose child sibling-group ranks shifted (create/move/delete),
    /// each mapped to the LOWEST child index this import touched in that
    /// parent (#3162).
    ///
    /// Loro emits the tree diff as an ORDERED sequence of items, each carrying
    /// the index it acts at *in the state at the moment that item is applied*
    /// (`TreeExternalDiff::Create`/`Move` carry the post-op `index`;
    /// `Move`/`Delete` carry the pre-op `old_index`). An insertion at index `i`
    /// shifts only the children at index >= `i`; a removal at index `i` shifts
    /// only the children after `i`. Neither touches the prefix `[0, i)`.
    ///
    /// So with `m` = the minimum recorded index for a parent, EVERY item for
    /// that parent acts at an index >= `m`, and the prefix `[0, m)` of that
    /// parent's children is element-for-element identical before and after the
    /// import — those siblings' dense ranks provably did not move. Only
    /// `children[m..]` need reprojecting.
    ///
    /// Pre-#3162 this was a bare `Vec<TreeParentId>` and the resolver expanded
    /// it to EVERY child, so an inbound create/move at `TreeParentId::Root`
    /// reprojected the entire root sibling group — O(root children) per import,
    /// O(n^2) over a replay walk. An append (the common inbound shape) now
    /// touches no siblings at all.
    affected_parents: std::collections::HashMap<TreeParentId, usize>,
    /// Whether the import carried any `blocks_tree` structural (`Diff::Tree`)
    /// change — i.e. a node was created, moved, or deleted. When false, the
    /// `block_id → TreeID` index is unchanged (content/property/tag edits touch
    /// no tree nodes), so the O(N_live) `rebuild_index` + purged-delta clones can
    /// be skipped entirely (#2036 follow-up).
    has_tree_diff: bool,
}

/// Classify a single [`loro::event::ContainerDiff`] from an import into
/// [`DiffCapture`]. Sets `fallback` on anything unrecognised so the caller
/// reprojects the whole tree (correctness is never worse than brute force).
fn classify_import_diff(cd: &loro::event::ContainerDiff, cap: &mut DiffCapture) {
    if cd.is_unknown {
        cap.fallback = true;
        return;
    }
    // The diff path starts at the root container; root-targeted diffs (purge of
    // a root key) have a single-element path whose container is the root.
    let root = cd.path.first().map_or(cd.target, |(c, _)| c);
    let loro::ContainerID::Root { name, .. } = root else {
        cap.fallback = true;
        return;
    };
    match name.to_string().as_str() {
        // Engine metadata (format-version stamp, sibling-order marker) is not a
        // block — ignore.
        ENGINE_META_ROOT => {}
        BLOCKS_TREE_ROOT => {
            if let loro::event::Diff::Tree(td) = &cd.diff {
                cap.has_tree_diff = true;
                for item in &td.diff {
                    cap.struct_roots.insert(item.target);
                    match &item.action {
                        // #3162: record the index each item acts at, not just
                        // the parent — see `DiffCapture::affected_parents`.
                        loro::TreeExternalDiff::Create { parent, index, .. } => {
                            note_sibling_shift(cap, *parent, *index);
                        }
                        loro::TreeExternalDiff::Move {
                            parent,
                            index,
                            old_parent,
                            old_index,
                            ..
                        } => {
                            // A cross-parent move shifts BOTH groups: the new
                            // parent from the insertion slot, the old parent
                            // from the vacated slot. A same-parent reorder
                            // folds into one entry at min(index, old_index).
                            note_sibling_shift(cap, *parent, *index);
                            note_sibling_shift(cap, *old_parent, *old_index);
                        }
                        loro::TreeExternalDiff::Delete {
                            old_parent,
                            old_index,
                            ..
                        } => {
                            note_sibling_shift(cap, *old_parent, *old_index);
                        }
                    }
                }
            } else if let Some(tid) = cd.path.iter().find_map(|(_, idx)| match idx {
                loro::Index::Node(t) => Some(*t),
                _ => None,
            }) {
                // Meta-map or content `LoroText` change on a node.
                cap.node_ids.insert(tid);
            } else {
                cap.fallback = true;
            }
        }
        BLOCK_PROPERTIES_ROOT => {
            collect_block_id_keys(cd, &mut cap.block_id_keys, &mut cap.fallback);
        }
        BLOCK_TAGS_ROOT => {
            let mut ids = std::collections::HashSet::new();
            collect_block_id_keys(cd, &mut ids, &mut cap.fallback);
            for id in ids {
                cap.tag_changed.insert(id.clone());
                cap.block_id_keys.insert(id);
            }
        }
        // LEGACY_BLOCKS_ROOT (rejected upstream) or any unknown root.
        _ => cap.fallback = true,
    }
}

/// Record that `parent`'s sibling group was disturbed at `index`, keeping the
/// LOWEST index seen for that parent (#3162). See
/// [`DiffCapture::affected_parents`] for why the minimum is the correct — and
/// safe — summary of a whole ordered diff sequence.
fn note_sibling_shift(cap: &mut DiffCapture, parent: TreeParentId, index: usize) {
    cap.affected_parents
        .entry(parent)
        .and_modify(|lowest| *lowest = (*lowest).min(index))
        .or_insert(index);
}

/// Extract the block_id(s) a `block_properties` / `block_tags` diff touches:
/// the `Index::Key(block_id)` of a per-block sub-map diff, or the updated keys
/// of a root-level map diff (first-time insert / purge removal).
fn collect_block_id_keys(
    cd: &loro::event::ContainerDiff,
    out: &mut std::collections::HashSet<String>,
    fallback: &mut bool,
) {
    if cd.path.len() >= 2 {
        if let loro::Index::Key(k) = &cd.path[1].1 {
            out.insert(k.to_string());
        } else {
            *fallback = true;
        }
        return;
    }
    if let loro::event::Diff::Map(delta) = &cd.diff {
        for k in delta.updated.keys() {
            out.insert(k.to_string());
        }
        return;
    }
    *fallback = true;
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
            AppError::Validation { message: m, .. } => assert!(
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
            AppError::Validation { message: m, .. } => assert!(
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

#[cfg(test)]
mod noop_short_circuit_tests {
    //! #2036: a no-op import (one that appends zero ops to the oplog — a
    //! duplicate/redelivered snapshot or update) must short-circuit to an empty
    //! changed/purged set without reprojecting the whole space.
    use super::*;

    /// Re-importing the SAME snapshot bytes a second time appends no ops, so the
    /// second call returns an empty changed+purged pair (no reproject), while the
    /// first call still reports the imported block.
    #[test]
    fn import_with_changed_blocks_empty_on_duplicate_snapshot() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("AA", "content", "ca", None, 0)
            .unwrap();
        let bytes = a.export_snapshot().unwrap();

        let mut b = LoroEngine::new();
        let (changed1, purged1) = b.import_with_changed_and_purged_blocks(&bytes).unwrap();
        assert!(
            changed1.iter().any(|bid| bid.as_str() == "AA"),
            "first import must report the new block, got {changed1:?}",
        );
        assert!(purged1.is_empty(), "first import purged nothing");
        assert_eq!(b.count_alive_blocks().unwrap(), 1);

        // Second import of identical bytes — zero new ops → short-circuit.
        let (changed2, purged2) = b.import_with_changed_and_purged_blocks(&bytes).unwrap();
        assert!(
            changed2.is_empty() && purged2.is_empty(),
            "duplicate import must short-circuit to empty, got changed={changed2:?} purged={purged2:?}",
        );
        assert_eq!(
            b.count_alive_blocks().unwrap(),
            1,
            "duplicate import must not alter state",
        );
    }

    /// Realistic sync flow: snapshot then incremental update. A genuinely new
    /// update reports a non-empty changed set; re-applying the same update is a
    /// no-op and returns empty.
    #[test]
    fn import_with_changed_blocks_empty_on_duplicate_update() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("AA", "content", "ca", None, 0)
            .unwrap();

        // Seed b from a's snapshot.
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 1);

        // a adds a second block; export only the ops b is missing.
        a.apply_create_block("BB", "content", "cb", None, 1)
            .unwrap();
        let update = a.export_update_since(&b.version_vector()).unwrap();

        // First application: real ops → non-empty, includes the new block.
        let (changed1, _purged1) = b.import_with_changed_and_purged_blocks(&update).unwrap();
        assert!(
            changed1.iter().any(|bid| bid.as_str() == "BB"),
            "real update must report the new block, got {changed1:?}",
        );
        assert_eq!(b.count_alive_blocks().unwrap(), 2);

        // Re-applying the identical update appends nothing → short-circuit.
        let (changed2, purged2) = b.import_with_changed_and_purged_blocks(&update).unwrap();
        assert!(
            changed2.is_empty() && purged2.is_empty(),
            "duplicate update must short-circuit to empty, got changed={changed2:?} purged={purged2:?}",
        );
        assert_eq!(b.count_alive_blocks().unwrap(), 2);
    }

    /// `import` (snapshot/boot path) is idempotent across a duplicate import and
    /// the no-op short-circuit leaves the materialised state intact.
    #[test]
    fn import_idempotent_on_duplicate() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("x", "content", "X", None, 0).unwrap();
        let bytes = a.export_snapshot().unwrap();

        let mut b = LoroEngine::new();
        b.import(&bytes).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 1);
        // Duplicate import hits the no-op short-circuit; state unchanged.
        b.import(&bytes).unwrap();
        assert_eq!(b.count_alive_blocks().unwrap(), 1);
    }
}

#[cfg(test)]
mod incremental_detection_tests {
    //! #2036 stage 2/3: the import diff resolver must return the PRECISE set of
    //! changed (live) blocks, the purged set, and a correctly-scoped
    //! [`TagScope`] for each block-mutation type.
    use super::*;

    fn ids(v: &[agaric_core::ulid::BlockId]) -> Vec<String> {
        let mut s: Vec<String> = v.iter().map(|b| b.as_str().to_string()).collect();
        s.sort();
        s
    }
    fn scope(s: &TagScope) -> Option<Vec<String>> {
        match s {
            TagScope::Global => None,
            TagScope::Subtrees(v) => {
                let mut x: Vec<String> = v.iter().map(|b| b.as_str().to_string()).collect();
                x.sort();
                Some(x)
            }
        }
    }
    /// `a` = source device with AA (root) and BB (child of AA); `b` = receiver
    /// seeded from a's snapshot.
    fn seed() -> (LoroEngine, LoroEngine) {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("AA", "content", "a", None, 0).unwrap();
        a.apply_create_block("BB", "content", "b", Some("AA"), 0)
            .unwrap();
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        (a, b)
    }
    fn push(a: &LoroEngine, b: &mut LoroEngine) -> (Vec<String>, Vec<String>, Option<Vec<String>>) {
        let d = push_delta(a, b);
        (ids(&d.changed), ids(&d.purged), scope(&d.tag_scope))
    }
    /// Like [`push`] but hands back the whole [`ImportDelta`] so the #3162
    /// tests can assert on `rank_only` too.
    fn push_delta(a: &LoroEngine, b: &mut LoroEngine) -> ImportDelta {
        let upd = a.export_update_since(&b.version_vector()).unwrap();
        b.import_with_changed_purged_tagscope(&upd).unwrap()
    }

    #[test]
    fn content_edit_changes_only_that_block() {
        let (mut a, mut b) = seed();
        a.apply_edit_content("BB", 0, 0, "X").unwrap();
        let (changed, purged, sc) = push(&a, &mut b);
        assert_eq!(changed, vec!["BB"], "only the edited block reprojects");
        assert!(purged.is_empty());
        assert_eq!(
            sc,
            Some(vec![]),
            "content edit does not touch tag inheritance"
        );
    }

    #[test]
    fn property_set_changes_only_that_block() {
        let (mut a, mut b) = seed();
        a.apply_set_property("BB", "k", Some("v")).unwrap();
        let (changed, purged, sc) = push(&a, &mut b);
        assert_eq!(changed, vec!["BB"]);
        assert!(purged.is_empty());
        assert_eq!(sc, Some(vec![]));
    }

    #[test]
    fn tag_add_changes_block_and_scopes_its_subtree() {
        let (mut a, mut b) = seed();
        a.apply_add_tag("AA", "T1").unwrap();
        let (changed, purged, sc) = push(&a, &mut b);
        assert_eq!(changed, vec!["AA"]);
        assert!(purged.is_empty());
        assert_eq!(
            sc,
            Some(vec!["AA".to_string()]),
            "AA's subtree re-inherits the new tag"
        );
    }

    #[test]
    fn create_child_appended_reprojects_only_the_new_block() {
        let (mut a, mut b) = seed();
        // AA's children are [BB]; CC is APPENDED at index 1, so BB (index 0)
        // keeps its dense rank. Pre-#3162 the resolver expanded to every child
        // of the affected parent and reprojected BB too.
        a.apply_create_block("CC", "content", "c", Some("AA"), 1)
            .unwrap();
        let d = push_delta(&a, &mut b);
        assert_eq!(
            ids(&d.changed),
            vec!["CC"],
            "an append shifts no sibling rank; only the new child reprojects (#3162)",
        );
        assert!(
            d.rank_only.is_empty(),
            "no sibling shifted, so nothing is rank-only",
        );
        assert!(d.purged.is_empty());
        assert_eq!(
            scope(&d.tag_scope),
            Some(vec!["CC".to_string()]),
            "new node re-inherits ancestor tags"
        );
    }

    /// #3162: inserting into the MIDDLE of a sibling group reprojects the new
    /// block plus exactly the siblings at or after the insertion slot — never
    /// the ones before it, whose dense rank provably did not move.
    #[test]
    fn create_child_in_middle_reprojects_only_shifted_siblings_3162() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("P", "content", "p", None, 0).unwrap();
        for (i, id) in ["C0", "C1", "C2", "C3"].iter().enumerate() {
            a.apply_create_block_at(id, "content", "c", Some("P"), i)
                .unwrap();
        }
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();

        // Insert NEW at index 2 → C0/C1 keep ranks 0/1; C2/C3 shift to 3/4.
        a.apply_create_block_at("NEW", "content", "n", Some("P"), 2)
            .unwrap();
        let d = push_delta(&a, &mut b);
        assert_eq!(
            ids(&d.changed),
            vec!["C2", "C3", "NEW"],
            "only the siblings at/after the insertion slot shift rank (#3162)",
        );
        assert_eq!(
            ids(&d.rank_only),
            vec!["C2", "C3"],
            "the shifted siblings need only their `position` refreshed; the \
             newly created block always needs the full projection",
        );
    }

    /// #3162 (the O(n^2) case from the issue): a create at `TreeParentId::Root`
    /// used to reproject EVERY root-level block in the space. An append must
    /// now touch exactly one.
    #[test]
    fn root_append_does_not_reproject_the_root_sibling_group_3162() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        for i in 0..12 {
            a.apply_create_block_at(&format!("R{i:02}"), "content", "r", None, i)
                .unwrap();
        }
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();

        a.apply_create_block_at("R99", "content", "r", None, 12)
            .unwrap();
        let d = push_delta(&a, &mut b);
        assert_eq!(
            ids(&d.changed),
            vec!["R99"],
            "an inbound root-level append must not scale with the root sibling \
             group (#3162)",
        );
        assert!(d.rank_only.is_empty());
    }

    /// #3162 — moves affect TWO sibling groups, each from its own slot: the OLD
    /// parent from the vacated index, the NEW parent from the insertion index.
    /// Siblings before either slot must be left alone.
    #[test]
    fn cross_parent_move_narrows_both_sibling_groups_3162() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("P", "content", "p", None, 0).unwrap();
        a.apply_create_block("Q", "content", "q", None, 1).unwrap();
        for (i, id) in ["P0", "P1", "P2"].iter().enumerate() {
            a.apply_create_block_at(id, "content", "c", Some("P"), i)
                .unwrap();
        }
        for (i, id) in ["Q0", "Q1", "Q2"].iter().enumerate() {
            a.apply_create_block_at(id, "content", "c", Some("Q"), i)
                .unwrap();
        }
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();

        // P1 (old index 1 under P) moves to index 1 under Q.
        // Old group: P2 shifts down (P0 does not). New group: Q1, Q2 shift up
        // (Q0 does not).
        a.apply_move_block_to("P1", Some("Q"), 1).unwrap();
        let d = push_delta(&a, &mut b);
        assert_eq!(
            ids(&d.changed),
            vec!["P1", "P2", "Q1", "Q2"],
            "both groups narrow to the siblings after their own slot; P0 and Q0 \
             keep their ranks (#3162)",
        );
        assert_eq!(
            ids(&d.rank_only),
            vec!["P2", "Q1", "Q2"],
            "the moved block itself is structural and always fully reprojected",
        );
    }

    /// #3162 — a delete shifts only the siblings AFTER the vacated slot.
    #[test]
    fn delete_narrows_old_sibling_group_3162() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("P", "content", "p", None, 0).unwrap();
        for (i, id) in ["C0", "C1", "C2", "C3"].iter().enumerate() {
            a.apply_create_block_at(id, "content", "c", Some("P"), i)
                .unwrap();
        }
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();

        a.apply_purge_block("C1").unwrap();
        let d = push_delta(&a, &mut b);
        assert_eq!(
            ids(&d.purged),
            vec!["C1"],
            "the hard-purged block is reported through the purged delta",
        );
        assert_eq!(
            ids(&d.changed),
            vec!["C2", "C3"],
            "only the siblings after the vacated slot shift rank (#3162)",
        );
        assert_eq!(ids(&d.rank_only), vec!["C2", "C3"]);
    }

    /// #3162 — the rank-only hint must never swallow a block that ALSO changed
    /// for another reason in the same import: the consumer skips the property /
    /// tag / soft-delete passes for rank-only members, so a mis-classification
    /// there is silent CRDT-vs-SQL divergence.
    #[test]
    fn rank_only_excludes_siblings_with_a_real_change_3162() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block("P", "content", "p", None, 0).unwrap();
        for (i, id) in ["C0", "C1", "C2"].iter().enumerate() {
            a.apply_create_block_at(id, "content", "c", Some("P"), i)
                .unwrap();
        }
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();

        // One update carrying BOTH a rank shift (insert at 0) and a property
        // edit on one of the shifted siblings.
        a.apply_create_block_at("NEW", "content", "n", Some("P"), 0)
            .unwrap();
        a.apply_set_property("C1", "k", Some("v")).unwrap();
        let d = push_delta(&a, &mut b);
        assert_eq!(
            ids(&d.changed),
            vec!["C0", "C1", "C2", "NEW"],
            "insertion at index 0 shifts the whole group",
        );
        assert_eq!(
            ids(&d.rank_only),
            vec!["C0", "C2"],
            "C1 also had a property change, so it must keep the FULL projection",
        );
    }

    #[test]
    fn move_block_reprojects_moved_node_and_shifted_new_siblings() {
        let (mut a, mut b) = seed();
        a.apply_create_block("CC", "content", "c", None, 1).unwrap();
        let _ = push(&a, &mut b); // sync the create
        // Root is [AA, CC]; BB (AA's only child) moves to root and lands
        // BETWEEN them, giving [AA, BB, CC].
        a.apply_move_block("BB", None, 0).unwrap(); // BB: child of AA -> root
        let d = push_delta(&a, &mut b);
        let changed = ids(&d.changed);
        assert!(changed.contains(&"BB".to_string()), "moved node reprojects");
        assert!(
            changed.contains(&"CC".to_string()),
            "CC sits after the insertion slot, so its dense rank shifts 1 -> 2, \
             got {changed:?}",
        );
        // #3162: AA is BEFORE the insertion slot in the new-parent group, so
        // its rank stays 0 — reprojecting it was pure waste. AA is also the
        // OLD parent, whose remaining sibling group is now empty, so nothing
        // shifts there either. Pre-#3162 every child of both affected parents
        // was reprojected regardless.
        assert!(
            !changed.contains(&"AA".to_string()),
            "AA's rank did not move; it must not be reprojected (#3162), got {changed:?}",
        );
        assert_eq!(
            ids(&d.rank_only),
            vec!["CC"],
            "CC only needs its `position` refreshed; BB moved, so it is \
             structural and fully reprojected",
        );
        assert!(d.purged.is_empty());
        assert_eq!(
            scope(&d.tag_scope),
            Some(vec!["BB".to_string()]),
            "moved subtree re-inherits new ancestors"
        );
    }

    #[test]
    fn soft_delete_changes_seed_only() {
        let (mut a, mut b) = seed();
        a.apply_delete_block("BB", "2026-01-01T00:00:00Z").unwrap();
        let (changed, purged, sc) = push(&a, &mut b);
        assert_eq!(changed, vec!["BB"], "Pass C cascades from the seed in SQL");
        assert!(purged.is_empty());
        assert_eq!(sc, Some(vec![]));
    }

    #[test]
    fn purge_reports_purged_excludes_from_changed() {
        let (mut a, mut b) = seed();
        a.apply_purge_block("BB").unwrap(); // BB is a leaf child of AA
        let (changed, purged, sc) = push(&a, &mut b);
        assert_eq!(purged, vec!["BB"]);
        assert!(
            !changed.contains(&"BB".to_string()),
            "purged block is not in the live changed set, got {changed:?}",
        );
        assert_eq!(
            sc,
            Some(vec![]),
            "purged subtree handled by Pass D, not a tag recompute",
        );
    }

    #[test]
    fn duplicate_update_short_circuits() {
        let (mut a, mut b) = seed();
        a.apply_edit_content("BB", 0, 0, "X").unwrap();
        let _ = push(&a, &mut b);
        let upd = a.export_update_since(&b.version_vector()).unwrap();
        let d = b.import_with_changed_purged_tagscope(&upd).unwrap();
        assert!(d.changed.is_empty() && d.purged.is_empty() && d.rank_only.is_empty());
        assert_eq!(d.tag_scope, TagScope::Subtrees(vec![]));
    }

    /// #2036 follow-up: a non-structural edit takes the `rebuild_index`-skipping
    /// fast path, yet `self.index` stays correct across it — proven by sandwiching
    /// the skipped-rebuild content edit between two STRUCTURAL ops on the same
    /// block. If the edit had left the index stale, resolving / moving `CC`
    /// afterwards would break.
    #[test]
    fn fast_path_edit_preserves_index_across_structural_ops() {
        let (mut a, mut b) = seed(); // AA(root), BB(child of AA)

        // Structural: create CC under AA (takes the rebuild path → CC indexed).
        a.apply_create_block("CC", "content", "c", Some("AA"), 1)
            .unwrap();
        let _ = push(&a, &mut b);
        assert_eq!(b.count_alive_blocks().unwrap(), 3);

        // Non-structural: edit CC's content (no Tree diff → skips rebuild_index).
        a.apply_edit_content("CC", 0, 0, "x").unwrap();
        let (changed, purged, _) = push(&a, &mut b);
        assert_eq!(changed, vec!["CC"]);
        assert!(purged.is_empty());

        // Structural again: move CC to the root. CC must still be in the index
        // after the rebuild-skipped edit, or this resolves/moves the wrong node.
        a.apply_move_block("CC", None, 0).unwrap();
        let (changed2, _purged2, _) = push(&a, &mut b);
        assert!(
            changed2.contains(&"CC".to_string()),
            "moved CC must resolve after a rebuild-skipped edit, got {changed2:?}",
        );
        assert_eq!(b.count_alive_blocks().unwrap(), 3);
    }

    // -----------------------------------------------------------------------
    // #3162 adversarial review — the `rank_only` contract checked against
    // ENGINE STATE, not against the resolver's own bookkeeping.
    //
    // The consumer (`import_and_project`) skips the property / tag /
    // soft-delete passes for every `rank_only` member, so a block that is
    // classified rank-only while some OTHER projected column also changed is
    // silent CRDT-vs-SQL divergence — no test goes red, the data is just
    // wrong. These tests take a full before/after snapshot of every live
    // block's projected state on the receiver and assert the contract
    // directly.
    // -----------------------------------------------------------------------

    /// Everything the SQL projection derives from the engine for one block:
    /// the four core columns (Pass A), the typed properties (Pass A-props),
    /// the direct tags (Pass B) and the soft-delete seed (Pass C).
    type ProjectedState = (
        Option<(String, String, Option<String>, i64)>,
        Vec<(String, PropertyValue)>,
        Vec<String>,
        Option<String>,
    );

    /// Snapshot the projected state of every live block in `e`.
    fn projected_state(e: &LoroEngine) -> std::collections::BTreeMap<String, ProjectedState> {
        let mut out = std::collections::BTreeMap::new();
        for bid in e.enumerate_live_preorder() {
            let id = bid.as_str().to_string();
            let core = e.read_block(&id).unwrap().map(|s| {
                (
                    s.block_type.clone(),
                    s.content.clone(),
                    s.parent_id.clone(),
                    s.position,
                )
            });
            let mut props = e.read_all_properties_typed(&id).unwrap();
            props.sort_by(|x, y| x.0.cmp(&y.0));
            let mut tags = e.read_tags(&id).unwrap();
            tags.sort();
            let del = e.read_deleted_at(&id).unwrap();
            out.insert(id, (core, props, tags, del));
        }
        out
    }

    /// Assert the two load-bearing invariants of the #3162 narrowing:
    ///
    /// 1. every live block whose projected state changed AT ALL is in
    ///    `changed` (the narrowing must not drop a genuinely-changed block);
    /// 2. every block in `rank_only` had ONLY its dense `position` change.
    fn assert_rank_only_contract(
        before: &std::collections::BTreeMap<String, ProjectedState>,
        after: &std::collections::BTreeMap<String, ProjectedState>,
        d: &ImportDelta,
        label: &str,
    ) {
        let changed: std::collections::HashSet<String> = ids(&d.changed).into_iter().collect();
        let rank_only: std::collections::HashSet<String> = ids(&d.rank_only).into_iter().collect();
        assert!(
            rank_only.is_subset(&changed),
            "{label}: `rank_only` must be a subset of `changed`; \
             rank_only={rank_only:?} changed={changed:?}",
        );
        for (id, aft) in after {
            let Some(bef) = before.get(id) else {
                // Newly live block: must be in `changed`, never rank-only.
                assert!(
                    changed.contains(id),
                    "{label}: new block {id} not in changed"
                );
                assert!(
                    !rank_only.contains(id),
                    "{label}: new block {id} is rank-only"
                );
                continue;
            };
            if bef != aft {
                assert!(
                    changed.contains(id),
                    "{label}: {id} changed projected state but is NOT in `changed`\n\
                     before={bef:?}\nafter={aft:?}",
                );
            }
            if rank_only.contains(id) {
                let (bc, bp, bt, bd) = bef;
                let (ac, ap, at, ad) = aft;
                assert_eq!(
                    bp, ap,
                    "{label}: {id} is rank-only but its PROPERTIES changed \
                     (Pass A-props is skipped for it ⇒ silent divergence)",
                );
                assert_eq!(
                    bt, at,
                    "{label}: {id} is rank-only but its TAGS changed \
                     (Pass B is skipped for it ⇒ silent divergence)",
                );
                assert_eq!(
                    bd, ad,
                    "{label}: {id} is rank-only but its deleted_at seed changed \
                     (Pass C is skipped for it ⇒ silent divergence)",
                );
                // Core columns: only `position` may differ.
                let (bt_, bcont, bpar, _) = bc.clone().expect("live before");
                let (at_, acont, apar, _) = ac.clone().expect("live after");
                assert_eq!(bt_, at_, "{label}: {id} rank-only but block_type changed");
                assert_eq!(bcont, acont, "{label}: {id} rank-only but content changed");
                assert_eq!(bpar, apar, "{label}: {id} rank-only but parent_id changed");
            }
        }
    }

    /// Build a receiver seeded from `a`'s snapshot.
    fn receiver(a: &LoroEngine) -> LoroEngine {
        let mut b = LoroEngine::new();
        b.import(&a.export_snapshot().unwrap()).unwrap();
        b
    }

    /// A parent `P` with children C0..C5 plus a second parent `Q` with Q0..Q2,
    /// both at root, all carrying a property and a tag so a mis-classification
    /// has something to lose.
    fn adversarial_seed() -> LoroEngine {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        a.apply_create_block_at("P", "content", "p", None, 0)
            .unwrap();
        a.apply_create_block_at("Q", "content", "q", None, 1)
            .unwrap();
        for (i, id) in ["C0", "C1", "C2", "C3", "C4", "C5"].iter().enumerate() {
            a.apply_create_block_at(id, "content", id, Some("P"), i)
                .unwrap();
            a.apply_set_property(id, "k", Some(id)).unwrap();
            a.apply_add_tag(id, &format!("T{i}")).unwrap();
        }
        for (i, id) in ["Q0", "Q1", "Q2"].iter().enumerate() {
            a.apply_create_block_at(id, "content", id, Some("Q"), i)
                .unwrap();
        }
        a
    }

    /// Backwards same-parent reorder: C4 (index 4) moves to index 1. The
    /// travelled span is [1, 4]; `min(index, old_index)` must cover all of it,
    /// and C0 (before the span) must be left alone.
    #[test]
    fn adversarial_same_parent_backward_move_covers_travelled_span_3162() {
        let mut a = adversarial_seed();
        let mut b = receiver(&a);
        let before = projected_state(&b);

        a.apply_move_block_to("C4", Some("P"), 1).unwrap();
        let d = push_delta(&a, &mut b);
        let after = projected_state(&b);
        assert_rank_only_contract(&before, &after, &d, "backward same-parent move");

        // `apply_move_block_to` uses `LoroTree::mov_to` semantics — the index
        // is the slot among the OTHER children — so C4 lands at 1 and the
        // group becomes [C0, C4, C1, C2, C3, C5]. min(index=1, old_index=4)=1,
        // so the walk starts at 1 and covers the whole travelled span. C5 is
        // swept in as well even though its rank is unchanged: the minimum is a
        // safe over-approximation, never an under-one. That costs one no-op
        // `position` upsert, which is the point of the rank-only path.
        assert_eq!(
            ids(&d.changed),
            vec!["C1", "C2", "C3", "C4", "C5"],
            "the travelled span [1,4] reprojects (plus a conservative tail); \
             C0, before the span, is left alone",
        );
        assert_eq!(
            ids(&d.rank_only),
            vec!["C1", "C2", "C3", "C5"],
            "the moved node itself is structural",
        );
        // C0 is before the span: independently confirm its rank did not move.
        assert_eq!(before["C0"].0, after["C0"].0);
        assert_eq!(before["C5"].0, after["C5"].0, "C5 was a no-op reprojection");
    }

    /// Cross-parent move whose DESTINATION index is lower than the source
    /// index: C5 (index 5 under P) → index 0 under Q. The old group narrows
    /// from 5 (nothing after it), the new group from 0 (everything).
    #[test]
    fn adversarial_cross_parent_move_to_lower_index_3162() {
        let mut a = adversarial_seed();
        let mut b = receiver(&a);
        let before = projected_state(&b);

        a.apply_move_block_to("C5", Some("Q"), 0).unwrap();
        let d = push_delta(&a, &mut b);
        let after = projected_state(&b);
        assert_rank_only_contract(&before, &after, &d, "cross-parent move to lower index");

        assert_eq!(
            ids(&d.changed),
            vec!["C5", "Q0", "Q1", "Q2"],
            "old group had nothing after the vacated tail slot; new group \
             shifts entirely",
        );
        assert_eq!(ids(&d.rank_only), vec!["Q0", "Q1", "Q2"]);
        for c in ["C0", "C1", "C2", "C3", "C4"] {
            assert_eq!(
                before[c].0, after[c].0,
                "{c} is before the vacated slot; its rank must not move",
            );
        }

        // Same shape, but with live siblings AFTER the vacated slot too: C1
        // (index 1 under P) → index 0 under Q. Destination index (0) is lower
        // than the source index (1), and BOTH groups have members that shift.
        let mut a = adversarial_seed();
        let mut b = receiver(&a);
        let before = projected_state(&b);
        a.apply_move_block_to("C1", Some("Q"), 0).unwrap();
        let d = push_delta(&a, &mut b);
        let after = projected_state(&b);
        assert_rank_only_contract(&before, &after, &d, "cross-parent move, both groups shift");
        assert_eq!(
            ids(&d.changed),
            vec!["C1", "C2", "C3", "C4", "C5", "Q0", "Q1", "Q2"],
            "old group narrows from the vacated slot 1, new group from 0",
        );
        assert_eq!(
            ids(&d.rank_only),
            vec!["C2", "C3", "C4", "C5", "Q0", "Q1", "Q2"],
        );
        assert_eq!(
            before["C0"].0, after["C0"].0,
            "C0 precedes the vacated slot and must be untouched",
        );
    }

    /// The silent-divergence shape the review was hunting: a rank shift and a
    /// REAL change to the same block, arriving in ONE import. One case per
    /// channel the resolver claims to exclude — content, tag, soft-delete.
    #[test]
    fn adversarial_rank_shift_plus_real_change_same_import_3162() {
        // (a) content edit on a shifted sibling.
        {
            let mut a = adversarial_seed();
            let mut b = receiver(&a);
            let before = projected_state(&b);
            a.apply_create_block_at("NEW", "content", "n", Some("P"), 0)
                .unwrap();
            a.apply_edit_content("C3", 0, 0, "Z").unwrap();
            let d = push_delta(&a, &mut b);
            let after = projected_state(&b);
            assert_rank_only_contract(&before, &after, &d, "rank shift + content edit");
            assert!(
                !ids(&d.rank_only).contains(&"C3".to_string()),
                "C3's content changed; it must not be demoted to rank-only",
            );
        }
        // (b) tag add on a shifted sibling.
        {
            let mut a = adversarial_seed();
            let mut b = receiver(&a);
            let before = projected_state(&b);
            a.apply_create_block_at("NEW", "content", "n", Some("P"), 0)
                .unwrap();
            a.apply_add_tag("C3", "TX").unwrap();
            let d = push_delta(&a, &mut b);
            let after = projected_state(&b);
            assert_rank_only_contract(&before, &after, &d, "rank shift + tag add");
            assert!(
                !ids(&d.rank_only).contains(&"C3".to_string()),
                "C3's tags changed; Pass B is skipped for rank-only members",
            );
        }
        // (c) soft-delete of a shifted sibling (a live tree node, so it still
        //     takes part in the sibling group).
        {
            let mut a = adversarial_seed();
            let mut b = receiver(&a);
            let before = projected_state(&b);
            a.apply_create_block_at("NEW", "content", "n", Some("P"), 0)
                .unwrap();
            a.apply_delete_block("C3", "1767225600000").unwrap();
            let d = push_delta(&a, &mut b);
            let after = projected_state(&b);
            assert_rank_only_contract(&before, &after, &d, "rank shift + soft delete");
            assert!(
                !ids(&d.rank_only).contains(&"C3".to_string()),
                "C3's deleted_at seed changed; Pass C is skipped for rank-only \
                 members",
            );
        }
        // (d) property delete on a shifted sibling.
        {
            let mut a = adversarial_seed();
            let mut b = receiver(&a);
            let before = projected_state(&b);
            a.apply_create_block_at("NEW", "content", "n", Some("P"), 0)
                .unwrap();
            a.apply_delete_property("C3", "k").unwrap();
            let d = push_delta(&a, &mut b);
            let after = projected_state(&b);
            assert_rank_only_contract(&before, &after, &d, "rank shift + property delete");
            assert!(!ids(&d.rank_only).contains(&"C3".to_string()));
        }
    }

    /// Many structural items in ONE import, deliberately ordered so the diff
    /// sequence touches high indices before low ones. This is the case where
    /// a "min index" summary would break if Loro's indices were against the
    /// ORIGINAL state rather than the incrementally-mutated one.
    #[test]
    fn adversarial_mixed_batch_single_import_3162() {
        let mut a = adversarial_seed();
        let mut b = receiver(&a);
        let before = projected_state(&b);

        // High index first, then progressively lower ones, mixed kinds.
        a.apply_purge_block("C5").unwrap(); // remove at 5
        a.apply_move_block_to("C4", Some("Q"), 2).unwrap(); // move out at 4, in at 2
        a.apply_create_block_at("N3", "content", "n3", Some("P"), 3)
            .unwrap(); // insert at 3
        a.apply_move_block_to("C0", Some("P"), 2).unwrap(); // same-parent 0 -> 2
        a.apply_set_property("C2", "k", Some("v2")).unwrap();
        a.apply_add_tag("Q0", "TQ").unwrap();
        a.apply_delete_block("Q2", "1767225600000").unwrap();

        let d = push_delta(&a, &mut b);
        let after = projected_state(&b);
        assert_rank_only_contract(&before, &after, &d, "mixed batch, one import");
        assert_eq!(ids(&d.purged), vec!["C5"]);
    }

    /// The narrowing lemma stated as a direct property: for EVERY live block
    /// the receiver did not put in `changed`, the block's projected state is
    /// byte-identical before and after. Driven over a deterministic pseudo
    /// random walk of structural + content ops so the diff sequences are not
    /// hand-picked.
    #[test]
    fn adversarial_narrowing_lemma_property_walk_3162() {
        let mut a = adversarial_seed();
        let mut b = receiver(&a);
        // xorshift so the walk is reproducible without a dev-dependency.
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        // Uniform-enough index pick without any lossy cast.
        fn pick(r: u64, n: usize) -> usize {
            usize::try_from(r % u64::try_from(n).expect("n fits u64")).expect("fits usize")
        }
        let parents = ["P", "Q"];
        let mut created = 0usize;
        for round in 0..40 {
            let before = projected_state(&b);
            // 1-3 ops per import so single diffs carry several items.
            let ops = 1 + pick(next(), 3);
            for _ in 0..ops {
                let live: Vec<String> = a
                    .enumerate_live_preorder()
                    .iter()
                    .map(|x| x.as_str().to_string())
                    .filter(|x| x != "P" && x != "Q")
                    .collect();
                if live.is_empty() {
                    break;
                }
                let victim = live[pick(next(), live.len())].clone();
                let parent = parents[pick(next(), 2)];
                let slots = a.enumerate_live_preorder().len();
                match next() % 6 {
                    0 => {
                        created += 1;
                        let id = format!("X{created:03}");
                        let idx = pick(next(), slots.max(1));
                        let _ = a.apply_create_block_at(&id, "content", &id, Some(parent), idx);
                    }
                    1 => {
                        let idx = pick(next(), slots.max(1));
                        let _ = a.apply_move_block_to(&victim, Some(parent), idx);
                    }
                    2 => {
                        let _ = a.apply_purge_block(&victim);
                    }
                    3 => {
                        let _ = a.apply_set_property(&victim, "k", Some(&format!("r{round}")));
                    }
                    4 => {
                        let _ = a.apply_add_tag(&victim, &format!("TT{round}"));
                    }
                    _ => {
                        let _ = a.apply_edit_content(&victim, 0, 0, "z");
                    }
                }
            }
            let d = push_delta(&a, &mut b);
            let after = projected_state(&b);
            assert_rank_only_contract(&before, &after, &d, &format!("property walk round {round}"));
        }
    }
}
