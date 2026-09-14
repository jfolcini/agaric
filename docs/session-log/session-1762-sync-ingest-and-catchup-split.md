# Session 1762 — two agaric-sync splits, and a diagnostic nobody was pinning

Two `#[expect(clippy::too_many_lines)]` come off `agaric-sync`. Anchored
workspace count **25 → 23**.

- `sync_protocol/operations.rs` — `ingest_replicated_batch_inner`, 101 code
  lines, into `BatchState` + `note_presentation_order` + `defer_device_chain` +
  `report_batch_metrics`.
- `sync_daemon/snapshot_transfer.rs` — `receive_loro_snapshot_catchup`, 109 code
  lines, into `merge_one_snapshot` + `next_snapshot_frame`.

`handle_incoming_sync_inner` in `sync_daemon/server.rs` is the third
`too_many_lines` in this crate and is **not** here: 316 code lines across nine
phases, which is its own slice.

## The batch loop had five locals that were one thing

`ingest_replicated_batch_inner` carried `stalled`, `seen`, `landed`,
`highest_seq` and `out_of_order` as separate `mut` bindings, every one of them
keyed on a `device_id` borrowed from the records and every one of them read by
the same three concerns. They are now `BatchState<'a>`, so each helper takes one
reference instead of five and the lifetime says out loud what the borrows always
meant: the bookkeeping lives exactly as long as the slice being ingested.

Each field kept the comment that was already on it. None of them is new prose.

## Verified rather than assumed

Normalising both revisions to code lines and diffing, every difference is
relocation plus the scaffolding the split needs — the struct, three signatures,
the `use std::collections` moving from function scope to module scope. No logic
line changed.

## The survivor, and what it was actually saying

Two mutants on the batch loop, chosen for the thing a split can break that
reading cannot catch: an argument dropped or swapped at a new call site
compiles fine and changes behaviour.

| mutant | result |
|---|---|
| `note_presentation_order` never raises `highest_seq` | killed (2: #3726, #3740) |
| **`defer_device_chain` gets `(remote, local)` instead of `(local, remote)`** | **SURVIVED — 968/968 green** |

(The catch-up half's two mutants are in the section below.)

The swap is not inert. `record_stall`'s first parameter is the peer that shipped
the batch; the run map keys on `op_device_id`, so the arithmetic is untouched,
but `remote_device_id` is copied into `AuditIngestStall` — which is `serde` +
`specta` and reaches the frontend through
`StatusInfo::audit_ingest_last_stall`. Swapped, the sync-status panel names
**this** device as the peer that shipped the batch.

Three identities are in play at that call site and the type system separates
none of them: the local device, the remote peer that shipped, and the op-log
device whose chain stalled (`AuditIngestStall`'s own doc says the third is
"usually *not*" the second). `stall_run_reports_this_devices_own_run` already
asserts `op_device_id` and stops there — the other half of the pair.

`a_stall_names_the_peer_that_shipped_the_batch_not_this_device` closes it, with
all three ids distinct so no assertion can pass by coincidence. Against the
mutant: **969 run, 1 failed**, the new test alone.

This is the #4639 sweep's recurring finding in its clearest form yet. The split
did not introduce the gap — the same swap was equally invisible while the code
was inline. What the split did was make the mis-threading *expressible*, which
is exactly when it is worth a test.

## The catch-up loop, and a survivor that was neither

`receive_loro_snapshot_catchup` became a loop over two helpers. The
`changed_page_ids` dedup moved out of the `Imported` arm and into the caller,
because `merge_one_snapshot` now returns the ids one snapshot resolved and
accumulating across snapshots is the caller's job. `EngineReloadCtx` stopped
being destructured at the top and is passed whole, which is what keeps the
helper inside `too_many_arguments`.

Two mutants on the new seams:

| mutant | result |
|---|---|
| `record_catchup_pull` gets `(device, peer)` instead of `(peer, device)` | killed (5) |
| **`merge_one_snapshot` returns `Vec::new()` instead of the ids it resolved** | **SURVIVED — 969/969 green** |

The second is the hop the split created: the ids used to be pushed straight into
the accumulator inside the arm, and now they travel through a return value.
`useSyncEvents` reloads exactly the pages in `SyncEvent::Complete`'s
`changed_page_ids`, so dropping them leaves merged content invisible until the
user reloads by hand.

But the reading is not "nothing pins it". The catch-up fixture merged a single
**root** content block, and a root block belongs to no page — so on the honest
code the event carried `[]` too. The mutant changed nothing because there was
nothing there to lose.

That is a fourth reading of a survivor, after #5029's three (a real gap, a
provable equivalence, a mutant that does not do what its name claims): **a
fixture too thin to exhibit the behaviour**. It looks exactly like a gap and
diagnoses differently — the fix is in the test's setup, not in a new test.

Giving the responder a page and hanging the block under it makes the field carry
`["RESPPAGE0001"]`, and the assertion is now an exact value rather than the
vacuous `[]` it would have been. Against the same mutant: **969 run, 1 failed**,
that test alone.

## Test plan

```
cargo clippy -p agaric-sync --all-targets   # clean, neither `expect` needed
cargo nextest run -p agaric-sync            # 969 passed, 0 failed
```

Both functions are reached only from this crate's own sync paths and its tests,
so `-p agaric-sync` is the coverage boundary — checked rather than assumed, as
in #5026, #5028 and #5030.
