# Session 1736 — the `agaric-sync` file-transfer and Loro-sync splits (#4639)

Refs #4639, tenth slice: the six `#[expect(clippy::too_many_lines)]` sites
in `agaric-sync` (`sync_files.rs`: `register_received_blob`,
`receive_request_and_send_files`, `request_and_receive_files`;
`sync_protocol/loro_sync.rs`: `apply_remote`, `import_and_project`,
`replay_inbox_batch`). Pure moves: every protocol send and receive, engine
call, SQL write and log line keeps its order, and the lexed string-literal
multiset of each file differs from `HEAD` only by the three deleted
`expect` reasons.

- `register_received_blob`: `repoint_stale_blob_mapping` is the #3652
  DELETE-then-repoint tail.
- `receive_request_and_send_files`: `recv_file_request`,
  `resolve_offer_metadata` (pass 1), `reopen_offered_attachment` (pass 2's
  open and size re-check) and `await_file_received_ack`.
- `request_and_receive_files`: `send_file_request` carries steps 1 and 2
  plus the tally, and `receive_offered_file` the whole `FileOffer` arm,
  itself split into `link_row_to_local_blob`, `decline_unknown_offer`,
  `cross_check_offer_size`, `decline_offer_after_writer_error` and
  `stream_offer_to_writer`. The arm's three `continue`s became
  `return Ok(())`: each sat at the end of the arm, so the successor is the
  loop's next iteration either way.
- `apply_remote`: `gate_inbound_message` returns `ControlFlow`, because the
  gate either falls through with the space id and bytes or returns
  `SnapshotFallbackRequested`; the caller returns at the same point, after
  the same metrics record.
- `import_and_project` is now a short sequence in the original order:
  engine import, clearable slot ids, tombstone stamp, tombstone narrowing,
  no-op short-circuit, state read, `BEGIN IMMEDIATE`, the
  `defer_foreign_keys` PRAGMA, ancestor backfill, space-block-first, the
  four projection passes, slot clear, commit, engine fan-out, tag refresh.
  `commit_projection` takes the transaction by value, so BEGIN and COMMIT
  stay in one place and the FK diagnosis still runs on commit failure.
- `replay_inbox_batch`: `gate_replay_slots`, `batch_tombstone_union`,
  `account_batch_survivors` and `replay_accepted_slots_individually`.

Four type aliases (`OfferedFile`, `ProjectedBlockState`,
`ProjectionStates`, `HealingDelta`) keep the helper signatures inside the
argument cap without a suppression; `ProjectionStates` exists because the
honest return type of the state read trips `clippy::type_complexity`, and
the file already uses that idiom. No guard crosses an await: every moved
`for_space` acquisition is in a synchronous helper or in the same braced
block it occupied before.

## Verified

Reviewer (opus) reconstructed the ordered sequence of transaction, SQL
and engine operations with every new helper inlined at its call site, for
all six roots: identical to `HEAD`, from the engine import through
`BEGIN IMMEDIATE`, the PRAGMA, the four passes and the slot DELETE to the
commit, the FK diagnosis on commit failure, the engine fan-out and the
tag refresh. Independently lexed string literals (raw strings,
continuations, comment-aware, with a quote-count soundness check) differ
from `HEAD` only by the three deleted `expect` reasons per file. Every
`registry.for_space` acquisition was enumerated: 18 before, 18 after,
none holding a guard across an await. Error-handling operator counts are
unchanged; `.await` and `?` grow by exactly the number of new async
helper calls.

- `cargo clippy -p agaric-sync --lib --tests -- -D warnings`: clean.
- `cargo fmt --all -- --check`, `cargo check --workspace --all-targets`:
  clean.
- `cargo nextest run --workspace`: 6318 passed, 13 skipped.
- `cargo test --doc --workspace`: ok.
- `node scripts/check-bulk-equivalence.mjs`: 53 inventoried, no new or
  stale entries. The split lifted two `batch`-named helpers out of
  `replay_inbox_batch`, so the guard demanded a disposition for each:
  `batch_tombstone_union` is an in-memory dedup fold (`not-a-fan-out`)
  and `account_batch_survivors` the per-slot survivor probe
  (`read-only`). The fork itself is still the one recorded `gap`, whose
  note now says where its body lives.
- Falsified on copies, restored byte-exact: deleting the
  `defer_foreign_keys` PRAGMA reddens
  `apply_remote_backfills_interleaved_ancestor_gap_4083`; deleting the
  in-transaction slot DELETE reddens
  `apply_remote_purge_clears_slot_and_tombstone_on_commit_2292`;
  deleting projection pass D reddens
  `replay_sync_inbox_resweeps_purge_from_tombstone_2292`.

One correction to the builder's rationale: `SpaceId::from_trusted` does
uppercase its input, so the four sites now passing `space.as_str()` pass
a normalised copy. It is unobservable here (the column is only ever
written from an already-canonical `SpaceId`, and the value is used as a
tracing field or re-normalised downstream), and no tracing field name
changed, but the inconsistency with `gate_replay_slots` — which keeps a
separate `space_id` parameter for exactly that reason — is left for a
follow-up.
