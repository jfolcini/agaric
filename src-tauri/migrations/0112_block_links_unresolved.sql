-- #4118: a durable reverse index of link tokens that a reindex parsed out of
-- `blocks.content` but could NOT turn into a `block_links` edge.
--
-- mock-unaffected: `block_links_unresolved` is backend-only derived state with
-- no IPC surface. The JS Tauri mock recomputes links from its in-memory
-- blocks/links stores and reads no such table, so nothing in the mock changes.
--
-- # Why the table exists
--
-- `reindex_block_links_conn` (agaric-store/src/cache/block_links.rs) is an
-- incremental diff keyed on ONE trigger: a change to the SOURCE block's
-- content. Its INSERT drops any parsed token whose target is not yet
-- *linkable* — the `WHERE EXISTS (… AND deleted_at IS NULL)` guard (the target
-- row must exist and be live) and the cross-space filter (the target's
-- resolved space must equal the source's; a target whose `space_id` has not
-- been stamped yet resolves to NULL and `NULL = ?3` is falsy).
--
-- Both of those conditions are about the TARGET, and the target can satisfy
-- them LATER: it can be created after the referrer (ordinary on an
-- out-of-order remote replay — a peer can deliver the referrer before the
-- referent), and its `space_id` is stamped post-commit by `SetBlockPageId`.
-- Nothing re-ran the source's reindex when that happened, and there is no
-- vault-wide `rebuild_block_links` behind it (`truncate_block_links`' only
-- caller is agaric-sync's snapshot-restore wipe), so the edge was lost
-- PERMANENTLY — until the source's content happened to be edited again.
--
-- The fix needs a reverse lookup from "target that just became linkable" to
-- "sources that name it". `block_links` cannot serve as that index: it IS the
-- reverse index, and the missing row is precisely what is being looked up.
-- `blocks.content` cannot either — a `LIKE '%' || target || '%'` scan is
-- O(vault) per created block, i.e. O(vault²) for an import — and neither can
-- `fts_blocks`, whose `stripped` text replaces `[[ULID]]` with the target's
-- TITLE (agaric-store/src/fts/strip.rs), erasing the ULID it would be probed
-- by. So the dropped edges get their own index, written by the same diff that
-- drops them.
--
-- # Shape
--
-- `source_id` carries the same `REFERENCES blocks(id) ON DELETE CASCADE` as
-- `block_links.source_id`: a purged source owes nothing.
--
-- `target_id` deliberately carries NO foreign key. That is the entire point of
-- the table — a row exists exactly because the target may not be in `blocks`
-- yet. An FK here would make the table unable to hold the rows it is for.
--
-- Rows are self-correcting rather than accumulating: every reindex of a source
-- recomputes the source's whole unresolved set from its current content and
-- the post-diff `block_links` rows, so a token that resolves, or that leaves
-- the content, drops out. A genuinely dangling reference (a typo, a purged
-- target) sits inert and costs one row.
CREATE TABLE IF NOT EXISTS block_links_unresolved (
    source_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
) STRICT;

-- The whole reason the table exists: "which sources name this target?",
-- answered by an index seek when the target becomes linkable. `source_id` is
-- covered so the lookup never touches the table itself. The PRIMARY KEY's
-- implicit index already answers the source-keyed maintenance direction.
CREATE INDEX IF NOT EXISTS idx_block_links_unresolved_target
    ON block_links_unresolved(target_id, source_id);
