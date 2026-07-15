//! #2604 — rollback-safe engine-apply staging primitives for [`LoroEngine`].
//!
//! ## The invariant this exists to serve
//!
//! In the command write path, op_log + SQL `blocks` commit atomically in one
//! `BEGIN IMMEDIATE` transaction, but the in-memory Loro engine is mutated
//! OUTSIDE that transaction (`materializer/handlers/loro_apply.rs`). A COMMIT
//! failure (or crash) between the engine apply and SQL COMMIT leaves the engine
//! AHEAD of committed SQL — the divergence class behind #2504 / #2509 that
//! #2603's crash-injection test pins.
//!
//! The target design (#2604) makes the engine apply transactional-by-
//! construction: stage the mutation against a checkpoint / fork of the per-space
//! `LoroDoc`, and only PROMOTE it to the canonical in-memory engine after SQL
//! COMMIT succeeds; on abort, DISCARD the staged mutation. This module provides
//! the checkpoint + fork building block; the promote-on-commit wiring into
//! `CommandTx::commit_and_dispatch` is the follow-up write-path change.
//!
//! ## Peer-identity contract (why [`Self::fork_staging`] re-pins the peer id)
//!
//! `LoroDoc::fork` "duplicates the document with a DIFFERENT PeerID". Left as-is
//! that is a correctness landmine for a promote-by-delta scheme: an op applied
//! to a foreign-peer fork would be credited to a throwaway peer, and importing
//! its delta into the canonical doc would inject an op under a peer id that is
//! NOT this device's — breaking the `device_id → peer_id` stability contract
//! ([`peer_id_from_device_id`]) that sync accounting, `export_update_since`, and
//! the #792 fork guards all rest on. [`Self::fork_staging`] therefore re-pins the
//! staging doc's peer id to the source engine's peer id, so a staged op lands at
//! `(own_peer, next_counter)` — byte-for-byte what a direct apply would mint —
//! and its delta imports back into the canonical doc as a contiguous
//! continuation of this device's own history.

use super::*;

impl LoroEngine {
    /// Fork this engine into an independent **staging** engine that a
    /// speculative op can be applied to without touching the canonical
    /// in-memory state (#2604).
    ///
    /// The returned engine:
    /// - shares NO mutable state with `self` — Loro's `fork` performs an
    ///   `O(n)`-time / `O(n)`-space copy of the document (see the `LoroDoc::fork`
    ///   contract), so a mutation on the fork does not affect `self` and vice
    ///   versa;
    /// - is re-pinned to `self`'s peer id (see the module docs' peer-identity
    ///   contract) so a staged op mints at `(own_peer, next_counter)`, identical
    ///   to a direct apply, and promotes back as a contiguous own-history delta;
    /// - has its `block_id → TreeID` index rebuilt from the forked tree, so the
    ///   read-back surface (`read_block`, `children_ordered_block_ids`, …) the
    ///   SQL projection depends on works against the staged state.
    ///
    /// ## Promote / discard
    ///
    /// After staging an op, capture the promotable delta with
    /// [`Self::version_vector`] taken on `self` BEFORE the fork and
    /// [`Self::export_update_since`] on the staging engine AFTER the apply; feed
    /// that delta to `self`'s [`Self::import`] to PROMOTE it once SQL COMMIT
    /// succeeds. To DISCARD, simply drop the staging engine — `self` was never
    /// mutated.
    ///
    /// ## Cost
    ///
    /// The `O(n)` fork is the dominant cost and is why #2604 gates the mechanism
    /// on a per-op-overhead benchmark (`benches/engine_checkpoint_bench.rs`)
    /// against the interactive SLO before the write-path wiring lands. For large
    /// per-space docs a lighter checkpoint scheme (capture delta, replay-inverse
    /// on abort) may be preferred; this primitive measures the full-fork upper
    /// bound.
    pub fn fork_staging(&self) -> Result<LoroEngine, AppError> {
        let doc = self.doc.fork();
        // Re-pin the peer id to this device's peer so a staged op lands at
        // `(own_peer, next_counter)` — see the module-level peer-identity
        // contract. `fork` gives the doc a fresh random peer; re-pinning is what
        // makes the promote-by-delta path preserve device identity.
        doc.set_peer_id(self.doc.peer_id()).map_err(|e| {
            AppError::validation(format!("loro: fork_staging: re-pin peer id: {e}"))
        })?;
        let mut staged = LoroEngine {
            doc,
            index: HashMap::new(),
            // The fork copies the tree but not this in-memory reconciliation
            // intent; `rebuild_index` below reconciles it against the forked
            // tree, so start empty rather than cloning stale intent.
            pending_parent: HashMap::new(),
        };
        // Rebuild the `block_id → TreeID` index from the forked tree — the fork
        // copied the document but not `self`'s incrementally-maintained index.
        staged.rebuild_index();
        Ok(staged)
    }
}

