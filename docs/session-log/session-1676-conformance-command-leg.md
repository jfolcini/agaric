# Session 1676 — a fixture op can now go through the command layer

#4670. The conformance runner replays fixture ops as raw `OpPayload`s below
the command layer, so a fixture could never say "this command was rejected"
or "this command returned that". Session 1222 skipped a purge-of-a-live-block
fixture for exactly this reason, and session 1082 recorded a
`descendants_affected` divergence the harness structurally could not see.

The payload replay stays, because it is the harness's subject: the durable
serialized-op boundary that boot recovery and sync take. What changed is an
opt-in per op. An op carrying `"via": "command"` (and a `name`) calls its
`*_inner` on the Rust side and the mock handler on the TS side; its return
value, projected through the query leg's row-token grammar and relabelled
with the snapshot's canonical ids, or its refusal (`AppErrorKind` wire string
plus the `ValidationCode` for a `validation` kind) lands as one record in a
new `expected_ops` section that `CONFORMANCE_UPDATE=1` authors and both
runners assert. A refusal must be declared with `expect_error` (and
`expect_code` when coded), under the same discipline the read leg's
`expect_error` already enforces: an undeclared refusal, a declared refusal
that succeeded, a different kind, or a mismatched code all fail. The
existing 47 `expected` blocks did not change.

Two fixtures use it. `purge_live_block_errors` (new) soft-deletes and purges
one child through the payload replay, then purges a live sibling through the
command path and records `invalid_operation`; the snapshot pins that the
refusal appended no op and left the sibling live. `cascade_delete_subtree`
routes its one `delete_block` through the command path and records
`descendants_affected=3`, the seed-inclusive cohort. Reverting the mock's
cohort count to the target-exclusive value that shipped in session 1082
reddens the command leg while the snapshot leg stays green, which is the
point of the change.

Not done: a `ValidationCode` fixture. The candidate (`edit_block` to a
duplicate page title) needs the mock's `ownerSpaceOf` to fall back to the
`space_id` column, because the snapshot leg stamps neither the property nor
the column; that is a mock behaviour change in its own right, so the code
arms are pinned by unit tests on both sides instead. A `via` step on
`create_block` would reach `create_block_inner`, not the
`create_block_inner_with_space` the shipped command calls; no fixture does
that today.

`src-tauri/tests/AGENTS.md` § Conformance fixtures gained one sentence for
the `via` / `expected_ops` keys; flagged in the PR.

## Verified

- Rust `cargo nextest run --workspace -E 'test(conformance)'`: 107 passed
  (builder, then reviewer), including the new `conformance_command` unit
  tests and the `MUTATING_ARM_COUNT` denominator tripwire.
- vitest over `src/lib/tauri-mock/__tests__/conformance*`: 6 files, 136
  passed, twice.
- `npm run typecheck` exit 0, twice.
- Falsified on copies, restored, `cmp`-clean: the live-purge guard removed
  on each side (both legs redden with "declares `expect_error` but the
  command SUCCEEDED"); the mock's cohort count off by one (command leg only
  reddens); a fixture record with neither return nor error (coverage guard
  reddens); a fifteenth dispatcher arm (denominator reddens); a wrong
  argument in the Rust `delete_block` arm (snapshot mismatch); the
  different-kind arm of `checkDeclaration` disabled (its unit test reddens).
- Not run locally: the full suites (CI carries them; the laptop is in use).
