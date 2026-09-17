# Session 1776 — four more commands off the #5057 ratchet, and five mock divergences

`NOT_YET_PINNED_MUTATING` goes 6 → 3 (`compact_op_log_cmd`, `confirm_pairing`,
`add_attachment_with_bytes`), `NOT_YET_PINNED_READ` 3 → 2
(`get_compaction_status`). The `op-log maintenance` row of
`READ_WRITE_TABLE_PAIRS` goes with them, both its names now pinned.

Out of scope and untouched: `import_markdown`, `import_bibliography`,
`export_page_markdown`, `move_blocks_to_space`, `list_spaces`. Nothing was
moved into `PINNING_BLOCKED_MUTATING` — shortening a list by reclassifying is
the move #5055 made and #5056 exists to catch.

## Three waivers that described scope, not a blocker

The file's own doctrine is that an input nothing can name is a blocker and a
table nothing captures is debt. All three waivers retired here failed that
test in the same way.

`compact_op_log_cmd` read "op-log maintenance; rewrites history, not
blocks/props/tags" and `get_compaction_status` "op-log maintenance counters,
not projected block state". The snapshot carries `op_log_digest`. The log is
exactly what compaction acts on and what the digest compares, so both were
inside the scope they claimed to be outside of.

`confirm_pairing` read "writes the pending-pairing marker (app_settings) and
clears unpaired flags (peer_refs); pairing-window plumbing". It names two
writes and then judges them together, and they differ: the marker is
unobservable (nothing on the IPC surface reads that key — which is why
`cancel_pairing`, whose *only* write it is, stays permanently waived), but the
`peer_refs` clear lands in a column `PEER_REF_ATTRS` already projects.

## What is pinnable, and what is not

The delete path of compaction is **not** reachable, and the fixture says so.
`cutoff = Utc::now() - retention_days` with `MIN_RETENTION_DAYS = 7`, and the
conformance seed has no `op_log` table — it seeds blocks, properties, tags,
attachments, peer_refs, aliases, property_defs, link_metadata and app_settings,
so every op is minted during the replay and nothing is ever eligible.
`ops_deleted` is deterministically 0. What is pinnable is the accepted no-op
path, the `retention_days.too_small` refusal, and the status counters.

`oldest_op_date` is excluded from the query projection, in both the Rust arm
and the TS token, because it is `MIN(op_log.created_at)` — a clock read during
the replay, which a recorded value would bind to the millisecond it was
authored on. No fixture here is wall-clock dependent.

`add_attachment_with_bytes` was waived for "the BLOB", and that blamed the
wrong half. The bytes are a `Vec<u8>` over IPC — a literal JSON array both
stacks upload verbatim, so the INPUT was never the blocker and it never
belonged in the blocked bucket. The waiver was right that `id`, `fs_path` and
`content_hash` are minted per stack; the fixture pins none of them.
`ATTACHMENT_ATTRS` pins all four on the *seeded* rows three existing fixtures
use, and loosening it to admit a new row would have weakened those, so it was
left alone. What the fixture compares is the four fields the caller supplies
and the row stores verbatim, the `add_attachment` op in the digest, four
refusals, and — because the fixture undoes the add — a `list_attachments` whose
only surviving row is the fully fixture-authored seeded one.

## Five live divergences the pins found

The mock had none of the validation the backend does on
`add_attachment_with_bytes`: no MIME allow-list, no filename validation, no
live-block check. It appended no `add_attachment` op at all, and had no
`add_attachment` / `delete_attachment` arms in `reverseOpTypeFor`,
`reversePayloadFor` or `applyRevertForOp`.

`compact_op_log_cmd` was `() => ({ ops_deleted: 0 })` — it never read
`retentionDays`, so it answered success for every window including the `0` the
backend's floor exists to refuse.

`get_compaction_status` answered `opLog[0].created_at`: an ISO **string** where
`CompactionStatus.oldest_op_date` is `number | null` and `CompactionCard` hands
it to `new Date(...)`, and at the position the first op was *pushed* rather
than the minimum — the seed pushes older ops after newer ones
(`stampPageLastEdited`), so it was not even the oldest.

`confirm_pairing` left the unpaired flags standing, so in browser and e2e mode
a device list that had recorded a refusal kept prompting to re-pair after the
user had just paired.

The 50 MB size cap is deliberately NOT mirrored: no fixture can reach it, so it
would be code no test could redden.

## Task #20 closed as a side effect

