# Session 1383 — attachment undo residuals

| | |
|---|---|
| **Issues** | #4247, #4248, #4262 |
| **Branch** | `claude/attachment-undo-residuals` |
| **Files touched** | see the PR's file list |

Three residuals filed off the #4253 review, all on the reverse/undo attachment
surface. Two builders, two adversarial reviewers, and both reviewers found real
defects.

## #4247 — the positional undo silently reversed the WRONG op

Both of the issue's factual claims were verified and both held.
`OpPayload::block_id()` returns `None` for `DeleteAttachment`, so `op_log.block_id`
is NULL on every such row; and `delete_attachment_inner` hard-deletes the
`attachments` row in the same transaction that appends the op, so the `EXISTS`
over live attachments is false from the instant the op exists. Both disjuncts
permanently false, so the positional undo skipped straight past the delete and
reversed the op underneath it.

Fixed with the issue's preferred, less invasive shape: a second `EXISTS` that
resolves the owning block from the paired `add_attachment` op-log row via the
indexed `op_log.attachment_id` column (migration 0064). `EXPLAIN QUERY PLAN`
confirms the partial index is used.

Applied at **three** query sites, one more than the issue names —
`undo_page_op_inner`, `find_undo_group_inner`, and `undo_page_group_inner` —
because the file's own #2549 comment requires all three to share one row-numbering
universe, and the batch path had the identical blind spot.

The #3706 interaction is deliberate and pinned: once the op is reachable, Ctrl-Z
after a GC sweep returns `NonReversible` instead of silently doing the wrong
thing. That is the correct outcome and is the point.

**Review found the new comment asserted a false invariant.** It claimed the rows
the new `EXISTS` admits are "precisely the rows `compute_reverse` can rebuild
from". Neither containment holds: the reverse's source lookup carries a
strictly-before `(created_at, seq, device_id)` bound the disjunct does not, and
the disjunct carries a page-membership scope the reverse does not. Proven with a
fixture where compaction pruned the original add and a later undo-produced add
survived — admitted by the query, not rebuildable by the reverse.

The reviewer deliberately did **not** add the missing bound. Doing so would make
the predicates match exactly and put those deletes straight back into the blind
spot #4247 exists to kill. The current shape yields a visible `NonReversible`
refusal with the transaction rolled back. The comment now states that neither
containment holds and why the bound is absent on purpose, and two boundary tests
pin it — including the residual case where `compact_op_log` has reclaimed the
paired add, where the blind spot genuinely returns and a future closure will now
fail loudly rather than silently changing which op Ctrl-Z targets.

**The denominator is five, not three.** `restore_page_to_op_inner` is left alone
defensibly — it is timestamp-addressed, shares no `rn` universe, and
`delete_attachment` is in `STATIC_NON_REVERSIBLE_OP_TYPES` so a swept delete is
skipped on sight; its only observable consequence is that `non_reversible_skipped`
under-reports. `list_page_history` has no attachment disjunct at all, so these ops
never appear in a page's History view — filed as #4277.

## #4248 — reverse arms stored peer filenames unsanitized

The issue asked for reachability to be established before fixing, and it was, leg
by leg. `insert_remote_op` and `append_merge_op` have no production callers (the
only imports are `#[cfg(test)]`); audit-only replication lands `is_replicated = 1`;
snapshot restore truncates `op_log`. So **no peer-authored payload reaches these
arms today** — this is not a remote-attacker hole.

What is live is a local divergence: op-log rows written before #2989 added
`validate_attachment_filename` are `is_replicated = 0`, are exactly what the
reverse payload is rebuilt from, and were sanitized by forward apply and recovery
replay but not by the reverse arms. So it is a fix, not pure hardening.

`reverse_attachment_filename` mirrors #3370's `reverse_add_attachment_fs_path`
shape — sanitize, never reject, warn — and is wired into both the `AddAttachment`
and `RenameAttachment` arms. Both hostile tests compare against what the **real
forward apply** stores into a sibling row rather than re-deriving the sanitizer's
output, so they pin byte-identity with production rather than with an expectation.

## #4262 — undo of a delete restored the PRE-RENAME filename

