-- Store the last known network address (host:port) for a peer.
-- Used for direct connection when mDNS discovery is unavailable.
ALTER TABLE peer_refs ADD COLUMN last_address TEXT;
