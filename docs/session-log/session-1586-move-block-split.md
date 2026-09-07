# Session 1586 — `recover_blocks_from_op_log` loses its marker (#4639)

## What

The follow-up session 1584 scoped. `recover_blocks_from_op_log` drops from 225
to **48 code lines** and its `#[expect(clippy::too_many_lines)]` is removed.
`src/db/recovery.rs` goes **6 markers to 5** — the first actual decrement, not a
relocation.

## Why the previous commit could not do it

`move_block` was 143 code lines by itself. Extracting the arm whole would have
needed its own `#[expect]`, and #4639 counts markers rather than lines, so the
count would have been unchanged. Session 1584 said so rather than claiming
progress it had not made.

Splitting the arm was necessary but still not sufficient: 225 − 143 + 1 ≈ 83,
which is over the threshold. The preamble and the post-loop repair pass had to
come out too. That arithmetic is why this is one commit and not two.

## The seven new functions

| Function | Code lines | What it is |
|---|--:|---|
| `probe_inherited_tombstone` | 17 | the OLD parent, read BEFORE the reparent |
| `climb_to_tombstoned_ancestor` | 39 | the depth-bounded ancestor climb |
| `unsweep_old_parent` | 49 | #4204/#4188's un-sweep |
| `sweep_under_ancestor` | 42 | its mirror image |
| `replay_move_block` | 43 | the orchestrator |
| `load_local_ops` | 30 | op_log probe, era probe, ops query |
| `finish_block_recovery` | 36 | orphan re-homing, `page_id` re-derivation |

## One thing that is not a pure move

`climb_to_tombstoned_ancestor` originally returned
`(Option<String>, bool)` — the ancestor and whether the depth-bounded climb was
truncated. The truncation diagnostic is pushed immediately after the climb and
nowhere else, so the flag was crossing a function boundary only to be consumed
one line later. The climb now pushes its own diagnostic and returns just the
ancestor; the flag never leaves the function that produces it.

The first draft of this refactor did thread it out, with a `let _ =` at the call
site to silence the unused binding. That `let _` was the tell that the boundary
was wrong.

Everything else is a verbatim move. The only other edits are the signatures and
`load_local_ops`'s `return Ok(diagnostics)` → `return Ok(Vec::new())`, which it
needs in order to report "nothing to replay" without owning the diagnostics it
fills in.

## Verification

- 97 recovery/replay tests pass, including `b3_boot_replay_is_idempotent`.
- `cargo clippy --workspace --all-targets -- -D warnings` clean. That is itself
  the proof the parent dropped under 70: an unfulfilled `#[expect]` is a build
  failure, so the marker could not have been removed while the function was
  still over the threshold. The lint is the measurement, not my line count.

## Review round

Four findings, all real, all fixed in place:

- `climb_to_tombstoned_ancestor` and `unsweep_old_parent` each converted an
  `Option<&str>` parameter to `Option<String>` and then straight back with
  `.as_deref()`. Both allocations were artifacts of extracting the bodies from a
  scope that owned those values; the parameters already have the right type.
- The climb's doc still promised it returned "whether the depth-bounded climb
  was truncated". It does not — that was the smell this PR removed, and the doc
  had outlived it.
- Two SQL literals kept their old continuation indentation after their bodies
  moved out a nesting level, leaving `ORDER BY` and `WHERE` aligned to nothing.
  Whitespace after a `\` line-continuation is stripped by Rust, so the string
  values are byte-identical — but the point of this PR is that the move is
  verifiable by eye, and misaligned continuations make that harder.