#[cfg(test)]
mod tests {
    use super::LoroEngine;

    /// A staged apply on the fork must NOT be visible on the source engine
    /// (discard-by-drop is the whole point): the source is untouched until an
    /// explicit promote.
    #[test]
    fn fork_staging_isolates_the_source_until_promote() {
        let mut source = LoroEngine::with_peer_id("DEV-A").expect("source");
        source
            .apply_create_block("BASE", "content", "base", None, 0)
            .expect("seed base");

        // Capture the promote checkpoint on the SOURCE before forking.
        let checkpoint = source.version_vector();

        // Stage a create on the fork.
        let mut staging = source.fork_staging().expect("fork_staging");
        staging
            .apply_create_block("STAGED", "content", "staged", Some("BASE"), 0)
            .expect("stage create");

        // The staged block is visible on the fork…
        assert!(
            staging.read_block("STAGED").expect("read staged").is_some(),
            "staged block must exist on the fork"
        );
        // …but NOT on the source (no promote yet).
        assert!(
            source.read_block("STAGED").expect("read source").is_none(),
            "discard-by-drop: the source must be untouched until an explicit promote"
        );

        // Promote: import the fork's delta-since-checkpoint into the source.
        let delta = staging
            .export_update_since(&checkpoint)
            .expect("export delta");
        source.import(&delta).expect("promote delta");

        // Now the source converges on the staged block, under this device's
        // OWN peer id (peer-identity contract) — a contiguous own-history op.
        let promoted = source
            .read_block("STAGED")
            .expect("read promoted")
            .expect("source holds the staged block after promote");
        assert_eq!(promoted.content, "staged");
        assert_eq!(
            promoted.parent_id.as_deref(),
            Some("BASE"),
            "promoted block keeps its parent linkage"
        );
    }

    /// The staging fork re-pins the peer id to the source's, so a staged op is
    /// credited to this device's peer (NOT the fork's fresh random peer) — the
    /// property the promote-by-delta path relies on to preserve device identity.
    #[test]
    fn fork_staging_repins_peer_id_to_source() {
        let source = LoroEngine::with_peer_id("DEV-A").expect("source");
        let staging = source.fork_staging().expect("fork_staging");
        assert_eq!(
            staging.peer_id(),
            source.peer_id(),
            "the staging fork must continue the source device's peer identity"
        );
    }

    /// Discard is a pure drop: staging a mutation and dropping the fork leaves
    /// the source byte-identical (same live-block count, same content).
    #[test]
    fn fork_staging_discard_leaves_source_unchanged() {
        let mut source = LoroEngine::with_peer_id("DEV-A").expect("source");
        source
            .apply_create_block("KEEP", "content", "keep", None, 0)
            .expect("seed");
        let before = source.count_alive_blocks().expect("count before");

        {
            let mut staging = source.fork_staging().expect("fork_staging");
            staging
                .apply_create_block("DROP-ME", "content", "gone", None, 1)
                .expect("stage");
            // Drop `staging` here — the discard path.
        }

        assert_eq!(
            source.count_alive_blocks().expect("count after"),
            before,
            "dropping the staging fork must not change the source's live-block count"
        );
        assert!(
            source.read_block("DROP-ME").expect("read").is_none(),
            "a discarded staged block must never appear on the source"
        );
    }
}
