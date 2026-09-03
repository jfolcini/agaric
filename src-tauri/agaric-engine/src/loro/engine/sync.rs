//! Sync-update generation and inbound-blob inspection for [`LoroEngine`].
//!
//! `version_vector` / `export_update_since` produce the delta stream;
//! `own_peer_fork_in_blob` (#792) and `unreachable_update_in_blob` (#1054)
//! pre-screen an inbound blob before importing it.

use super::*;

use loro::{Counter, ImportBlobMetadata};

impl LoroEngine {
    /// Encode the doc's current op-log version vector for transport
    /// over the wire.
    ///
    /// Wraps `LoroDoc::oplog_vv()` and serialises the result via
    /// `VersionVector::encode()` (Loro 1.12 wire-stable). Used by sync
    /// push to (a) advertise the local frontier and (b) build the
    /// `from_vv` field of
    /// `sync_protocol::loro_sync_types::LoroSyncMessage::Update`
    /// at send time.
    pub fn version_vector(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }
    /// Export the ops added to this doc since the peer's `since_vv`
    /// frontier.
    ///
    /// `since_vv` is the receiver's current `oplog_vv()` encoded via
    /// [`Self::version_vector`] (or any other path that produced a
    /// Loro 1.12 `VersionVector::encode` blob).  Internally:
    ///
    /// 1. `VersionVector::decode(since_vv)`
    ///    (`loro-internal-1.12.0/src/version.rs:847-850`).
    /// 2. `self.doc.export(ExportMode::updates(&vv))`
    ///    (`loro-1.12.0/src/lib.rs:1297-1300`).
    ///
    /// Returns `AppError::Validation` if `since_vv` is not a
    /// well-formed encoded version vector — the receiver should
    /// fall back to a
    /// `sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot`
    /// in that case.
    pub fn export_update_since(&self, since_vv: &[u8]) -> Result<Vec<u8>, AppError> {
        let vv = VersionVector::decode(since_vv).map_err(|e| {
            AppError::validation(format!("loro: export_update_since: decode vv: {e}"))
        })?;
        self.doc
            .export(ExportMode::updates(&vv))
            .map_err(|e| AppError::validation(format!("loro: export_update_since: {e}")))
    }
    /// Detect a `(peer, counter)` fork of OUR OWN peer id in an inbound
    /// blob, BEFORE importing it (#792).
    ///
    /// ## What a fork is
    ///
    /// Returns `Some(reason)` iff the blob carries ops credited to this
    /// engine's own `PeerID` at counters *beyond* what this doc holds,
    /// while this doc has already minted at least one op under that
    /// `PeerID`. That combination means two divergent op histories share
    /// our peer id — the signature of a pre-#792 snapshot RESET that
    /// reused the deterministic peer id (the peer still holds our
    /// pre-reset ops; we re-minted unrelated ops at the same low
    /// counters). Importing such a blob makes loro skip the overlapping
    /// counter range (its vv already "covers" them) and then apply the
    /// peer's higher-counter ops against the WRONG causal prefix —
    /// panicking inside loro-internal 1.12's richtext state under debug
    /// assertions, silently corrupting it in release. Callers must treat
    /// `Some` as "do not import; request a snapshot catch-up"
    /// (the RESET path now bumps the peer-id epoch, so the catch-up
    /// permanently heals the fork).
    ///
    /// ## What is NOT a fork
    ///
    /// * `local own-counter == 0` — this doc never minted an op under
    ///   its peer id, so there is nothing to collide with. A peer
    ///   re-sending our own pre-reset history into a freshly reset
    ///   (empty) doc is the *clean* resync path: loro imports it and
    ///   local counters continue from the imported vv.
    /// * `blob end_vv[own] <= local own-counter` — the blob carries
    ///   nothing of ours beyond what we hold (the normal echo /
    ///   idempotent re-import shape).
    ///
    /// The inverse fork shape — we re-minted MORE post-reset ops than
    /// the peer holds pre-reset ones — is indistinguishable from a
    /// benign echo at the version-vector level and is NOT detected
    /// here; see #792 for why vv metadata is the practical limit.
    ///
    /// ## This single-blob form is deliberately blind on an empty doc
    ///
    /// With `local own-counter == 0` it accepts unconditionally, which is
    /// right for ONE blob but leaves a batch of them uncompared: two
    /// slots could carry divergent lineages of our peer id and both be
    /// waved through. [`Self::gate_replay_blobs`] closes that (#3190) by
    /// comparing the blobs' own-peer counter ranges against each other
    /// instead of against the doc. It is a batch-only rule — this
    /// function keeps live-gate parity and is not the place for it.
    ///
    /// Decode failures are deliberately tolerated (`None` + a warn):
    /// the guard must never block an import the real
    /// [`Self::import_with_changed_blocks`] would have accepted, and a
    /// genuinely malformed blob will surface a proper error there.
    pub fn own_peer_fork_in_blob(&self, bytes: &[u8]) -> Option<String> {
        // Cheap precondition first: a doc that never minted an op under
        // its own peer id has nothing to fork, so skip the blob-meta
        // decode entirely (it rebuilds the blob's full change store —
        // non-trivial for snapshot blobs, and this empty-doc shape is
        // exactly the post-reset resync window where snapshots arrive).
        let own = self.doc.peer_id();
        let local_counter = self.doc.oplog_vv().get(&own).copied().unwrap_or(0);
        if local_counter == 0 {
            return None;
        }
        let meta = match LoroDoc::decode_import_blob_meta(bytes, true) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro: own_peer_fork_in_blob: blob meta decode failed; \
                     skipping the fork guard (import will surface the real error)"
                );
                return None;
            }
        };
        own_peer_fork_in_meta(own, local_counter, &meta)
    }

    /// #3213 — the #792 fork verdict AND the blob's declared end frontier from
    /// ONE metadata decode.
    ///
    /// The live (`apply_remote`) and per-row boot-replay (`replay_inbox_row`)
    /// paths need both facts about the same blob: the fork verdict decides
    /// whether to import it at all, and the declared end frontier is the
    /// condition under which its durable inbox slot may be deleted afterwards
    /// (#3194/#535 — see [`Self::oplog_shortfall`]). Neither path runs
    /// [`Self::gate_replay_blobs`], so neither has a gate-declared frontier to
    /// thread through; the frontier has to come from the blob itself.
    ///
    /// Asking for the two separately would decode `ImportBlobMetadata` twice,
    /// and that decode rebuilds the blob's whole change store — the expensive
    /// part of every pre-import guard, on the hot inbound path. This decodes
    /// once and answers both.
    ///
    /// The fork verdict is bit-for-bit [`Self::own_peer_fork_in_blob`]'s
    /// (same helper, same `local own-counter == 0` carve-out); the ONLY
    /// difference is that this form cannot take that carve-out's decode
    /// short-circuit, because the end frontier is wanted either way.
    ///
    /// Decode failure is tolerated exactly as in the other guards: no fork
    /// (never block an import the real import would accept) and an EMPTY
    /// declared frontier, which imposes no delete condition — the pre-#3213
    /// behaviour, so an undecodable blob is no worse off than before.
    pub fn screen_inbound_blob(&self, bytes: &[u8]) -> InboundBlobScreen {
        let own = self.doc.peer_id();
        let local_counter = self.doc.oplog_vv().get(&own).copied().unwrap_or(0);
        let meta = match LoroDoc::decode_import_blob_meta(bytes, true) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro: screen_inbound_blob: blob meta decode failed; skipping the \
                     fork guard and imposing no slot-delete condition (import will \
                     surface the real error)"
                );
                return InboundBlobScreen::default();
            }
        };
        InboundBlobScreen {
            fork: own_peer_fork_in_meta(own, local_counter, &meta),
            declared_end_vv: declared_end_vv(&meta),
        }
    }

    /// #1054 — detect an *update*-shaped blob whose causal base is NOT
    /// reachable from this doc's current `oplog_vv()`, BEFORE importing it.
    ///
    /// ## Why this mirrors the live gate
    ///
    /// `sync_protocol::loro_sync::apply_remote` runs the
    /// reachability gate on a `LoroSyncMessage::Update`'s declared `from_vv`
    /// and short-circuits into the snapshot-fallback path on a miss — an
    /// unreachable update would otherwise surface as an *opaque Loro decode
    /// error* from [`Self::import_with_changed_blocks`]. The boot-replay path
    /// has only `(space_id, bytes)` in the inbox row (no `from_vv`), so it
    /// recovers the base from the blob itself: `partial_start_vv` is the blob's
    /// own start frontier — the update's causal base — and is compared against
    /// the local `oplog_vv()` with the SAME "every (peer,counter) entry must be
    /// matched by a local entry whose counter is `>=`" rule as the live gate.
    ///
    /// Returns `Some(reason)` iff the blob is update-shaped AND its
    /// `partial_start_vv` is unreachable. Callers must treat `Some` as "do not
    /// import; drop the slot and let the next live sync session detect the gap
    /// in `apply_remote` and route into snapshot catch-up".
    ///
    /// ## What is NOT flagged (safe to import unconditionally)
    ///
    /// * **Snapshot-shaped blobs** (`meta.mode.is_snapshot()`) — a snapshot is
    ///   self-contained: it carries a full causal base and imports against any
    ///   prior state, exactly as the live gate only checks `Update` (never
    ///   `Snapshot`) variants. Returns `None`.
    /// * A `0`-counter entry in `partial_start_vv` carries no ops and is
    ///   trivially reachable (mirrors the live classifier's no-op skip).
    /// * **Cross-peer dependencies** (`ImportBlobMetadata::start_frontiers`).
    ///   This single-blob guard reads `partial_start_vv` ONLY, exactly like the
    ///   live `apply_remote` gate it mirrors, so a blob with unmet cross-peer
    ///   deps returns `None` here (#3189). The batch gate
    ///   [`Self::gate_replay_blobs`] — the production boot-replay path — closes
    ///   that hole; see `replay_base_miss`. This function is retained as the
    ///   single-row/diagnostic form and deliberately keeps live-gate parity.
    ///
    /// Decode failures are deliberately tolerated (`None` + a warn), identical
    /// to [`Self::own_peer_fork_in_blob`]: the guard must never block an import
    /// the real [`Self::import_with_changed_blocks`] would have accepted, and a
    /// genuinely malformed blob will surface a proper error there.
    pub fn unreachable_update_in_blob(&self, bytes: &[u8]) -> Option<String> {
        let meta = match LoroDoc::decode_import_blob_meta(bytes, true) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "loro: unreachable_update_in_blob: blob meta decode failed; \
                     skipping the reachability guard (import will surface the real error)"
                );
                return None;
            }
        };
        // Snapshot-shaped blobs are self-contained and always safe to import
        // (the live gate only checks Update variants). Skip them.
        if meta.mode.is_snapshot() {
            return None;
        }

        // Update-shaped: the blob's `partial_start_vv` is its causal base.
        // Reachable iff, for every (peer,counter) entry the base requires,
        // our local oplog_vv holds the same peer at a counter `>=` it. A
        // `0`-counter entry carries no ops and is trivially reachable.
        let local_vv = self.doc.oplog_vv();
        for (peer_id, &base_counter) in meta.partial_start_vv.iter() {
            if base_counter == 0 {
                continue;
            }
            match local_vv.get(peer_id) {
                Some(&local_counter) if local_counter >= base_counter => continue,
                Some(&local_counter) => {
                    return Some(format!(
                        "boot-replay update base unreachable (#1054): requires peer={peer_id} \
                         counter>={base_counter}, local oplog_vv has counter={local_counter}"
                    ));
                }
                None => {
                    return Some(format!(
                        "boot-replay update base unreachable (#1054): requires peer={peer_id} \
                         counter>={base_counter}, local oplog_vv has no entry for that peer"
                    ));
                }
            }
        }
        None
    }

    /// #3164 — run the #792 fork guard and the #1054 reachability guard over a
    /// WHOLE batch of boot-replay blobs, in the order they will be imported.
    ///
    /// ## Why a batch needs its own gate
    ///
    /// [`Self::unreachable_update_in_blob`] compares a blob's causal base
    /// against the doc's CURRENT `oplog_vv()`. The per-row replay loop imports
    /// blob *i-1* before gating blob *i*, so a queue of updates from one peer
    /// (the realistic #535 leftover shape: one linear dep chain) passes. A
    /// batch gates every blob BEFORE importing any of them, so the same chain
    /// would report blobs 2..N unreachable and DROP their slots — silent data
    /// loss, and a direct regression of the #1574 / #3165 multi-chunk case.
    ///
    /// This gates the batch against a *cumulative* base: the local
    /// `oplog_vv()`, advanced by the `partial_end_vv` of every blob that was
    /// accepted so far. An accepted import always advances the oplog to at
    /// least that blob's end frontier, and a REJECTED blob is not imported, so
    /// it must not advance the base either.
    ///
    /// ## #3188 — the base is grown to a FIXPOINT, not in one forward pass
    ///
    /// The original #3164 implementation was a single forward pass in slot
    /// order, which made a blob's verdict depend on where its dependency sat in
    /// the batch: a blob whose causal dependency arrives LATER in the same
    /// batch was reported unreachable and its slot dropped, even though
    /// `import_batch` would have resolved it (loro buffers changes with unmet
    /// deps in `pending_changes` and settles them when the deps land, in the
    /// same single re-attach). The per-row loop dropped those blobs too, for
    /// the same reason, so this is data BOTH paths discarded.
    ///
    /// Instead, repeat passes over the still-undecided blobs, advancing the
    /// cumulative base with every newly accepted blob's `partial_end_vv`, until
    /// a whole pass accepts nothing new. Whatever is still undecided is then
    /// marked [`ReplayBlobGate::Unreachable`] with its last-computed reason.
    ///
    /// The fixpoint can only ever accept a SUPERSET of what the single pass
    /// accepted (the base only grows, and growing it never turns an accept into
    /// a reject), which is the safe direction to move on the #535 crash-recovery
    /// path: fewer slots dropped, none accepted whose deps the batch never
    /// supplies. A blob whose base appears nowhere in the batch is still
    /// refused — the base stops growing and the blob is still short. Cost is
    /// O(passes × blobs); each pass but the last accepts at least one blob, so
    /// it is O(N²) metadata comparisons on a batch of N, over metadata decoded
    /// exactly ONCE (the decode, which rebuilds the blob's change store, is the
    /// expensive part and is hoisted out of the loop).
    ///
    /// ## #3189 — cross-peer dependencies are checked too
    ///
    /// Reachability is decided by [`replay_base_miss`], which checks BOTH
    /// halves of an update blob's causal base: `partial_start_vv` (its own-peer
    /// counter range) and `ImportBlobMetadata::start_frontiers` (its cross-peer
    /// dependencies). Before #3189 only the first half was read, so a blob with
    /// unmet cross-peer deps passed this gate, landed in loro's
    /// `pending_changes`, never advanced the oplog, was never projected — and
    /// had its inbox slot deleted anyway: a #535 violation in the silent
    /// direction. Such a blob is now `Unreachable`, which the caller routes into
    /// snapshot catch-up.
    ///
    /// Note the two halves move in OPPOSITE directions, and the #3188 superset
    /// property above is scoped to the fixpoint alone (same predicate, more
    /// passes) — it is NOT a claim that this gate accepts everything the
    /// per-row [`Self::unreachable_update_in_blob`] accepts. #3189 makes this
    /// gate strictly STRICTER than the per-row guard on unmet cross-peer deps,
    /// which is the other #535-safe direction: a blob the per-row guard waved
    /// through would have had its slot deleted with its blocks never projected.
    /// The narrowing is well targeted — `decode_updates_blob_meta` only records
    /// a dep in `start_frontiers` when the dep's peer either starts LATER in
    /// this blob (in which case `partial_start_vv` already demands strictly
    /// more, so half 2 adds nothing) or is absent from the blob entirely
    /// (`fast_snapshot.rs:456-467`). Only that second, genuinely cross-peer
    /// case is newly rejected, and it is exactly the #3189 hole.
    ///
    /// ## #792 / #3190 — the own-peer fork guard, batch form
    ///
    /// Which rule applies depends on the PRE-batch own-peer counter:
    ///
    /// * **`local_counter > 0`** — the per-blob rule of
    ///   [`Self::own_peer_fork_in_blob`], unchanged and order-free: the doc's
    ///   own ops are the lineage of record, so a blob claiming our peer id
    ///   beyond what we hold is a fork. The guard only accepts a blob whose
    ///   `partial_end_vv[own]` is `<=` what we already hold, so importing an
    ///   accepted blob cannot move the counter. This verdict never consults the
    ///   cumulative reachability base, so it is decided in the first sweep and
    ///   the fixpoint cannot change it.
    ///
    /// * **`local_counter == 0`** (#3190) — the doc has never minted an op
    ///   under its peer id, so it contributes no lineage and the per-blob rule
    ///   short-circuits to "accept". Before #3190 that made the whole batch
    ///   fork-blind: `gate_replay_blobs` never mutates the doc, so EVERY blob
    ///   saw `local_counter == 0`, whereas the old per-row loop imported blob
    ///   *i* before gating blob *i+1* and could catch a divergence in one of
    ///   the two slot orders. The lineages are now compared against **what the
    ///   batch has already accepted** instead: each blob's own-peer counter
    ///   range `[partial_start_vv[own], partial_end_vv[own])` is checked
    ///   against the ranges of the own-peer-carrying blobs accepted before it,
    ///   and an OVERLAP is a fork. Unlike the `local_counter > 0` rule this one
    ///   is decided at the ACCEPT SITE inside the #3188 fixpoint, not in the
    ///   first sweep — see "why the accept site" below.
    ///
    /// Why overlap, and only overlap:
    ///
    /// * Two blobs whose own-peer ranges are disjoint cannot disagree about any
    ///   `(own, counter)` id, so a split history — `own@0..100` in one slot,
    ///   `own@100..150` in the next — is a legitimate CONTINUATION and stays
    ///   accepted. That is the false positive the per-row loop has (it compares
    ///   `partial_end_vv[own]` against the counter blob *i* just raised, so it
    ///   drops `own@100..150`) and the reason #3190 forbids simply making the
    ///   batch gate match per-row.
    /// * Two blobs whose ranges overlap credit the same `(own, counter)` ids
    ///   twice. If they carry the same ops the second copy is redundant; if
    ///   they carry different ops this is exactly the #792 fork — loro skips
    ///   the overlapping counters (its vv already "covers" them) and applies
    ///   anything beyond, or anything depending on them, against the WRONG
    ///   causal prefix. Both sub-cases of overlap are harmful in the second
    ///   reading, and `ImportBlobMetadata` carries no content digest that could
    ///   tell them apart, so the ambiguous shape is refused. The divergence is
    ///   caught in EITHER slot order, which the per-row loop never managed.
    ///
    /// ## Why the accept site, and what "order-free" does and does not mean
    ///
    /// The overlap predicate is symmetric, but symmetry alone does NOT make a
    /// greedy sweep order-free: whichever blob is compared first claims the
    /// counter space every later blob is measured against. Two properties do
    /// the real work, and only the first is unconditional:
    ///
    /// * **Safety is order-free.** Each blob is compared against ALL previously
    ///   accepted lineage carriers, so the accepted set is pairwise disjoint in
    ///   our `(peer,counter)` space no matter what order the slots arrive in.
    ///   Two divergent lineages can never both be imported.
    /// * **Which blob is dropped is decided in reachability order**, because
    ///   the check runs where a blob is ACCEPTED (inside the #3188 fixpoint),
    ///   not in the first sweep. On a doc with zero own ops a lineage carrier
    ///   is only reachable once the batch supplies the counters below its
    ///   `partial_start_vv[own]`, so carriers are necessarily accepted from
    ///   counter 0 upward — a canonical order that does not depend on slot
    ///   order. `gate_replay_blobs_own_lineage_verdicts_are_order_free_3190`
    ///   pins that on the smallest batch that can break it (three blobs in a
    ///   partial-overlap chain, all six permutations).
    ///
    /// Deciding this in the first sweep instead — before reachability — was a
    /// real defect, not just a weaker guarantee: a blob that the gate goes on
    /// to drop as [`ReplayBlobGate::Unreachable`] is never imported, yet it had
    /// already claimed its counter range and forked the legitimate blobs on
    /// both sides of it. In the straddling three-blob shape that cost the batch
    /// ALL THREE slots in one order while another order kept two. A blob that
    /// is not imported must not consume our `(peer,counter)` space.
    /// * Residual cost, stated plainly: two slots echoing the SAME pre-reset
    ///   history at overlapping counter ranges (e.g. one peer holding
    ///   `own@0..100` and another `own@0..150`) are indistinguishable from a
    ///   fork here, so the later slot is dropped and its content re-fetched by
    ///   the next session's snapshot catch-up. That shape needs two deliveries
    ///   to crash inside the post-RESET window, and the rule cannot fire at all
    ///   on a device that never reset (no peer holds ops under our peer id).
    ///
    /// A blob carrying nothing of ours (`partial_end_vv[own] == 0`) is never a
    /// lineage carrier and never takes part in the comparison.
    ///
    /// Returns one decision per blob, positionally. Callers must treat a
    /// non-[`ReplayBlobGate::Accept`] entry exactly as the single-row path
    /// treats a `Some(reason)` from the underlying guard: drop the slot and let
    /// the next live sync session route into snapshot catch-up.
    ///
    /// ## #3194 — [`ReplayBlobGate::Accept`] carries the blob's end frontier
    ///
    /// The base advances by `partial_end_vv`, which ASSUMES each blob's
    /// per-peer counter range is contiguous. A merged or hand-crafted blob with
    /// an internal gap breaks that assumption and would over-claim. (loro's own
    /// encoder will not produce one: asking `ExportMode::updates_in_range` for
    /// two non-adjacent spans of one peer panics in
    /// `loro-internal/src/oplog/change_store.rs` — "counter should be
    /// continuous" — at EXPORT time, and the poisoned doc mutex then turns the
    /// unwind into a destructor panic and SIGABRT. So the gapped shape needs a
    /// corrupt or third-party blob, and the parked-`pending_changes` case below
    /// is the reachable half of this.) The gate's
    /// admission logic is deliberately unchanged; instead every `Accept` hands
    /// the caller the end frontier the blob claims, so the caller can refuse to
    /// delete the durable inbox slot until the post-import `oplog_vv()`
    /// demonstrably reached it (`agaric-sync`'s `replay_inbox_batch`). Decoded
    /// exactly once, here, where the metadata already is.
    pub fn gate_replay_blobs(&self, blobs: &[&[u8]]) -> Vec<ReplayBlobGate> {
        // Cumulative reachability base — see fn docs.
        let mut base: std::collections::HashMap<PeerID, Counter> = self
            .doc
            .oplog_vv()
            .iter()
            .map(|(peer, counter)| (*peer, *counter))
            .collect();

        // One decision per blob, filled POSITIONALLY (the caller zips these
        // against its slots). `None` = not yet decided by the fixpoint.
        let mut out: Vec<Option<ReplayBlobGate>> = (0..blobs.len()).map(|_| None).collect();
        // Blobs whose reachability is still open, carrying their decoded
        // metadata so the fixpoint never re-decodes: `decode_import_blob_meta`
        // rebuilds the blob's whole change store and is by far the expensive
        // part of this gate.
        let mut pending: Vec<(usize, ImportBlobMetadata)> = Vec::with_capacity(blobs.len());

        // #792 / #3190 own-peer state, read ONCE: the gate never mutates the
        // doc, so this cannot drift while the sweep below runs.
        let own = self.doc.peer_id();
        let local_own = self.doc.oplog_vv().get(&own).copied().unwrap_or(0);
        // #3190: own-peer counter ranges `[start, end)` of the lineage-carrying
        // blobs accepted so far, with the slot index that contributed each.
        // Only populated (and only consulted) when `local_own == 0`.
        let mut own_lineage: Vec<(usize, Counter, Counter)> = Vec::new();

        for (i, bytes) in blobs.iter().enumerate() {
            // Decode failures are tolerated exactly as in the single-blob
            // guards: accept, and let the real import surface the error. The
            // base cannot be advanced for such a blob (no metadata), which is
            // conservative — a later blob may then be reported unreachable and
            // dropped rather than silently mis-imported. #3194: an ungated
            // accept claims NO end frontier, so it imposes no delete condition
            // on the caller either.
            let meta = match LoroDoc::decode_import_blob_meta(bytes, true) {
                Ok(meta) => meta,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "loro: gate_replay_blobs: blob meta decode failed; accepting \
                         the blob ungated (import will surface the real error)"
                    );
                    out[i] = Some(ReplayBlobGate::Accept { end_vv: Vec::new() });
                    continue;
                }
            };

            // #792, `local_counter > 0` form: our own ops are the lineage of
            // record, so this does not consult the cumulative reachability base
            // and is decided in this first sweep, never revisited. The
            // `local_counter == 0` (#3190) form is NOT decided here — it
            // compares blobs against each other, so it runs at the point a blob
            // is actually accepted, below.
            if local_own > 0 {
                let blob_end = meta.partial_end_vv.get(&own).copied().unwrap_or(0);
                if blob_end > local_own {
                    out[i] = Some(ReplayBlobGate::Fork(format!(
                        "(peer,counter) fork detected for own peer id {own} (#792): inbound \
                         blob carries our ops through counter {blob_end} but this doc only \
                         holds {local_own} — a pre-epoch snapshot RESET reused the \
                         deterministic peer id; importing would corrupt causal state. \
                         Snapshot catch-up required."
                    )));
                    continue;
                }
            }

            pending.push((i, meta));
        }

        // #3188 fixpoint: keep re-testing the undecided blobs against the
        // growing base until a whole pass accepts nothing new. Each pass but
        // the last strictly shrinks `pending`, so this terminates in at most
        // `pending.len() + 1` passes.
        let mut reasons: std::collections::HashMap<usize, String> =
            std::collections::HashMap::new();
        while !pending.is_empty() {
            let mut still_pending: Vec<(usize, ImportBlobMetadata)> =
                Vec::with_capacity(pending.len());
            let mut accepted_any = false;
            for (i, meta) in pending {
                if let Some(reason) = replay_base_miss(&base, &meta) {
                    // Keep only the LAST reason: it is the one computed against
                    // the widest base, i.e. the gap that actually survived.
                    reasons.insert(i, reason);
                    still_pending.push((i, meta));
                    continue;
                }
                // #3190: reachable, so this blob is about to become part of the
                // batch's accepted history. On a doc with no own ops that
                // accepted history is the ONLY lineage of our peer id the batch
                // can contradict, so compare against it here — at the accept
                // site, never in the first sweep. A blob that is ultimately
                // dropped as `Unreachable` is never imported and must not
                // consume our (peer,counter) space; deciding this early let one
                // do exactly that, and forked otherwise-legitimate blobs on
                // both sides of it.
                if local_own == 0 {
                    let blob_end = meta.partial_end_vv.get(&own).copied().unwrap_or(0);
                    if blob_end > 0 {
                        let blob_start = meta.partial_start_vv.get(&own).copied().unwrap_or(0);
                        let clash = own_lineage
                            .iter()
                            .find(|(_, start, end)| blob_start.max(*start) < blob_end.min(*end))
                            .copied();
                        if let Some((j, start, end)) = clash {
                            out[i] = Some(ReplayBlobGate::Fork(format!(
                                "(peer,counter) fork detected for own peer id {own} \
                                 (#792/#3190): this doc holds no ops of its own, and \
                                 batch blob {i} claims our peer at counters \
                                 [{blob_start},{blob_end}) which OVERLAP the [{start},{end}) \
                                 already accepted from batch blob {j} — two divergent \
                                 lineages cannot share our (peer,counter) space, and blob \
                                 metadata cannot prove they are the same one. Importing \
                                 both would let loro skip the overlap and apply the rest \
                                 against the wrong causal prefix. Snapshot catch-up \
                                 required."
                            )));
                            // Not accepted ⇒ not imported ⇒ must NOT advance the
                            // cumulative base, and must not be retried.
                            continue;
                        }
                        own_lineage.push((i, blob_start, blob_end));
                    }
                }
                // Accepted ⇒ its ops will be in the oplog once the batch import
                // settles, so advance the cumulative base by its end frontier.
                // #3194: hand that same frontier back to the caller — it is the
                // condition the post-import oplog must meet before the blob's
                // durable inbox slot may be deleted. #3213: built by the shared
                // `declared_end_vv` (zero-counter entries dropped — nothing to
                // demand), so the batch gate and the live/per-row
                // `screen_inbound_blob` cannot disagree about what a blob
                // declared.
                let end_vv = declared_end_vv(&meta);
                for (peer_id, &end_counter) in meta.partial_end_vv.iter() {
                    base.entry(*peer_id)
                        .and_modify(|c| {
                            if end_counter > *c {
                                *c = end_counter;
                            }
                        })
                        .or_insert(end_counter);
                }
                out[i] = Some(ReplayBlobGate::Accept { end_vv });
                accepted_any = true;
            }
            pending = still_pending;
            if !accepted_any {
                break;
            }
        }

        // Fixpoint reached: nothing left in `pending` can ever become reachable
        // from this batch.
        for (i, _) in pending {
            let reason = reasons.remove(&i).unwrap_or_else(|| {
                "boot-replay update base unreachable (#1054): no reason recorded".to_string()
            });
            out[i] = Some(ReplayBlobGate::Unreachable(reason));
        }

        out.into_iter()
            .map(|decision| {
                // Unreachable in practice — every index is decided above. Fall
                // back to the conservative verdict (drop the slot, let the next
                // sync session snapshot-catch-up) rather than panicking on the
                // crash-recovery path.
                decision.unwrap_or_else(|| {
                    ReplayBlobGate::Unreachable(
                        "boot-replay gate reached no verdict for this blob (#3188 bug)".to_string(),
                    )
                })
            })
            .collect()
    }

    /// #3194 — does this doc's op-log demonstrably cover `end_vv`?
    ///
    /// `end_vv` is the `(peer, counter)` frontier a blob claimed at gate time
    /// (see [`ReplayBlobGate::Accept`]). Both sides are `VersionVector`
    /// counters, i.e. EXCLUSIVE ends, so the claim is met iff the local counter
    /// is `>=` the claimed one — no `+1` (that asymmetry belongs to
    /// `Frontiers`, which are inclusive last-op ids; see `replay_base_miss`).
    ///
    /// Returns `Some(reason)` for the FIRST unmet entry. Two things make a
    /// claim go unmet after an apparently successful import:
    ///
    /// * the blob's per-peer counter range was not contiguous, so the gate's
    ///   base (and this claim) over-reached what the ops actually cover, and
    /// * loro parked some of the changes in `pending_changes` for missing deps
    ///   (`ImportStatus { pending: Some(..) }`) — pending changes are NOT in
    ///   the op-log, so `oplog_vv()` does not advance over them.
    ///
    /// Either way the blob's content is not in the projection, so a caller must
    /// keep its durable record: never delete one until its content committed
    /// (#535).
    pub fn oplog_shortfall(&self, end_vv: &[(PeerID, Counter)]) -> Option<String> {
        let local = self.doc.oplog_vv();
        for (peer_id, needed) in end_vv {
            if *needed <= 0 {
                continue;
            }
            let have = local.get(peer_id).copied().unwrap_or(0);
            if have < *needed {
                return Some(format!(
                    "post-import oplog does not cover the blob's end frontier (#3194): \
                     requires peer={peer_id} counter>={needed}, oplog_vv has {have}"
                ));
            }
        }
        None
    }
}

