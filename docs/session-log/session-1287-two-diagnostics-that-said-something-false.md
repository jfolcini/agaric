# Session 1287 — two diagnostics that said something false (2026-08-11)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-11 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3734, #3740 |
| **Items modified** | — |
| **Tests added** | +11 (backend) |
| **Files touched** | 10 |
| **PR** | #3748 |

**Summary:** Tightened peer-supplied attachment-path handling and made the
audit-ingest stall diagnostic match actual frontier progress. Follow-up review
also isolated fake-clock TTL tests from the process-global stall map and made
the remaining filesystem limitations explicit without imposing incompatible
limits on existing attachment paths.

A follow-up batch on the two review-note issues left by #3721 (peer `fs_path`
confinement) and #3739 (audit-ingest defer policy). Ten notes between them, all
filed non-blocking. Eight were implemented; two were declined on the evidence.

The through-line is the same in both halves, and it is not a bug in the control
flow: **a statement about the system that the system does not support.** In
`attachment_path` it was a doc guarantee ("distinct ids stay distinct") that an
exact-string test could not see through, and that stopped holding the moment the
path reached a case-insensitive filesystem. In `audit_ingest_metrics` it was an
`error!` line telling an operator to go looking for a full disk on a device that
had just advanced its frontier. Both were reachable from the wire.

## The invariant the test could not see

`AttachmentFsPath::for_storage_id` diverts an id spelled like the digest namespace
(`id-<hex>`) so a peer cannot steer its own row onto another row's digest path.
The guard was `starts_with(OPAQUE_ID_PREFIX)` — case-sensitive — while the path it
protects is opened on APFS or NTFS, which are not. `ID-<blake3-of-victim-id>` is
therefore a different string to the partial UNIQUE index and the same file on
disk.

The initial fix is one `eq_ignore_ascii_case`. The half that matters is the test: the
shipped `an_id_spelled_like_a_digest_does_not_collide_with_one` compared the two
paths with `assert_ne!` on exact bytes, so it declared the namespaces disjoint
while, on the filesystem the paths are actually opened on, they overlapped. Both
that test and `the_fallback_keeps_distinct_ids_distinct` now compare
case-insensitively, which is the property the column's uniqueness is standing in
for. The case-folding hazard that is *not* closed — two ordinary peer paths
differing only in case — is now written down under a `# Limitations` heading,
because the type otherwise reads as promising one path string per file.
Follow-up review closed the non-ASCII variant for fallback ids without trying
to emulate platform Unicode tables: only ASCII ids without lowercase letters
may now mint verbatim (which includes local ULIDs); lowercase and non-ASCII
inputs use their per-id digest. Arbitrary peer-supplied `fs_path` case folding
remains the stated limitation. The Win32 reserved-device set now also includes
the documented `COM¹`–`COM³` and `LPT¹`–`LPT³` stems.

## "Running without landing anything", about a device that landed something

`note_progress` ran for `seen.difference(&stalled)`, so a device that ingests part
of its chain and then hits `SQLITE_BUSY` mid-chain kept its whole consecutive-stall
run. Three such sessions — frontier advancing every time, tail shrinking every
time, nothing wrong — fired the #3727 escalation, whose text asserts the device has
been "deferred N batches running without landing anything".

The reset now happens when something *lands* for the device, and it happens at the
stall rather than in the post-loop sweep: the escalation fires from inside
`record_stall`, so a reset afterwards would arrive too late to stop the false line.
That ordering is the whole fix, and the test asserts on the captured log text
rather than only on the counter, because the counter was never the thing that was
wrong.

Two smaller notes on the same module: the per-device stall map is keyed by a
wire-supplied `device_id` and was only ever emptied by progress, so a device that
stalled once and was retired left a permanent entry — runs now age out after ten
minutes, ~10 of `SyncScheduler`'s 60 s resync intervals. And `record_out_of_order`
logged one long `error!` per offending record, in a scenario (a reordered batch)
that produces thousands of them; it now emits one summarised line per device per
batch carrying the count, while the process-global counter still moves once per
record.

## The notes that were declined

#3734 note 2 asked for case and Unicode normalization to be treated as the
trailing-dot hazard was in #3370. It is stated as a limitation instead. Folding
case in `parse` would rewrite the ULID paths this device has already minted and
stored, which turns a narrow hazard into a migration of every existing row's
`fs_path`; the note itself says the module's limitations "should say so", and that
is what shipped.

#3734 note 6 proposed path-byte, component-byte, and depth caps to bound work a
peer could provoke. Those limits were removed after review against the root
threat model: sync peers are the user's own trusted devices, and AGENTS.md
explicitly rejects peer-DoS hardening that adds complexity without value. More
importantly, applying new caps in `parse` would make pre-existing rows that were
valid when stored unreadable, without a migration or repair path. Confinement,
canonicalization, and rejection of paths the supported filesystems cannot open
remain; arbitrary size/depth limits do not.

## Guard drift, again

Removing `check_attachment_fs_path_shape` — `pub`, and with no production callers
left after #3370 moved the rules into `AttachmentFsPath::parse`, so nothing warned
about it — removes dead surface that survived because it was public. The two test
sites now call `parse` directly, which is what they were asserting about anyway.

**Files touched (this session):**

- `docs/session-log/session-1287-two-diagnostics-that-said-something-false.md`
- `src-tauri/agaric-core/src/attachment_path.rs`
- `src-tauri/agaric-sync/src/sync_files.rs`
- `src-tauri/agaric-sync/src/sync_protocol/audit_ingest_metrics.rs`
- `src-tauri/agaric-sync/src/sync_protocol/operations.rs`
- `src-tauri/migrations-mock-ack-baseline.txt`
- `src-tauri/src/commands/attachments.rs`
- `src-tauri/src/snapshot/tests.rs`
- `src-tauri/src/sync_files/tests.rs`
- `src-tauri/src/sync_protocol/tests.rs`

**Verification:**

- Full workspace nextest suite — 5,637 passed, 6 skipped (2 slow).
- Targeted workspace nextest audit-metrics filter — 12 passed, 5,631 skipped.
- Plain Cargo audit-metrics tests with `--test-threads=16` — 12 passed in one
  process.
- TTL eviction, ASCII/lowercase admission, exact deferred/out-of-order counting,
  and monotonic latest-occurrence mutations each made their focused test fail
  and were restored before the passing runs.

**Process notes:** The fake-clock TTL tests now inject a private run map and latest
occurrence sink, so they exercise the production sweep without advancing time for
or overwriting unrelated global entries under plain parallel `cargo test`. The
out-of-order aggregation unit tests similarly inject a private counter, so exact
zero/four-record assertions do not race the process-global status metric.

**Commit plan:** single commit, pushed through the normal hooks.
