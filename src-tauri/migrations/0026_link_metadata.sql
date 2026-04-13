-- UX-165: Local cache for external link metadata (title, favicon).
-- NOT synced between devices — each device fetches independently.
CREATE TABLE IF NOT EXISTS link_metadata (
    url           TEXT    PRIMARY KEY,
    title         TEXT,
    favicon_url   TEXT,
    description   TEXT,
    fetched_at    TEXT    NOT NULL,  -- RFC 3339
    auth_required INTEGER NOT NULL DEFAULT 0
);