/// #1054 / #3189 — is `meta`'s causal base missing from the cumulative `base`?
///
/// Returns `Some(reason)` iff the blob is update-shaped and some part of its
/// causal base is not covered. Snapshot-shaped blobs (`meta.mode.is_snapshot()`,
/// which covers `Snapshot`, `ShallowSnapshot` and `OutdatedSnapshot` —
/// `loro-internal-1.13.6/src/encoding.rs:507-517`) are self-contained: they
/// carry their own causal base, and are never reachability-checked — the same
/// carve-out [`LoroEngine::unreachable_update_in_blob`] and the live
/// `apply_remote` gate make.
///
/// ## The snapshot carve-out must come FIRST, before either half below
///
/// Not merely an optimisation: for a snapshot blob `start_frontiers` does not
/// mean "dependencies" at all. `decode_snapshot_blob_meta` sets it to the
/// snapshot's `shallow_since_frontiers`
/// (`loro-internal-1.13.6/src/encoding/fast_snapshot.rs:404-419`) — the point
/// its history was TRUNCATED at, ops the receiver by definition does not hold.
/// Running the half-2 check on it would report every shallow snapshot
/// unreachable and drop its slot. Pinned by
/// `gate_replay_blobs_accepts_shallow_snapshot_despite_start_frontiers_3189`.
/// (Only `Snapshot` / `ShallowSnapshot` / `Updates` can actually reach here:
/// `decode_import_blob_meta` returns `ImportUnsupportedEncodingMode` for the
/// two `Outdated*` modes — `encoding.rs:546-553` — which the caller treats as
/// a decode failure and accepts ungated.)
///
/// Two INDEPENDENT halves of an update blob's base are checked:
///
/// * `partial_start_vv` — the blob's OWN-peer counter ranges. Entry
///   `(peer, c)` means "this blob's first change for `peer` starts at counter
///   `c`", so the base must already hold `>= c`. A `0`-counter entry carries no
///   ops and is trivially reachable.
/// * `start_frontiers` (#3189) — the blob's CROSS-peer dependencies: the op ids
///   its changes depend on that the blob does NOT itself carry. loro builds this
///   in `decode_updates_blob_meta`
///   (`loro-internal-1.13.6/src/encoding/fast_snapshot.rs:456-467`) by pushing
///   every change dep whose peer either starts later in this blob than the dep,
///   or does not appear in the blob at all. `partial_start_vv` never sees the
///   second (genuinely cross-peer) case, which is exactly the #3189 hole.
///
/// ## Counter semantics — CONFIRMED against the pinned loro source, not assumed
///
/// A `Frontiers` entry is an `ID { peer, counter }` whose counter is the LAST
/// op's counter (INCLUSIVE); a `VersionVector` counter is an EXCLUSIVE end.
/// Verified in `loro-internal` 1.13.6 (the version pinned in `Cargo.lock`):
///
/// * `version.rs:171-173` — `last_id_to_vv_end(id) = id.counter + 1`, the sole
///   conversion used by `VersionVector::set_last` /
///   `extend_to_include_last_id` (`version.rs:265-289`) when folding a frontier
///   id into a vv.
/// * `version.rs:290-296` — `VersionVector::includes_id(id)` is
///   `vv[id.peer] > id.counter`, i.e. an id is covered only once the vv end has
///   passed it.
/// * `oplog/loro_dag.rs:1228-1250` — `vv_to_frontiers` round-trips the other
///   way as `ID::new(peer, vv_counter - 1)`.
///
/// So a dep `ID { peer, counter }` is covered iff `base[peer] >= counter + 1`.
/// Requiring `>= counter` instead would let a blob through whose last needed op
/// we do not hold (silent #535 gap); requiring `>= counter + 2` would drop good
/// data.
fn replay_base_miss(
    base: &std::collections::HashMap<PeerID, Counter>,
    meta: &ImportBlobMetadata,
) -> Option<String> {
    if meta.mode.is_snapshot() {
        return None;
    }

    // Half 1 — own-peer counter ranges (vv counters are exclusive ends, so the
    // base must hold at least `base_counter`).
    for (peer_id, &base_counter) in meta.partial_start_vv.iter() {
        if base_counter == 0 {
            continue;
        }
        match base.get(peer_id) {
            Some(&have) if have >= base_counter => continue,
            Some(&have) => {
                return Some(format!(
                    "boot-replay update base unreachable (#1054): requires \
                     peer={peer_id} counter>={base_counter}, batch base has \
                     counter={have}"
                ));
            }
            None => {
                return Some(format!(
                    "boot-replay update base unreachable (#1054): requires \
                     peer={peer_id} counter>={base_counter}, batch base has no \
                     entry for that peer"
                ));
            }
        }
    }

    // Half 2 (#3189) — cross-peer deps. Frontier counters are INCLUSIVE last-op
    // ids, so the required vv end is `counter + 1` (see the doc comment).
    for dep in meta.start_frontiers.iter() {
        if dep.counter < 0 {
            // Defensive only — NOT reachable from any blob loro can encode: a
            // change dep is a real op id, and even loro's `ID::NONE_ID`
            // sentinel uses counter `0` (`loro-common-1.13.1/src/id.rs:117`).
            // Note this SKIPS (treats as covered), which is the opposite of
            // loro's `VersionVector::includes_id` (`version.rs:290-296`), where
            // a negative counter is never included. Skipping is chosen
            // deliberately: on the #535 crash-recovery path a bogus
            // `counter + 1` requirement derived from an impossible input would
            // drop a real slot, and dropping data on unreachable input is the
            // worse failure.
            continue;
        }
        let need = dep.counter.saturating_add(1);
        let peer_id = dep.peer;
        match base.get(&peer_id) {
            Some(&have) if have >= need => continue,
            Some(&have) => {
                return Some(format!(
                    "boot-replay update cross-peer dep unreachable (#1054/#3189): \
                     requires peer={peer_id} counter>={need}, batch base has \
                     counter={have}"
                ));
            }
            None => {
                return Some(format!(
                    "boot-replay update cross-peer dep unreachable (#1054/#3189): \
                     requires peer={peer_id} counter>={need}, batch base has no \
                     entry for that peer"
                ));
            }
        }
    }

    None
}

