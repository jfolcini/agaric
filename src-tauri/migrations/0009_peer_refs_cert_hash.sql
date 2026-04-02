-- Add certificate hash column for TLS certificate pinning (#381).
-- Stores the SHA-256 hex of the remote peer's DER-encoded certificate,
-- observed during pairing. Used by connect_to_peer(expected_cert_hash)
-- on subsequent syncs to prevent MITM attacks.
ALTER TABLE peer_refs ADD COLUMN cert_hash TEXT;
