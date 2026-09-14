# Session 1761 — apply_op_tx_with_mode, and half a symmetric pair

`apply_op_tx_with_mode` is the per-op dispatch: thirteen `OpType` arms between
a short prologue and the terminal `pages_cache` count hook. It carried an
`#[expect(clippy::too_many_lines)]`; clippy now accepts the file without one.
Workspace attribute count **26 → 25** (anchored grep, both sides — the
unanchored form reports 27 → 26 because it also matches the doc comment at
`commands/history.rs:2785`).

Five arms move out, one function each — `CreateBlock`, `EditBlock`,
`DeleteBlock`, `RestoreBlock`, `MoveBlock`. The eight that stay (tags,
properties, attachments, and purge) are short enough that a signature would
cost more than the extraction saves.

`PurgeBlock` was extracted first and put back: a six-line signature plus a
two-line doc wrapping a four-line body, replacing a three-line arm — the same
rule that kept the tag arms inline, and I had applied it in only one direction.
#5030's review caught that. `EditBlock` is the same shape more weakly, and stays
out because inlining both would push the dispatch back over 70.

Each helper parses its own payload and **returns** the `PreOpState` the count
hook needs, rather than assigning a shared `mut` binding across 180 lines. The
two arms with post-commit fan-out (`DeleteBlock`, `RestoreBlock`) and the move
also take `&mut ApplyEffects`.

The move was verified by normalising both revisions to code lines and diffing:
everything is relocation except the `#[expect]`, five `pre_state = X` becoming
`let pre_state = X` (purge's stayed put, inline), and `chunk.as_deref_mut()`
moving from inside the arm to the call site. No logic line changed.

## What the split could plausibly get wrong

The arm bodies moved verbatim, so the new risk is entirely in the threading —
an argument dropped at a call site compiles fine and changes behaviour.

| mutant | result |
|---|---|
| create: `chunk` not threaded | killed (2) |
| create: `replay_dirty` not threaded | killed (1) |
| **move: `replay_dirty` not threaded** | **SURVIVED — 1029/1029 green** |

`apply_op_tx_normal_mode_ignores_active_replay_sink_2896` pins the #2896
mechanism — the boot-replay sink that a suppressed apply records its touched
sibling group into instead of reprojecting inline — on `CreateBlock`.
`MoveBlock` threads the same sink into `apply_move_block_via_loro`, and nothing
pinned that. Drop the argument and the whole estate stays green.

This is the half-covered pair AGENTS.md names: one arm of a symmetric property
pinned, the other open.
`apply_op_tx_move_records_into_the_replay_sink_2896` closes it — a move applied
under `ReplaySuppressed` must leave its `(space_id, parent)` group in the sink.
Against the mutant: 1030 run, 1 failed, the new test alone.

## The #5026 lesson, applied

The first attempt at inserting that test anchored on `#[tokio::test]` and
failed outright, because these tests sit at module level and the anchor
looked for an indented one. Anchoring on the *doc comment* is what #5026's
review taught after the same insertion silently stole a paragraph there; here
it failed loudly instead, which is the better failure of the two.
