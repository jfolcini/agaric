-- PEND-24 H3 — seed the `reauth_required` key in `gcal_settings`.
--
-- The connector flips this flag to `'true'` when Google rejects the
-- access token even after a single bounded refresh (terminal
-- `Unauthorized` — the refresh token has been revoked). The next
-- cycle observes the flag at the top of `run_cycle` and short-circuits
-- the entire fetch/diff path until a successful re-auth clears it
-- back to `'false'`.
--
-- Idempotent via `INSERT OR IGNORE` so a second run on a database
-- already carrying a manually-set value (e.g. from a prior dev build)
-- is a no-op. No new table or column — the existing `gcal_settings`
-- key/value shape is reused, matching the rest of the connector's
-- per-key state.
INSERT OR IGNORE INTO gcal_settings (key, value, updated_at) VALUES
    ('reauth_required', 'false', '1970-01-01T00:00:00Z');
