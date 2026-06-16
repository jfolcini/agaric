//! Sync-update generation and inbound-blob inspection for [`LoroEngine`].
//!
//! `version_vector` / `export_update_since` produce the delta stream;
//! `own_peer_fork_in_blob` (#792) and `unreachable_update_in_blob` (#1054)
//! pre-screen an inbound blob before importing it.

use super::*;

impl LoroEngine {
    /// Encode the doc's current op-log version vector for transport
    /// over the wire.
    ///
    /// Wraps `LoroDoc::oplog_vv()` and serialises the result via
    /// `VersionVector::encode()` (Loro 1.12 wire-stable). Used by sync
    /// push to (a) advertise the local frontier and (b) build the
    /// `from_vv` field of
    /// [`crate::sync_protocol::loro_sync_types::LoroSyncMessage::Update`]
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
    /// [`crate::sync_protocol::loro_sync_types::LoroSyncMessage::Snapshot`]
    /// in that case.
    pub fn export_update_since(&self, since_vv: &[u8]) -> Result<Vec<u8>, AppError> {
        let vv = VersionVector::decode(since_vv).map_err(|e| {
            AppError::Validation(format!("loro: export_update_since: decode vv: {e}"))
        })?;
        self.doc
            .export(ExportMode::updates(&vv))
            .map_err(|e| AppError::Validation(format!("loro: export_update_since: {e}")))
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
    /// #1054 — detect an *update*-shaped blob whose causal base is NOT
    /// reachable from this doc's current `oplog_vv()`, BEFORE importing it.
    ///
    /// ## Why this mirrors the live MAINT-228 gate
    ///
    /// [`crate::sync_protocol::loro_sync::apply_remote`] runs the MAINT-228
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
        // (the live MAINT-228 gate only checks Update variants). Skip them.
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
}
