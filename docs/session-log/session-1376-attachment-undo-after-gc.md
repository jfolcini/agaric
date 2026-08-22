# Session 1376 — Undo that refuses honestly, rather than restoring a row over nothing (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer (no self-review), then a second review pass on the PR |
| **Items closed** | `#3706` |
| **Items modified** | — |
| **Tests added** | +6 (backend) |
| **Files touched** | 6 + this log — see the PR's file list |

**Summary:** undoing a `DeleteAttachment` restored the ROW but could not restore the BYTES,
and a GC pass between the delete and the undo destroys them. Not a race — the ordinary
outcome once the sweep has run, which is what made it severity:high. The result was a live
`attachments` row over bytes that no longer exist, and no `attachment_blobs` row that could
repoint it.

Every step was individually correct: `delete_attachment_inner` deliberately leaves the file
and the blob row to the GC (#1993/#3259); the GC reclaims what is by every measure available
to it an orphan; and undo faithfully reconstructs the original `AddAttachment` payload.

**Three options, and why this one.** Holding the GC to the undo horizon is the issue's first
suggestion and was **rejected**: undo here is bounded by the **op log**, not by a clock — an
op stays undoable until snapshot compaction, so honouring that literally means never
reclaiming a deleted attachment's bytes. Any shorter window is a product decision ("how long
must undo survive?") and was not invented. Making delete preserve enough to reconstruct
contradicts #1993/#3259 directly. So: **make undo honest**.

`require_reverse_attachment_bytes` resolves the payload's `fs_path` through the same
`coerce_from_peer` the INSERT uses — one shared helper, so the checked path and the stored
path cannot drift — stats it, and returns `NonReversible` if absent. Verified in review to
match the *reader*'s resolution too.

**The invariant:** no path in the reverse-apply commits an `attachments` row naming a file
that is not on disk. Review enumerated every `attachments` writer any reverse or redo path
reaches — there is exactly one, `apply_reverse_in_tx`'s `AddAttachment` arm — and cleared the
adjacent writers (forward apply, the command path which writes bytes before the row, op-log
replay, the two boot backfills) as not reverse paths.

**Three of the builder's claims were wrong, and review caught them.**

The load-bearing one: the preflight was justified as letting a point-in-time restore *skip
and count* the op while an interactive undo aborts. That cannot happen.
`restore_page_to_op_inner` is the only `skip_non_reversible = true` caller and it drops
`delete_attachment` **statically** before `revert_ops_in_tx` is ever reached — and
`delete_attachment` is the only op whose reverse is an `AddAttachment`. So the preflight is
reachable only with `skip_non_reversible = false`, where it and the in-arm check are
indistinguishable. Three comments asserted a behaviour that cannot occur, including the
stated reason the preflight exists. Not a functional bug; in a codebase where comments are
specification, still a real defect. Rewritten to say what is true and why the preflight is
kept anyway.

**`None` skips the guard — reachable?** No, but by convention rather than construction.
`build_materializer` is the only production constructor and sets the dir before returning;
a failure to resolve it is boot-fatal. But `Materializer::new` / `with_read_pool` are `pub`
and not test-gated, so a future production caller would silently reintroduce a no-op guard.
The branch now logs at WARN and says plainly that this is a convention, not a type-level
guarantee. Worth knowing: every pre-existing test that undoes a `delete_attachment` passes
only because the guard skips.

**The real TOCTOU guarantee, stated rather than implied.** The stat is outside the
transaction and nothing serialises the GC against the commit — its reference queries are
`SELECT`s that under WAL neither block on the undo's write lock nor see its uncommitted row.
The surviving window is bounded on both ends by the #3519 quarantine and is two adjacent
operations wide, producing exactly the state the GC's own doc already declares first-class
and pre-existing. **The deterministic case — "the sweep has already run" — is closed; the
microsecond race is not, and cannot be without the GC honouring an undo horizon.**

**A test gap review filled.** #1993 dedup points many rows at one file, so deleting one of a
deduped pair must still be undoable — the sibling keeps the bytes alive through every sweep.
Nothing pinned that, and it is the most plausible false refusal a future "check
`attachment_blobs` too" change would introduce.

**The trade-off, for the maintainer — corrected in the second review pass.** On a synced
vault the old behaviour restored a row that `find_missing_attachments` could re-request from
a peer; that self-heal is refused too. The first framing said the heal needed a peer *behind*
on the delete op, and peers sweep on the same schedule, so the heal was mostly theatre. That
holds for a **caught-up** peer and only for one. An **offline** peer has not processed the
delete at all — it still holds the row and the bytes — and the old behaviour's reverse
`add_attachment` op **replicates**, so when that peer reconnected the bytes genuinely could
come back. Refusing closes a recovery path that worked in that case, so the residual
multi-device loss is wider than the PR description first claimed.

Refusing is still the right default and this is not a reason to revert it: the alternative
commits a live row over missing bytes on **every** vault — a broken image, a failing
`read_attachment_inner`, and `find_missing_attachments` re-requesting those bytes on every
sync cycle forever — in exchange for a recovery that requires a peer which has not synced
since before the delete to later reconnect. A visible error beats silent corruption. Accurate
detection is also not buildable today: `AddAttachmentPayload` carries no `content_hash`. The
long-term answer remains the grace window (`#4250`).

## Second review pass — the false refusal, and four smaller notes

**A stale `fs_path` refused undos whose bytes were present.** The guard stats the ORIGINAL
`add_attachment` payload's `fs_path`, but three production paths repoint a LIVE row away from
that value, all of them moving it onto a shared content-addressed blob:
`recovery::attachment_blob_backfill`, `sync_files::maybe_link_local_blob`, and `sync_files`'
`FileOffer` skip path. After a repoint nothing references the original path, so the ordinary
sweep reclaims it while the bytes stay alive under the blob — and the undo then refused over a
file that never went anywhere. Before this PR the same staleness restored a row pointing at
the reclaimed path instead of the live one, so it was a bug in both directions.

Fixed where it originates rather than at the guard: `reverse_delete_attachment` (and its batch
twin, kept byte-identical) now adopt `DeleteAttachmentPayload::fs_path` — captured by
`delete_attachment_inner` from the LIVE row inside the delete's own transaction, hence
post-repoint by construction. Correcting the *payload* keeps the checked path and the stored
path identical, instead of the trap of checking the delete-time path while still storing the
original — which would pass the guard on bytes that exist and commit a row pointing elsewhere.
It also keeps the replicated reverse op and the local row naming the same file.

Three "is the delete-time path stale too?" cases were checked. Legacy pre-C-3 delete ops
deserialize `fs_path = ""` (it is `#[serde(default)]`) and fall back to the original — all
that was ever recorded for them. A `delete_attachment` minted by `reverse_add_attachment`
copies the ADD payload's path forward, so it is byte-identical to the fallback: no change. A
*peer's* delete op would carry a meaningless device-local path, but no reverse path can reach
one — `revert_ops_in_tx` calls `reject_replicated_targets` first and every other undo/redo
target query filters `is_replicated = 0`.

**Four smaller corrections.**

* The refusal logged "the orphan GC has already reclaimed" unconditionally, including when the
  branch was entered from a stat `Err` — two warnings for one event, the second asserting a
  cause it cannot know. Now one warning per refusal, each naming what it actually observed.
* `lib.rs` still said `CleanupOrphanedAttachments` "is not yet enqueued from any production
  path" and was "dormant until a scheduler hooks it". It is enqueued from three live sites
  (boot, the 24 h tick, post-compaction) — and this PR's whole premise is that the sweep runs
  routinely, so the comment was actively misleading.
* The rootless-`Materializer` note listed `new` / `with_read_pool`. `with_read_pool_and_lifecycle`
  — the constructor `build_materializer` actually calls — is `pub` too and also leaves the
  `OnceLock` empty. Added.
* Two test gaps. A batch containing one byte-less `delete_attachment` aborts the WHOLE batch,
  and all four existing tests were single-op; the new batch test orders the refusal *second*
  so a reverse is already appended and applied when it hits — falsified by committing instead
  of rolling back (`left: 0, right: 1` on the sibling row). And `redo_page_op_inner` appends
  the redo op BEFORE `apply_reverse_in_tx`, so op-log rollback is load-bearing on that path
  specifically; the redo test asserted only the absent row. The added `op_log_len` assertion
  was falsified the same way (`left: 3, right: 2`). Worth recording: `undo_page_op_inner`
  appends before applying too.

**Verification:** `cargo nextest run --workspace` → 6008 passed, 7 skipped; `cargo check
--all-targets` clean; `cargo clippy --all-targets -p agaric` clean; `cargo fmt --check` clean.
Falsification reproduced: with the guard stubbed, both GC arms fail with the real `UndoResult`
in the panic, and the no-GC arm **stays green** — so it pins symmetric behaviour rather than
the fix. The second pass falsified each of its three new/changed assertions the same way (see
above); the stale-`fs_path` test goes red with `NonReversible { op_type: "delete_attachment" }`
the moment the delete-time path is not adopted.

**Filed, not fixed:** `#4247` Ctrl-Z after deleting an attachment silently undoes the *wrong*
op (the positional query can never reach a `delete_attachment`); `#4248` the reverse-apply
arms store peer filenames unsanitized, the same asymmetry #3370 closed for `fs_path`;
`#4249` a refused undo does not tell the user *why*; `#4250` the GC grace window.
