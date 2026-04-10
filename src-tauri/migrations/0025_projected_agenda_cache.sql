-- P-16: Pre-computed projected dates for repeating tasks.
-- Eliminates the on-the-fly O(n*m) projection loop in list_projected_agenda.
CREATE TABLE IF NOT EXISTS projected_agenda_cache (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    projected_date TEXT NOT NULL,  -- YYYY-MM-DD
    source TEXT NOT NULL,          -- 'due_date' or 'scheduled_date'
    PRIMARY KEY (block_id, projected_date, source)
);

CREATE INDEX IF NOT EXISTS idx_projected_agenda_date
    ON projected_agenda_cache(projected_date);
