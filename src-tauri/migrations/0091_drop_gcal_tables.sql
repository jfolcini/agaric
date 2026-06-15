-- Drop the Google Calendar push integration's local-device tables.
--
-- The gcal integration (OAuth flow, OS-keychain token store, daily-agenda
-- digest push connector) has been removed from the Rust backend. These
-- tables were purely local-device connector state — they never
-- participated in the op log, sync, or compaction — so dropping them is
-- safe and irreversible by design.
--
-- Tables dropped, by the migration that created them:
--   * gcal_agenda_event_map  (0032_gcal_agenda.sql)
--   * gcal_settings          (0032_gcal_agenda.sql; later seeded extra
--                             keys by 0041 and 0046 — no separate table)
--   * gcal_space_config      (0041_gcal_space_config.sql)
--
-- 0046_gcal_reauth_flag.sql only `INSERT OR IGNORE`d a key into the
-- existing `gcal_settings` key/value table — it created no new table or
-- column, so dropping `gcal_settings` cleans it up.
--
-- NOTE: the `agenda` / `projected_agenda` subsystems are NATIVE features
-- fed from `due_date` / `scheduled_date` / properties with zero gcal
-- dependencies. They are deliberately NOT touched here.

DROP TABLE IF EXISTS gcal_agenda_event_map;
DROP TABLE IF EXISTS gcal_settings;
DROP TABLE IF EXISTS gcal_space_config;
