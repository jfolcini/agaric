-- #2502 (#87 §10.5) — persist per-peer, per-space Loro version vectors on
-- `peer_refs` so Loro VVs become the only causality/staleness mechanism in the
-- sync handshake and the op-log `(device_id, seq)` heads reset check can be
-- retired.
--
-- `loro_vv_bytes` stores the PEER's advertised per-space Loro version vectors
-- as of the last successfully-completed sync session with that peer — a
-- serialized `Vec<SpaceVersionVector>` (`{ space_id, vv }` pairs, where `vv` is
-- Loro's opaque `VersionVector::encode()` output). It is written by the
-- streamer on session completion (`session_state_machine`) and read on the
-- next session so the streamer can ship an incremental `Update` (delta since
-- the peer's persisted frontier) instead of a full `Snapshot` even when the
-- initiator advertised no version vector this round — removing the last
-- excuse for the every-tick full-snapshot churn (#610).
--
-- Nullable (no DEFAULT): a peer we have not yet completed a version-vector
-- exchange with backfills to NULL, which the read path treats as "no persisted
-- frontier — fall back to a full snapshot for every space", exactly the
-- pre-#2502 behaviour. `peer_refs` has been `STRICT` since migration 0075;
-- `ADD COLUMN … BLOB` is a STRICT-permitted type, and a nullable add needs no
-- default. Like the other `peer_refs` bookmarks (`last_hash`, migration 0001)
-- this is LOCAL sync bookkeeping, never part of any op or CRDT hash preimage.

ALTER TABLE peer_refs
    ADD COLUMN loro_vv_bytes BLOB;
