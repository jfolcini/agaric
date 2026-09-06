# Session 1551 — unreachable content repairs

Two boot-time repairs for damage that three closed write-side defects left in a real vault
(#4728, #4715): 166 live content blocks with no parent and no page, and four journal dates split
across 31 extra pages holding 37 live blocks. Every change is an op — `MoveBlock`, `DeleteBlock`,
`CreateBlock`, `SetProperty` — through `apply_op_projected`, appended as `Actor::Housekeeping`,
in a non-fatal `CommandTx` per repair after the empty-block sweep. The engine side is
`src-tauri/agaric-engine/src/repair/`, the driver `src-tauri/src/repair.rs`.

A third fold, #4725 (content created under a tag), was built here and then carved out by
maintainer decision: PR #4789 owns it. Nothing of it remains on this branch.

## The dry-run is the acceptance test

Every number in the plan was re-measured against the read-only vault copy before any code, and
then the finished repairs were run against a scratch copy of it with the engines rehydrated from
its `loro_doc_state`: 225 orphans of which 166 carry something; 4 dates, 31 duplicate pages, 37
children; 236 ops appended (1 create, 1 space stamp, 203 moves, 31 deletes); one `Unreachable`
page in Personal with 166 live children, each with a `page_id` and a `space_id`; every date down
to one live page; no moved child tombstoned; a second run appends nothing.

The number that was not in the plan: 166 of 166 re-homed blocks are nodes of the Personal Loro
doc afterwards. They had never been in any doc — their create ops were compacted away and they
were promoted by a raw SQL cleanup — and a `MoveBlock` on a block no engine holds takes the
SQL-only fallback, which would have left them reachable in SQL and absent from every export. The
`SetProperty(space)` apply hydrates a page's live subtree into the space doc (#2326), so the
page's space stamp runs after the moves — on a found page as much as a created one, because
review measured that a later boot's orphan moved under an already-stamped page stayed
engine-absent, and the re-stamp is one op. The `Unreachable` page is still made of the two halves
of `create_page_in_space_inner`; only their order around the moves differs.

## Two falsifications that taught something

`notes-on-me` — the plan's example of a title that `LIKE '____-__-__'` would sweep in and the
`GLOB` digit mask would not — is eleven characters. `LIKE` with ten `_`s refuses it on length, so
the guard test built on it stayed green with the mask removed. The fixture is now `note-on-me`,
ten characters, and the test asserts that length equals a date's before it asserts anything else.

The boot-driver test failed two runs in six after a mutation and then without one. It looked like
a race between an aborted transaction's lazy `ROLLBACK` and the next repair's `BEGIN IMMEDIATE`;
it was the fixture. `BlockId::new()` ULIDs minted in one millisecond order by their random low
bits, so the page the test inserted first was `MIN(id)` — the keeper — only most of the time. A
fixture whose order a repair reads mints ids with `Ulid::from_parts(ts, counter)`.

## What the kernel already does

`project_move_block_to_sql` writes only `parent_id` and `position`, and the plan asked for an
explicit `rederive_page_and_space_ids` after each move. The kernel's `PreOpState::Move`
maintenance runs exactly that whenever the parent changed, so a second walk would have been a
duplicate. Instead the move helper reads the row back and refuses the batch if the block did not
land under the new parent with a `page_id` — an invariant checked on the write path rather than a
test that could go green for a second reason.
