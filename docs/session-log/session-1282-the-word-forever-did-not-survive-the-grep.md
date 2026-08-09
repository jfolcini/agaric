# Session 1282 — the word "forever" did not survive the grep

**Date:** 2026-08-09
**Issues:** #3546 (done)
**PRs:** #3689

One issue, three follow-ups filed off the #3531 review. The issue labelled the first
trivial and the second "the interesting one, because it is a correctness claim rather
than tidiness". Both labels turned out to be slightly off, in opposite directions.

## The trivial one was not equivalent

`ActivityFeed.tsx` hand-rolled an `isNonReversibleError`; #3531 had exported
`isNonReversible` for the same job. "Collapse to the export" reads like a rename.

The two definitions are not the same predicate. The local copy tested
`typeof err === 'object' && err !== null && 'kind' in err && err.kind === 'non_reversible'`.
The exported one routes through `isAppError`, which additionally requires the
`message: string` half of the `{ kind, message }` IPC envelope. The exported predicate is
strictly narrower, and it is narrower in a way that is reachable: `typedError`
(`bindings.ts`) rethrows `Error` instances but returns everything else as
`{ status: 'error', error }`, so `unwrap` throws whatever object came back — including a
`kind`-only lookalike with no message.

Every real `AppError::NonReversible` serialises both fields
(`src-tauri/agaric-core/src/error.rs`), so production behaviour is unchanged. But the
collapse *is* a behaviour change on that boundary — a message-less lookalike now takes the
generic-failure toast instead of claiming the backend said "non-reversible" — and the two
new `ActivityFeed` tests pin both sides of it, so re-introducing the loose local copy reds
exactly the second one. Worth stating rather than papering over: "collapse the duplicate"
was proposed as a no-op and it is not one.

## The correctness claim is right, and unimplementable as prescribed

The issue's second item says #3531's comments overclaim: dropping the undo entry on
`non_reversible` is justified by "resubmitting fails identically forever", but the
reverse-move preflight also rejects when the prior parent is merely **soft-deleted**, and a
trash restore revives it.

That is correct, and the code makes it worse than the issue argued.
`reverse_move_preflight` (`src-tauri/src/commands/history.rs`) has *two* arms that are
functions of the current tree rather than of immutable op-log history: the
`deleted_at IS NULL` parent-liveness probe the issue names, and the `move_would_cycle`
probe, which a later move can clear. And the recovery really is reachable —
`TrashView.handleRestore` never touches the undo store, so the entry #3531 drops would
still have been sitting there, and would have worked.

The prescription "treat the soft-deleted arm as transient" is nonetheless not
implementable in the frontend. `AppError::NonReversible { op_type }` serialises to the bare
two-field envelope; unlike `Validation` it carries no `code` sub-kind, and its `op_type`
reads `"move_block"` for the state-dependent arms *and* for the permanent one in
`reverse/batch.rs` (a pre-#400 `create_block` payload with neither index nor position).
There is no signal to branch on. Retaining the whole kind restores the #3353 wedge
verbatim; separating the arms needs a new backend sub-kind, not a frontend change.

So: no behavioural diff for item 2, and the deliverable is the reasoning. The three
comments that assert "forever" — in `app-error.ts`, in `isPermanentRevertFailure`, and in
the `undoByRefs` catch — now say what is actually true, name the two temporarily-impossible
arms, and record why they are dropped anyway. A future reader who notices the same thing
finds the argument instead of re-deriving it.

## The third item was a real bug with a real accounting trap

`performSingleRedo` rolled the ref back onto `redoStack` on **any** failure, so
`redo_page_op`'s three non-retryable rejections (`not_found` for a missing op_log row,
`validation` for the #659/#2549 provenance refusals, `non_reversible` for an uncomputable
reverse) wedged Ctrl+Shift+Z exactly as #3353 described for Ctrl+Z. Same predicate, same
fix.

The trap is that redo has group bookkeeping undo does not. `redoGroupSizes` pairs with
`redoStack` under `sum(sizes) <= length`, and the residual was computed as
`groupSize - redoneCount` on the assumption that a failed op is always still on the stack.
A dropped ref is not, so the residual has to shrink by the drop too — otherwise a group
size outlives its refs and a later redo is promised ops that no longer exist. The failure
outcome is now a tagged union rather than `UndoResult | null` precisely because the caller
must distinguish `'retained'` from `'dropped'`; `undoDepth` is restored in both cases,
since the redo did not happen either way.

Falsified four ways, each reverted locally and re-run: forcing `retain = true` reds three
of the four new tests; reverting the residual arithmetic reds the same three; removing the
empty-refs guard on the undo-stack push reds one (a redo that only dropped a dead ref must
not push a `{ refs: [] }` entry, which is neither ref-addressable nor a legitimate
positional target); restoring the local `ActivityFeed` predicate reds one.
