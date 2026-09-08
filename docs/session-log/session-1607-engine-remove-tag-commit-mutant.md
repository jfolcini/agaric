# Session 1607 — the surviving `apply_remove_tag` mutant (#4649)

## The mutant, and why nothing killed it

`scheduled-deep-checks.yml` reported one survivor in
`agaric-engine/src/loro/engine/apply.rs`:

```
apply.rs:832:12: delete ! in LoroEngine::apply_remove_tag
```

That is `if !removed_any { return Ok(()); }` becoming `if removed_any { … }` —
the commit-skip condition inverted. A real removal then returns with the
change still pending, and the idempotent no-op commits an empty transaction.

Three tests already covered `apply_remove_tag`, and all three survive the
inversion, because every one of them asserts through `read_tags`. Loro applies
a handler op to `DocState` and to the op-log DAG at op time, so an *uncommitted*
mutation reads back exactly like a committed one. No read can distinguish them.

## The assertion that can

`doc.get_pending_txn_len()`. The convention every `apply_*` in this file keeps
is that it returns with the doc committed — that convention is why
`LoroEngine::commit` could be deleted as uncalled — and `apply_remove_tag` is
the one method that has to reason about it, since it deliberately skips the
commit on the no-op path.

Falsified: with the `!` deleted, `apply_remove_tag_leaves_no_pending_transaction`
fails (`left: 1, right: 0`) and the other three still pass, so the kill is this
test's and not a side effect.

## An assertion dropped for being true twice

The first draft also pinned `version_vector()` across the no-op removal, on the
reading that "a no-op mints no change" is the other arm of the pair. It is not
independently falsifiable: committing an empty transaction moves no version
vector, so deleting the whole `if !removed_any` early return leaves all four
tests green. The only production change that *could* move the frontier on that
path is one that writes to the tag map — and that already reddens the
`assert_eq!(tags, vec![TAG_X])` directly above it. An assertion true for two
reasons hides a dead fix, so it was deleted rather than kept as reassurance.

## Bookkeeping

#4649 is auto-filed and auto-closed by `scripts/file-mutation-survivors.mjs`
from the parent's machine-readable block (#4690); this PR does not close it by
keyword.
