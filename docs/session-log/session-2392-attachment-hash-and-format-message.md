# Session 2392 — Attachment hashes on peers, the integrity arm and the version message (#5728)

Review of #5728, the last three steps of #5608's design (6 to 8) and one
kernel change, checked against what the builder claimed.

**What it ships.**
- `AddAttachmentPayload.content_hash`, omitted when `None`. The engine entry
  and the SQL row store it and the command's follow-up `UPDATE` is gone, so a
  peer's row carries the hash the attachment was added with.
- `receive_offered_file` refuses an offer whose hash differs from the row's
  (`file_offer.hash_mismatch`, no ACK), before the blob link.
- `reconcile_engine` compares `attachments` rows with the engine's entries
  both ways (`engine.attachments.*`).
- `SyncEvent::Error` gains an optional `code`. `engine_format_mismatch` makes
  the frontend say to update both devices, naming the peer ("the other device"
  when it has no name).
- `apply_attachment_op` names `RenameAttachment` and refuses any other op type.

**Where the plan was wrong.**
- Design § 5 said both devices show the format error. Only the responder does:
  `on_head_exchange` fails the session before it replies, so the dialling
  device sees the stream end and a generic `Sync failed`. Each device shows
  the message when the other one dials it. A daemon test pins that the dialler
  gets no frame; `sync-protocol-spec.md` says so.
- #5728 asked to measure "the extra hash" on the receive path. There is none:
  the writer already hashes as it streams and the new check compares two
  strings. The builder's 50 MB timing test measured the old writer, so it is
  deleted. A peer row with a hash also takes `resolve_offer_hash`'s stored-hash
  path when it relays, where a missing hash rehashed the file until the next
  boot backfill.

**The refusal cannot fire on data a user can legitimately hold.** A hash comes
from `persist_attachment` (the blake3 of the bytes in memory) or, for a row
that predates it, the boot backfill (the blake3 of the file). Hydration copies
the row's hash, the projection copies the entry's, and the sender offers its
row's hash or a fresh hash of its bytes. So an offer differs from the row only
when the sender's bytes are not the ones added. A dedup repoint and an undo's
re-add keep the hash, and a row with no hash (an add before #5728) accepts any
offer. After a refusal the file phase's `Err` is non-fatal on both sides: the
session completes, no backoff, no event, no toast, one `error!` naming both
hashes and one `warn!`. The next sync asks again and meets the same offer, which
ends the rest of that session's file phase (on the initiator, that includes
serving the peer's request), as the size check does. Left alone.

**Found and fixed.**
- `docs/architecture/data-and-events.md` still gave `SyncEvent::Error` without
  `code`. FEATURE-MAP did not say which device shows the message; it says the
  dialled one now. Three comments still said a remote add carries no hash.
- `offer_file_5608` waited 500 ms for the ACK. A receiver 700 ms slow made
  `an_offer_of_the_added_bytes_is_accepted_5608` hang to the nextest
  timeout, because the sender never sent `FileTransferComplete`. The wait now
  ends when the receiver does, so no clock decides it.
- A peer's row with a hash and no bytes yet reports `attachment_blobs.refcount`
  in the integrity check: its blob entry is written when the file phase lands
  the bytes. The oracle header now lists it beside the other deferred passes.
  A fix needs the filesystem in the oracle, so it is documented, not changed.

**Tests and their reds** (each file restored by a trap and compared).
- Legacy op round trip: removing `skip_serializing_if` from `content_hash`
  reddens one of the 1476 `agaric-store` tests,
  `add_attachment_payload_legacy_json_decodes_and_reserializes_unchanged`.
- Refusal before the link: moving the check after the link reddens
  `an_offer_of_other_bytes_is_not_linked_to_a_blob_held_under_its_hash_5608`
  alone. Always refusing reddens the acceptance test; never refusing, an
  inverted comparison and a removed body redden the refusal tests.
- Oracle: disabling the extra-row direction drops `SQL_ONLY` from
  `engine.attachments.row` in `attachment_rows_behind_the_engine_are_reported_5608`.
- Kernel: restoring the wildcard arm makes the refused op return `Ok(())`.
- Format code: emitting `None` reddens the orchestrator and daemon tests;
  making the frontend ignore the code reddens the two `useSyncEvents` cases
  and the Playwright spec.
- The rewritten helper: with the 700 ms receiver the old one timed out at 60 s,
  the new one passes in 1 s and the refusal reds above still hold.
- Probed, not committed: the engine arm is quiet after add, rename, delete,
  undo of a delete, undo and redo of an add, a dedup add, a hostile peer entry
  projected by the production code, and a cross-space move and back.

**Not done.** The issue's real-lane bullets: `sync-two-device.e2e.ts` does not
assert the peer row's hash or that a second identical image is linked; the
loopback test `a_peer_row_carries_the_hash_and_held_bytes_are_not_requested_again_5608`
does, over real QUIC. Two identical images that are both missing in one session
are both requested (2 files, checked); both rows end on one file.

Gates, on the branch as reviewed: `cargo clippy --workspace --all-targets -- -D
warnings`; `SQLX_OFFLINE=true cargo check --workspace --all-targets`; nextest
7047 of 7047 in two partitions, no FLAKY; doc-tests 10 passed, 5 ignored;
`cargo doc` with the doc-link lints; the four `sqlx prepare --check` lanes;
vitest over hooks, stores, components and lib (18539 passed); `npm run
typecheck`; `npm run lint`; `knip`; `e2e/sync-events.spec.ts` 6 of 6. Origin/main
had moved on (#5712) while this ran, so the branch plus these fixes was also
applied to it in a scratch copy: `cargo check`, clippy and nextest (7070 of 7070)
pass there too.
