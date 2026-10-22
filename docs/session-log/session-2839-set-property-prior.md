# Session 2839 — undoing a property change restores the value another device set

#6014: undo of a SetProperty restored the value the log said was there, not the one that was. A peer's value arrives as a replicated op, which the reverse kernels never read. So after a peer set `due_date` and you changed it, undo cleared the date instead of restoring the peer's. This is the SetProperty twin of #5918, which fixed the same for DeleteProperty.

- **`SetPropertyPayload` gains `prior`**, the five value slots the key held when the op was written. It carries `serde(default, skip_serializing_if = "Option::is_none")`, so an op without it keeps its exact pre-#6014 bytes and hash. Remote ingest hashes the raw payload, nothing denies unknown fields, and op payloads never enter Loro, so `ENGINE_FORMAT_VERSION` stays.
- **The central writer records it.** `block_ops::set_property_in_tx_with_declaration` reads the held value, as recurrence, MCP batch, import, page-source apply, bibliography, space moves and repairs all go through it. `repair_misfiled_tag_spaces` records it directly. The three space migrations record nothing: they only fill a key that is empty.
- **An absent key records all five slots empty.** No held value can be all-null: `exactly_one_value` holds since migrations 0062 and 0088, and promoted columns count only when non-NULL. So "all empty" means absent, and undo deletes the key. Without that, a set over a key a peer had deleted fell back to the log and resurrected the old value. The cost is about 108 bytes on a first-time set.
- **Both reverse kernels read it.** `reverse/property_ops.rs` and `reverse/batch.rs` read `prior` first, through `PropertyValueFields::into_held()`. They fall back to the op log only for an op that records none.
- **The mock follows.** `hasPriorPropertyValue` stamps the reverse op type from the recorded `prior`.

Reviewed separately; the reviewer was killed by a container restart and continued by a second one. The reviewer traced every reader of a stored or remote SetProperty payload, and every `json_extract`, to top-level fields only. No conformance fixture can express "a value with no op", so the backend's two-device tests pin it.

Shown red:
- the writer recording no `prior` (four undo tests, e.g. "`due_date` is back");
- each kernel ignoring it;
- `into_held` always `Some`;
- `skip_serializing_if` removed ("stored bytes are unchanged");
- an absent key recorded as `None` (`Some("old")` where `None` was expected);
- the mock ignoring it;
- the repair recording none.

Suites run: full workspace nextest (7114 passed), `cargo test --doc`, `cargo clippy --workspace --all-targets -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo fmt --check`, vitest over `src/lib/tauri-mock`, typecheck.

Left as is: the reverse kernels' own ops (redo of an undo) still read the op log, so a peer change between those two is not reflected.