/// #792 — the fork rule, applied to ALREADY-DECODED blob metadata.
///
/// Split out so [`LoroEngine::own_peer_fork_in_blob`] and
/// [`LoroEngine::screen_inbound_blob`] cannot drift: there is exactly one
/// statement of what a fork is, and the two public forms differ only in how
/// many facts they recover from the one decode. See
/// [`LoroEngine::own_peer_fork_in_blob`] for the full rationale.
///
/// `local_counter` is the doc's own-peer `oplog_vv()` entry (`0` when this doc
/// never minted an op under `own`, which is the "nothing to collide with"
/// carve-out).
fn own_peer_fork_in_meta(
    own: PeerID,
    local_counter: Counter,
    meta: &ImportBlobMetadata,
) -> Option<String> {
    if local_counter == 0 {
        return None;
    }
    let blob_counter = meta.partial_end_vv.get(&own).copied().unwrap_or(0);
    if blob_counter > local_counter {
        return Some(format!(
            "(peer,counter) fork detected for own peer id {own} (#792): inbound blob \
             carries our ops through counter {blob_counter} but this doc only holds \
             {local_counter} — a pre-epoch snapshot RESET reused the deterministic \
             peer id; importing would corrupt causal state. Snapshot catch-up required."
        ));
    }
    None
}

