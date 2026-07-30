-- #3160 — make the warm-cache projected-agenda read O(page) instead of
-- O(rows sharing the window's first date).
--
-- `list_projected_agenda_inner`'s cache query is
--
--     SELECT pac.block_id, pac.projected_date, pac.source, b.*
--     FROM projected_agenda_cache pac JOIN blocks b ON b.id = pac.block_id
--     WHERE pac.projected_date BETWEEN ?1 AND ?2 AND …
--     ORDER BY pac.projected_date ASC, pac.block_id ASC
--     LIMIT ?6
--
-- `idx_projected_agenda_date` (migration 0025) indexes only the leading
-- ORDER BY term, so SQLite satisfied `projected_date` from the index and
-- sorted the trailing `block_id` term in a temp B-tree
-- ("USE TEMP B-TREE FOR LAST TERM OF ORDER BY").  A partial sort still has
-- to materialise, join and sort EVERY row sharing the window's first date
-- before it can emit the first page, so the read cost scaled with the
-- vault (n/7 rows on a 7-day window over a weekly-recurrence fixture:
-- 13 333 rows at the 100K tier, ~24 ms) rather than with the page size.
--
-- Widening the index to the full `(projected_date, block_id)` ORDER BY
-- key — plus `source`, the only other `pac` column the SELECT reads, which
-- makes the index covering for `pac` — lets the index supply the complete
-- sort order.  The temp B-tree disappears, LIMIT short-circuits the scan
-- after `limit + 1` rows, and the 100K measurement drops 24.0 ms → 0.3 ms.
-- Row set and row ORDER are unchanged: the index encodes exactly the
-- query's own ORDER BY, so it is a plan change only.
CREATE INDEX IF NOT EXISTS idx_projected_agenda_date_block
    ON projected_agenda_cache (projected_date, block_id, source);

-- `idx_projected_agenda_date` is now a strict prefix of the index above,
-- so every scan it could serve the wider index serves at least as well
-- (SQLite range-scans a leading-column prefix).  `projected_agenda_cache`
-- is a full-rebuild cache — the materializer DELETEs and re-INSERTs every
-- row (9.1M rows at the 100K tier) — so keeping a redundant index would
-- add write amplification to the rebuild for no read benefit.  Dropping it
-- keeps the table's index count, and therefore the rebuild cost, flat.
DROP INDEX IF EXISTS idx_projected_agenda_date;