`DeleteAttachmentPayload` gained `filename`, captured from the live row inside the
delete's own IMMEDIATE transaction exactly as `fs_path` already was, with the same
`#[serde(default)]` and empty-string legacy fallback. Both reverse twins adopt it
through one shared helper, and the per-field helpers were made private so the batch
twin cannot call them.

Verified the legacy sentinel is unambiguous: `attachments.filename` is `TEXT NOT
NULL` but does permit `''`, so the schema is not the guarantee — the four
non-test writers are, and each either rejects an empty name or coerces it to the
`"attachment"` fallback. Worth knowing that this is an invariant held by call
sites rather than a `CHECK (filename <> '')`.

**Review found the mint path was entirely untested.** `reverse_add_attachment`
carries `filename` onto the synthetic delete it mints, and replacing that with
`String::new()` left 201/201 attachment tests green. The pre-existing #3706
`fs_path` carry was equally unasserted — the exact shape #4253's review flagged
("deleting that one line would leave the suite green"), reintroduced one function
over. Now pinned on the whole minted payload.

Review also hardened the helper: it read the two fields by field access, so a
**third** adoptable field would have compiled silently and gone unadopted at both
twins. It now destructures `DeleteAttachmentPayload` exhaustively, which turns
that into E0027 at the one place that decides — verified by adding a probe field
and watching it fail to compile.

**A relayed claim was wrong and got corrected.** The #4247 agent reported that
this change broke `reverse_delete_attachment_tie_breaks_on_device_id_3646` and
that the two kernels disagreed. The twins never disagreed —
`reverse_anchor_both_kernels` asserts `single == batched` first and that passed;
what failed was the test's own downstream #382 assertion, because the fixture
discriminated its two tie-break candidates by `filename`, the very field now
adopted. The fixture now discriminates on `size_bytes`, which nothing adopts, and
asserts both properties: selection (#382) and adoption (#4262). Flipping the
expected winner reddens it, so the discriminator is not vacuous. The design
question the mix-up raised has a clean answer, now documented: the tie-break
decides *which* prior add is selected, adoption decides only *what* is restored
from it, and the selection SQL never reads the delete's `filename`/`fs_path`.

## Verification

`cargo nextest run --workspace`: 6036 passed, 7 skipped, one unrelated
`sync_daemon` timing flake. `SQLX_OFFLINE=true cargo check --workspace
--all-targets` clean. `cargo fmt --check` clean — a formatting failure the #4247
work introduced would have aborted the commit and was caught in review.

## Round-two review — the probe was wider than the bug

The new paired-`add_attachment` probe was added under the pre-existing
`op_type IN ('delete_attachment', 'rename_attachment')` gate, so it admitted
orphaned **rename** ops too. After `add → rename → delete` with the row already
gone, the rename became reachable — and `reverse_rename_attachment` is a pure
payload swap while `apply_rename_attachment_tx` drops its `rows_affected`, so
the reverse was a zero-row UPDATE. Verified end to end before fixing: the undo
*succeeded*, changed nothing (0 attachment rows before and after, block text
unchanged), appended a reverse op anyway, and inflated the group to 3 when only
2 of its members could revert.

In the coalesced group case it was worse than a no-op. Reverting newest-first
restores the row, and then the rename reverse dragged the just-restored
attachment back to its pre-rename name inside a single Ctrl-Z.

Fixed by narrowing the probe to `delete_attachment` rather than by asserting
`rows_affected == 1` in the rename reverse. The fallback exists because the
delete is the op that removed the row the first probe looks for, and the only
one of the two whose payload cannot name its own block; a rename has no such
need, since its live-row probe is correct whenever the row exists. The assert
would instead have turned a silent no-op into a hard failure across *every*
rename reverse, including the ref-addressed and redo paths this work never
touched, and would abort whole groups under `skip_non_reversible = false`.

Nothing becomes unreachable. For a user who renames, deletes, then presses
Ctrl-Z: the first press undoes the delete and restores the attachment under the
name it held at delete time; because the row is live again, the ordinary
live-row probe admits the rename, so a second press undoes it. The orphaned
rename is invisible only while its row is gone, and it self-heals.

Also documented the group-undo blast radius for the **common** GC case, which
had the sentence only for the rarer compaction-boundary one: a byte-less
`delete_attachment` joining a 500 ms coalescing window aborts the whole group
and rolls back reversible siblings.
