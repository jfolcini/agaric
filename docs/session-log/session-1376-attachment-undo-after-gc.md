# Session 1376 — Undo that refuses honestly, rather than restoring a row over nothing (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | `#3706` |
| **Items modified** | — |
| **Tests added** | +4 (backend) |
| **Files touched** | 3 + this log — see the PR's file list |

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

**The trade-off, for the maintainer.** On a synced vault the old behaviour restored a row
that `find_missing_attachments` could re-request from a peer; that self-heal is refused too.
Review's own view, going further than the builder: the heal needs a peer that is *behind* on
the delete op, which the undo cannot check — and a failed heal is not inert, since
`find_missing_attachments` re-requests those bytes on **every** sync cycle forever. Detection
cannot be built accurately today because `AddAttachmentPayload` carries no `content_hash`.
Refusing is correct; the long-term answer is the grace window, deferred.

**Verification:** `cargo nextest run --workspace` → 6006 passed, 7 skipped; `cargo check
--all-targets` clean; `cargo fmt --check` clean. Falsification reproduced: with the guard
stubbed, both GC arms fail with the real `UndoResult` in the panic, and the no-GC arm **stays
green** — so it pins symmetric behaviour rather than the fix.

**Filed, not fixed:** `#4247` Ctrl-Z after deleting an attachment silently undoes the *wrong*
op (the positional query can never reach a `delete_attachment`); `#4248` the reverse-apply
arms store peer filenames unsanitized, the same asymmetry #3370 closed for `fs_path`;
`#4249` a refused undo does not tell the user *why*; `#4250` the GC grace window.
