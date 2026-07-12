-- #2601 — bounded-horizon materialization for the projected-agenda cache.
--
-- `projected_agenda_cache` (migration 0025) now materializes only the next
-- HORIZON_OCCURRENCES (13 × 7 = 91) occurrences per repeating block per date
-- source, instead of every occurrence inside a fixed 365-day window. That
-- keeps `list_projected_agenda` a pure index scan for the common near-term
-- agenda views, but means a query reaching past the materialized horizon
-- could miss far occurrences of a dense (e.g. daily) recurrence.
--
-- This single-row table records the guaranteed-complete horizon DATE for the
-- current cache contents (`rebuild_today + HORIZON_DAYS` — the last calendar
-- day for which EVERY block, down to the densest daily cadence, has all of
-- its occurrences materialized). `list_projected_agenda_inner` reads it and
-- falls back to on-the-fly projection for any query whose end date lands
-- beyond it, so a sub-year horizon can never return an incomplete page. It is
-- written in the SAME transaction as each cache rebuild
-- (`cache::projected_agenda`), so the advertised horizon and the rows it
-- describes commit atomically.
--
-- Single-row by construction: the `CHECK (id = 0)` pins exactly one row.
-- Local read-side cache bookkeeping — never part of any op, CRDT hash
-- preimage, or sync payload, and rebuilt locally per device — so it carries
-- no DEFAULT and is not seeded here. An absent row reads as "no horizon yet
-- → always fall back to on-the-fly", exactly the cold-cache behaviour before
-- the first rebuild runs.
CREATE TABLE IF NOT EXISTS projected_agenda_horizon (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    horizon_date TEXT NOT NULL  -- YYYY-MM-DD, guaranteed-complete through this date inclusive
) STRICT;