`revert.ts`'s `delete_attachment` arm was blocked on exactly this: its note
said `reverse_delete_attachment` rebuilds an `AddAttachmentPayload` from the
original `add_attachment` op and the mock appended none. It does now, so the
arm is written and exercised — the fixture's redo leg calls `applyRevertForOp`
on the `delete_attachment` reverse row.

Still not reachable, and now stated where it belongs rather than as a deferred
note: undoing a *real* `delete_attachment` of an op-added attachment. Its
`attachmentId` cannot be spelled — `Cn` names a created block, `On` an appended
op, and nothing names a created attachment. `attachmentOwnerBlockId`'s
`delete_attachment` disjunct stays unwritten for that reason, with its comment
corrected from "the mock appends no op" to the label-convention gap.

## Verified

`cargo nextest run --workspace -E 'test(conformance)'` → 107 passed.
`npx vitest run src/lib/tauri-mock` → 48 files, 951 passed. `npm run typecheck`
clean. Both re-run after merging current `main` into the branch, not against
the base the work started from.

Thirteen falsifications, each against a copy and `cmp`-restored, covering both
stacks: the mock's retention guard and the backend's `MIN_RETENTION_DAYS`; the
status projection (`eligible_ops` 0 → 1); the `oldest_op_date` fix; the mock's
unpaired-flag clear and the backend's `clear_unpaired_flags_on_pairing_act`;
the `add_attachment` op push; the MIME allow-list and the live-block check
separately, because the first masks the second; and four reverse/revert arms.
One of those is worth recording: the first attempt at the backend pairing
falsification hit the identical call in `start_pairing_armed` and correctly
stayed green, which is what a correctly-scoped fixture should do.

Two of the thirteen are honest about what does NOT pin them.
`syntheticDeleteAttachment` and `revertDeleteAttachment` are pinned by
`attachment-undo-redo.test.ts`, a mock-internal regression test with
hand-written expectations, not by the conformance fixture: deleting either arm
leaves every fixture green, because the undo/redo round trip settles at the
same state whether the redo restored the row or quietly did nothing, and the
restored row is not comparable across stacks. The alternative — deleting the
helpers — would leave "undo an attachment add, then redo" silently broken in
dev and e2e. That test's docblock says so.

`MUTATING_ARM_COUNT` 33 → 36 and `SWEPT_ARM_COUNT` 51 → 52 move with the new
arms, each with its sweep note.

## Review round: the status fix had a second half

The reviewer caught that pinning `eligible_ops` reddened `history-advanced.spec.ts`.
The cause was the fix working: `CompactionCard` auto-expands on the first
`eligible_ops > 0`, so the card the test clicked to OPEN was already open and the
click closed it. The test had been encoding the stub's `0`, not asserting
behaviour. It settles on expanded now, and its docblock no longer claims
`eligible_ops` is hardcoded.

The second half was the real finding. With the status honest and
`compact_op_log_cmd` still returning `ops_deleted: 0`, dev and e2e advertised six
eligible ops that compacting never removed — two halves of one command
disagreeing, where the old pair of stubs at least agreed. `compact_op_log` bounds
its DELETE by the phase-1 per-device frontier AND the cutoff, and the mock
dispatches synchronously, so the cutoff is the whole bound: the purge is four
lines. It takes the seed's six ~90-day stamps with it, which is the point —
`last-edited:` and `recently-modified` read those as `MAX(op_log.created_at)`
and the backend loses them to a compaction the same way (`COALESCE(..., 0)`,
`query/engine.rs`). Invariant 1 names compaction as the one exception to the
append-only log, so this is the only mock path allowed to shorten `opLog`.

No fixture reaches that branch — every op a fixture mints is younger than the
seven-day floor — so it is pinned in `compaction-status.test.ts` instead,
including the arm that separates the two windows: the status counts against
`DEFAULT_RETENTION_DAYS` while the purge uses the caller's, which is why a
30-day-old op is ineligible at 90 and deleted at 7. The e2e test asserts the
identity those share rather than the literal 6, because `offsetIso(-90)` steps
back 90 CALENDAR days while the cutoff subtracts 90 exact ones and a
spring-forward puts the stamps an hour inside the window.

The third finding was a one-line divergence with a comment already describing
the fix: `delete_attachment` dropped `attachmentBytes` two lines above a comment
saying the bytes are left to the GC pass (#1993). The backend takes its app-data
dir as `_app_data_dir` and reclaims nothing, so an undone delete restored a row
whose `read_attachment` answered an empty buffer. Deleting the line made the
comment true; `purge_block` remains the path that does reclaim them, and
`purge-parity.test.ts` still pins that. Nothing had covered the difference, so
`attachment-undo-redo.test.ts` gained the case.