/// #3194 / #3213 — the end frontier a decoded blob DECLARES, in the
/// `(peer, EXCLUSIVE-end-counter)` form [`LoroEngine::oplog_shortfall`] compares
/// against.
///
/// `ImportBlobMetadata::partial_end_vv` is a `VersionVector`, so its counters
/// are already exclusive ends — no `+1` conversion belongs here (that asymmetry
/// is `Frontiers`-only; see `replay_base_miss`). Zero-counter entries carry no
/// ops and are dropped: there is nothing to demand of the op-log for them.
///
/// Single definition shared by [`LoroEngine::gate_replay_blobs`] (batch,
/// via [`ReplayBlobGate::Accept`]) and [`LoroEngine::screen_inbound_blob`]
/// (live + per-row), so the two paths cannot come to mean different things by
/// "the frontier this blob declared".
fn declared_end_vv(meta: &ImportBlobMetadata) -> Vec<(PeerID, Counter)> {
    meta.partial_end_vv
        .iter()
        .filter_map(|(peer, &counter)| (counter > 0).then_some((*peer, counter)))
        .collect()
}

/// #3213 — what [`LoroEngine::screen_inbound_blob`] recovers from one blob-meta
/// decode: the #792 fork verdict plus the blob's declared end frontier.
#[derive(Debug, Clone, Default)]
pub struct InboundBlobScreen {
    /// `Some(reason)` iff the blob forks our own `(peer, counter)` history and
    /// must NOT be imported — identical to
    /// [`LoroEngine::own_peer_fork_in_blob`]'s verdict.
    pub fork: Option<String>,
    /// The `(peer, exclusive-end-counter)` frontier the blob declared, for
    /// [`LoroEngine::oplog_shortfall`]. EMPTY means "no condition" — either the
    /// blob declares nothing (no ops) or its metadata would not decode.
    pub declared_end_vv: Vec<(PeerID, Counter)>,
}

