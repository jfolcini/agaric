# Session 4098 — a synced purge keeps the blocks this device added, in the Trash (#6561)

When device A deleted a page and emptied its Trash while device B, out of contact, added blocks under it, B's next pull hard-deleted B's blocks. The maintainer decided on 2026-11-13 that B keeps that text in its Trash and says so. The design note is on the issue; this is what the build found.

## Decisions and traps

- **A block under a purged page is not gone in Loro.** A purge is `tree.delete` of one node; a child keeps its node and its parent pointer, and `tree.mov` accepts it (only a node whose own parent is the deleted root is refused). So the rescue moves the block itself: same id, text, properties and tags. Nothing is copied.
- **"Never seen by the purge" is read from the doc.** A node id is its creation op. `cmp_frontiers(delete op, creation op)` is `None` when the purging device had not received the block and `Greater` when it had; the delete op is `get_last_move_id` of the deleted node at the top of the chain. Only `None` keeps a block: anything else purges, or two devices would trade a block back and forth.
- **Only what the purge never saw, all the way down.** A block the other device had received can sit under a new block here (indented offline). Moved along, it would come back without the properties and tags the purge had deleted, so the rescue deletes it again after the move, and its text does not count when deciding whether a blank block is worth keeping. An independent review found this.
- **The rescue is saved at once.** Its ops are in no op log, so after a crash the engine would mint its next op under ids a peer may already hold. The space is saved right after the import, as `mirror_sql_tombstones_onto_engine` does for the same reason; the inbox row replays the import if the save fails.
- **`blocks.page_id` is derived in the background, and the session-end sweep does not wait for it.** A kept block still named the purged page when the sweep deleted that page, and the sweep failed on the foreign key. The import now restamps the kept page's subtree in its own transaction. The crash-replay path does not (it has no list of kept pages); there the rebuild that boot replay arms does it before the next sweep, or that sweep fails once and the next one passes.
- **A page moved to another space leaves its old doc as a purge does**, so blocks added under it meanwhile land in the old space's Trash, and the toast says "deleted or moved".
- **Not kept:** an offline edit to a block the other device already had. The toast says "the blocks you added" for that reason.
- **A debugging trap:** `PRAGMA foreign_keys = OFF` also turns off `ON DELETE CASCADE`, so a foreign-key check run that way reports rows the real purge would have removed. Check inside a transaction with keys on.

## Shipped

`agaric-engine/src/loro/engine/keep.rs` and its call in the import; `ImportDelta.kept` and `ApplyOutcome::Imported.kept`; `SyncEvent::LocalTextKept` with its event name in the bindings; the emit in the pull session and in the snapshot catch-up; `useSyncLocalTextKept` and its toast; `docs/FEATURE-MAP.md`, `docs/features/sync.md`, `docs/architecture/data-and-events.md`.

## What ran

Each test below was shown red once by breaking the line it covers, one mutation per command.

- Engine, 12 tests in `keep.rs`: kept under a Trash page; received, foreign, moved-in and blank blocks purged; the two title rules and the fallback; grouping per purged page; a received block does not ride back; convergence and a final purge.
- Two devices over the real commands, 4 tests in `src/spaces/tests.rs`: Trash listing, restore and the saved snapshot; convergence over three rounds in both directions and a later purge; the unchanged case; the event over a real QUIC session. One more for the snapshot catch-up in `snapshot_transfer_tests.rs`.
- `useSyncLocalTextKept`: 3 vitest cases.
- The full gates are listed in the pull request.
