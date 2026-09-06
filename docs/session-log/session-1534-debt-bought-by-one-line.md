# Session 1534 — debt bought by one line

#4738 added a single line to `find_undo_group_inner` — the
`AND (ol.origin = 'user' OR ol.origin LIKE 'agent:%')` allow-list from #4741 — and that tipped the
function from 70 to 71 by clippy's count, so it acquired

```rust
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
```

AGENTS.md rule 6 says that count only goes down. An `expect` is permanent and ownerless, and this
one was bought by one line of SQL.

## Why it was deferred, and why that was right

It was flagged as non-blocking on a PR that was reviewed, green, and last in a session. Splitting
needs a full `clippy --all-targets -- -D warnings` cycle to verify, and gambling that merge on a
lint budget would have been the worse trade. So it was filed rather than rushed, and done
immediately afterwards with the merge already banked.

The general shape: "small enough to do now" and "small enough to do *safely* now" are different
questions, and the second one depends on what else is in flight.

## The split

The function is short guards, a `seed_rn` calculation, one ~58-line `sqlx::query_scalar!`, and a
clamp. The query has no other caller, so lifting it into `undo_group_size` costs nothing and
leaves the guards readable on one screen.

`cargo clippy -p agaric --all-targets -- -D warnings` exits 0 **with the expect deleted**, which is
the check that matters: it proves the split fixed the budget rather than moving the overflow into
the new function.

## Reading the citation, not the line number

The review cited `history.rs:2408`. That file carries **five other** `too_many_lines` expects, all
pre-existing, and the nearest one to that line is on `undo_page_group_inner` — a different
function, one screen away.

Rather than trust the number, the diff of the merge commit settled it:

```
$ git show 68b06f153 -- src-tauri/src/commands/history.rs | grep -E "^\+.*expect\(clippy::too_many_lines"
+#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
```

with three lines of context naming `pub async fn find_undo_group_inner`. Exactly one expect added,
none removed.

Worth keeping because the failure mode is silent: removing the wrong expect would have compiled,
passed clippy (the real overflow is still suppressed), left the actual debt in place, and produced
a commit whose message described work it had not done. Line numbers in a review are a pointer into
the reviewer's checkout, not into yours.