/// #3164 — per-blob verdict from [`LoroEngine::gate_replay_blobs`].
///
/// The two rejection arms carry the same *action* (drop the slot) but are kept
/// distinct so the caller can log the same two messages the per-row path logs,
/// keeping existing log greps and the #792 / #1054 audit trail intact.
#[derive(Debug, Clone)]
pub enum ReplayBlobGate {
    /// Safe to include in the batch import.
    Accept {
        /// #3194 — the `(peer, exclusive-end-counter)` frontier this blob
        /// claims (`ImportBlobMetadata::partial_end_vv`, zero entries dropped).
        ///
        /// The gate advanced its cumulative base by exactly this, which assumes
        /// the blob's per-peer counter ranges are contiguous. Callers that
        /// delete a durable record on the strength of an accept must re-check
        /// it against the POST-import `oplog_vv()` — a blob with an internal
        /// gap, or one whose changes loro parked in `pending_changes`, does not
        /// reach it, and its record must survive (#535).
        end_vv: Vec<(PeerID, Counter)>,
    },
    /// #792 / #3190 — the blob forks our own `(peer, counter)` history.
    Fork(String),
    /// #1054 — the blob is update-shaped and its causal base is unreachable.
    Unreachable(String),
}

#[cfg(test)]
mod screen_inbound_blob_tests {
    //! #3443: contract pins for the one-decode inbound screen (#3213) that
    //! `sync_protocol::loro_sync::apply_remote` reads its fork verdict and its
    //! slot-delete condition off.
    use super::{Counter, LoroEngine, PeerID, VersionVector};

