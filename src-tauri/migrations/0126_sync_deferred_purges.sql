-- #5712 — the blocks an inbound sync import saw leave a space's doc, held
-- until the pull session ends. A page moved to another space leaves its old
-- doc exactly as a purged one does, and the new doc may land later in the
-- same session; the session's end purges only the ids no engine then holds.
-- Device-local: nothing syncs or exports it. A row outlives a crash, so the
-- next completed pull sweeps it, and a local purge drops it with its block.
CREATE TABLE sync_deferred_purges (
    block_id TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE
) STRICT;
