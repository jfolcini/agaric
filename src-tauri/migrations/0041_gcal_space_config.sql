-- FEAT-3p9 Milestone 1: per-space Google Calendar config.
--
-- Additive table mirroring the per-space split of `gcal_settings`. The
-- legacy `gcal_settings` table is intentionally left in place during M1
-- so existing oauth / lease / connector / commands code keeps compiling.
-- A one-shot Rust bootstrap step (gcal_push::migration) copies the
-- legacy single-space row + the keychain token entry into the Personal
-- seeded space at first run after this migration.
--
-- Columns mirror REVIEW-LATER.md FEAT-3p9 "Backend scope (GCal)":
--   space_id        — FK by convention to the page block marked is_space=true
--   account_email   — unverified email from id_token, display only
--   calendar_id     — empty when not connected; populated by FEAT-5e on first connect
--   window_days     — INTEGER, [7, 90], default 30
--   privacy_mode    — 'full' | 'minimal'; default 'full'
--   last_push_at    — RFC 3339 UTC of last successful push (empty when never pushed)
--   last_error      — short error category for Settings UI display (empty when fine)
--   push_lease_device_id   — device currently authoritative for this space (empty when unheld)
--   push_lease_expires_at  — RFC 3339 UTC lease expiry (empty when unheld)
--
-- No FK from space_id to blocks(id) (matches the rest of the spaces
-- properties model — `space` ref properties also do not FK back to
-- blocks). Cleanup on space deletion is handled by the eventual delete
-- path, not by ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS gcal_space_config (
    space_id              TEXT PRIMARY KEY NOT NULL,
    account_email         TEXT NOT NULL DEFAULT '',
    calendar_id           TEXT NOT NULL DEFAULT '',
    window_days           INTEGER NOT NULL DEFAULT 30,
    privacy_mode          TEXT NOT NULL DEFAULT 'full',
    last_push_at          TEXT NOT NULL DEFAULT '',
    last_error            TEXT NOT NULL DEFAULT '',
    push_lease_device_id  TEXT NOT NULL DEFAULT '',
    push_lease_expires_at TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
