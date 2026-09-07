# Session 1584 — split the boot-replay match arms (#4639)

## What

`recover_blocks_from_op_log` was the largest `#[expect(clippy::too_many_lines)]`
holder in the `agaric` crate at 360 code lines. Five of its six `match op_type`
arms are now functions:

| Arm | Function | Code lines |
|-----|----------|-----------:|
| `create_block` | `replay_create_block` | 49 |
| `edit_block` | `replay_edit_block` | 21 |
| `delete_block` | `replay_delete_block` | 31 |
| `restore_block` | `replay_restore_block` | 50 |
| `purge_block` | `replay_purge_block` | 18 |

Parent: 360 → 225 code lines.

## The marker stays, and that is the honest state

225 is still over the 70-line threshold, so the `#[expect]` remains fulfilled
and the ratchet count is unchanged. The whole reduction is blocked behind one
arm: `move_block` is 143 code lines on its own, and extracting it as-is would
move the marker rather than remove it — the extracted function would need its
own `#[expect]`, and #4639 counts markers, not lines.

Getting the parent under 70 needs two more steps, in this order:

1. split `move_block`'s body internally so no piece is over 70;
2. extract it, and lift the op_log/era probes out of the preamble.

Arithmetic: 225 − 143 + 1 ≈ 83, still over, which is why step 2 includes the
preamble and not just the arm.

This commit is the mechanical half, landed on its own because it is verifiable
in isolation: every body is moved unchanged, so the diff is reviewable as a pure
extraction, and the delicate part gets its own review.

## Why the bodies are byte-identical

This is disaster-recovery code. Every arm carries dense `#`-cited commentary
about eras (pre/post-0080 timestamp encoding), cascade reach, and truncation
repair. The extraction moved each body verbatim and changed only indentation, so
a reviewer can diff arm-for-arm; no behaviour was touched.

The captured locals fell out cleanly — only `delete_block` needs the sqlx `row`
(for `op_created_at_ms`/`_rfc3339`), and only it and `restore_block` need
`deleted_at_is_ms`.

## Verification

- `cargo nextest run --workspace` — **6312 passed**. The whole workspace, not a
  `-p` run: per AGENTS.md a `-p agaric` run does not compile the dependent
  crates, so on its own it says nothing about whether a change breaks a
  consumer.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean. It caught two
  artefacts of the extraction that `cargo check` passed: the moved
  `delete_block` body still passed `&row` / `&now_rfc3339` where the new
  parameters are already references, and three block-bodied arms ended in a `?`
  expression rather than a statement.
- The narrower `-E 'test(recovery) + test(recover) + test(replay)'` selection —
  97 passed, including `b3_boot_replay_is_idempotent`, the proptest that replays
  a generated op sequence through boot recovery and asserts the reprojection is
  stable. Re-run after the clippy fixes.