    fn own_counter(e: &LoroEngine) -> Counter {
        VersionVector::decode(&e.version_vector())
            .unwrap()
            .get(&e.peer_id())
            .copied()
            .unwrap()
    }

    /// Reddens if the screen stops reporting the blob's declared end frontier,
    /// or starts forking a blob another peer minted while we hold ops of our
    /// own.
    #[test]
    fn screen_inbound_blob_reports_declared_frontier_and_no_fork_3443() {
        let mut a = LoroEngine::with_peer_id("DEV-A").unwrap();
        let mut b = LoroEngine::with_peer_id("DEV-B").unwrap();
        // b mints an op of its own first: at a zero own-counter the fork guard
        // short-circuits, so a `None` verdict would prove nothing.
        b.apply_create_block_at("BB", "leaf", "b", None, 0).unwrap();
        a.apply_create_block_at("AA", "page", "a", None, 0).unwrap();
        a.apply_create_block_at("AB", "leaf", "a", Some("AA"), 0)
            .unwrap();
        let update = a.export_update_since(&b.version_vector()).unwrap();
        let declared = vec![(a.peer_id(), own_counter(&a))];

        let screen = b.screen_inbound_blob(&update);
        assert_eq!(screen.fork, None);
        assert_eq!(screen.declared_end_vv, declared);

        // Boot replay re-screens a slot whose ops the doc already holds (#535),
        // so the same bytes must still declare the same frontier.
        b.import(&update).unwrap();
        let again = b.screen_inbound_blob(&update);
        assert_eq!(again.fork, None);
        assert_eq!(again.declared_end_vv, declared);
    }

