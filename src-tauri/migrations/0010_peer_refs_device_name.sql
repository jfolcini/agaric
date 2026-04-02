-- Add optional device name/label for paired peers.
ALTER TABLE peer_refs ADD COLUMN device_name TEXT;
