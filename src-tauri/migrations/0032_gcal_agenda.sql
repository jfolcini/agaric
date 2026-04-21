-- FEAT-5a: Google Calendar push — daily-agenda digest support.
--
-- Two tables back the Agaric → GCal one-way daily-digest push:
--
--   * gcal_agenda_event_map — date-keyed map from a local date to the
--     Agaric-owned GCal event that carries that date's digest.  At most
--     ~window_days rows in steady state (default 30 → ≤90 even at max
--     window), so no secondary index is needed: queries hit the PK.
--
--   * gcal_settings — typed key/value store for connector state the
--     user can see or change (calendar id, privacy mode, window size,
--     push lease, account email).  OAuth tokens live in the OS
--     keychain (FEAT-5b), NOT here.
--
-- Neither table participates in the op log, sync, or compaction — this
-- is purely local-device connector state.  No FK from the event-map
-- back to blocks(id): the map is date-keyed and block deletion is
-- picked up implicitly by the next digest hash change.

CREATE TABLE IF NOT EXISTS gcal_agenda_event_map (
    date TEXT PRIMARY KEY NOT NULL,
    gcal_event_id TEXT NOT NULL,
    last_pushed_hash TEXT NOT NULL,
    last_pushed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gcal_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Seed the six known setting keys with their spec defaults so the
-- connector can always rely on the row being present (typed reads via
-- GcalSettingKey panic-free).  Empty strings represent "unset" for
-- lease / account / calendar-id fields populated later by FEAT-5b /
-- FEAT-5c / FEAT-5e.  privacy_mode default is `full` and window_days
-- default is `30` per FEAT-5 parent spec (REVIEW-LATER.md line 653).
INSERT OR IGNORE INTO gcal_settings (key, value, updated_at) VALUES
    ('calendar_id',           '',     '1970-01-01T00:00:00Z'),
    ('privacy_mode',          'full', '1970-01-01T00:00:00Z'),
    ('window_days',           '30',   '1970-01-01T00:00:00Z'),
    ('push_lease_device_id',  '',     '1970-01-01T00:00:00Z'),
    ('push_lease_expires_at', '',     '1970-01-01T00:00:00Z'),
    ('oauth_account_email',   '',     '1970-01-01T00:00:00Z');
