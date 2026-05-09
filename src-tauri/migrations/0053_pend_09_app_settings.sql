-- PEND-09 Phase 2 day-9 — generic key-value `app_settings` table backing
-- the `pend09.loro_authoritative` cutover toggle.
--
-- The toggle (see `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §3 day-9 +
-- §5) is the load-bearing kill switch for the Phase-2 cutover.  When the
-- value is `'1'` the materializer treats the in-process `LoroEngine` as
-- authoritative and projects from it into SQL; when `'0'` the existing
-- diffy-merge path remains authoritative.  Default first-boot value is
-- `'0'` (off) — the maintainer flips to `'1'` only after the
-- cutover-soak window opens (Phase-2 day-11+).
--
-- ## Why a generic `app_settings` table
--
-- The cutover plan §5.1 considered (and rejected) extending an existing
-- table: there is no general-purpose `settings` / `config` table today
-- (`gcal_space_config` is gcal-scoped + per-space).  A `(key, value,
-- updated_at)` shape leaves room for future PEND-XX flags without
-- another migration round-trip.  Generic-by-design.
--
-- ## Why seeded ON migration (not lazily by the cache initialiser)
--
-- The `OnceLock<AtomicBool>` cache (`src-tauri/src/loro/cutover.rs`)
-- reads this row on app boot.  Without the seed INSERT the cache would
-- have to encode a "missing row" tri-state and the first-boot read
-- would default to whatever the initialiser picks — a footgun if the
-- maintainer later re-cutovers and assumes "missing == off".  Seeding
-- guarantees the cache reads a definite value on first boot.
--
-- ## Migration numbering note
--
-- The Phase-2 cutover plan §8.3 originally placed `app_settings` at
-- migration `0054` because day 10 (the partial bucket-IS-NULL index)
-- was expected to land at `0053` first.  Day 9 lands BEFORE day 10 in
-- this implementation, so the actual numbering shakes out as 0053 here
-- and day 10's partial index will become `0054`.  The Phase-2 cutover
-- plan's table will be reconciled when day 10 lands.
--
-- ## STRICT
--
-- New table → STRICT applies (PEND-07 policy).  All columns have
-- explicit types; `updated_at` is INTEGER ms-since-Unix-epoch (matches
-- `loro_doc_state.updated_at`'s shape so future settings-style rows can
-- range-scan staleness consistently).

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

-- Seed `pend09.loro_authoritative = '0'` so the cache reads a definite
-- value on first boot.  `strftime('%s','now') * 1000` matches the
-- ms-since-Unix-epoch convention used by `loro_doc_state.updated_at`.
INSERT INTO app_settings (key, value, updated_at)
VALUES ('pend09.loro_authoritative', '0', CAST(strftime('%s','now') AS INTEGER) * 1000);