    /// Reddens if the screen stops applying the #792 fork rule to a blob that
    /// carries our own peer id beyond the counter this doc holds, or misreports
    /// either counter in the reason the caller logs.
    #[test]
    fn screen_inbound_blob_flags_own_peer_fork_3443() {
        let mut forked = LoroEngine::with_peer_id("DEV-OWN").unwrap();
        for i in 0..3usize {
            forked
                .apply_create_block_at(&format!("F{i}"), "leaf", "f", None, i)
                .unwrap();
        }
        let blob = forked.export_snapshot().unwrap();

        let mut local = LoroEngine::with_peer_id("DEV-OWN").unwrap();
        local
            .apply_create_block_at("L0", "leaf", "l", None, 0)
            .unwrap();

        let own = local.peer_id();
        let blob_counter = own_counter(&forked);
        let local_counter = own_counter(&local);
        assert_eq!(
            local.screen_inbound_blob(&blob).fork,
            Some(format!(
                "(peer,counter) fork detected for own peer id {own} (#792): inbound blob \
                 carries our ops through counter {blob_counter} but this doc only holds \
                 {local_counter} — a pre-epoch snapshot RESET reused the deterministic \
                 peer id; importing would corrupt causal state. Snapshot catch-up required."
            ))
        );
    }

    /// Reddens if a blob whose metadata will not decode stops falling back to
    /// `InboundBlobScreen::default()` — no fork, no slot-delete condition.
    #[test]
    fn screen_inbound_blob_undecodable_blob_is_default_3443() {
        let screen = LoroEngine::new().screen_inbound_blob(b"not a loro blob");
        assert_eq!(screen.fork, None);
        assert_eq!(screen.declared_end_vv, Vec::<(PeerID, Counter)>::new());
    }
}
