# Session 4367 — the last write that re-paired an unpaired device

A follow-up to #6969 (session 4364) that closes #6965 with the two review notes on that PR.

**The unpinned bind.** After a session, the initiator binds the key of a paired peer whose row has none yet: a pair migrated past 0107, or a row the responder left unbound after a #4380 refusal. `bind_endpoint_id` is an upsert, so a user who unpaired that peer while the session ran got its row back, key included. A peer that was paired when the session started is now bound through `bind_endpoint_id_if_paired`, an `UPDATE` that shares `bind_endpoint_id`'s refusals and reports a missing row. Its SQL text was already in the `.sqlx` cache, so `just gen-sqlx` changed nothing.

**The shared check.** `record_catchup_pull` repeated `SyncOrchestrator::still_paired`'s match; both now call one free function, `sync_protocol::still_paired`.

**Tests:** `unpairing_an_unbound_peer_during_a_session_keeps_it_unpaired` is the 4364 daemon test with the initiator's row left unbound, and goes red with the upsert restored. Two store tests cover `bind_endpoint_id_if_paired`. Each went red when that function created the row or skipped its refusals.

**Ran:** `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace -E 'test(/sync|peer|pair|unpair|catchup|snapshot|bind/)'`.
