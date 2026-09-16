# Session 1765 — the doc-block anchor, a third time

Two notes from #5031's review, both on merged code, both mine.

## A stolen paragraph, by a new mechanism

`merge_one_snapshot` inherited the opening three lines of
`receive_loro_snapshot_catchup`'s doc comment. Its rustdoc summary read
"#2503 — receive + MERGE full per-space Loro snapshots from a peer after the
initiator's main loop reached `SyncState::ResetRequired`", which describes the
caller; the caller in turn opened mid-thought at "This is the 'merge, not wipe'
catch-up". Moved back.

This is the third time this session, and the mechanism was different every time:

| where | anchor | what happened |
|---|---|---|
| #5026 | `#[test]` | the doc *precedes* the attributes, so the insert landed inside the previous test's doc |
| #5030 | `#[tokio::test]`, indented | matched nothing; failed loudly, which was lucky |
| #5031 | the doc's **second** paragraph | the first paragraph stayed above and became the new item's summary |

The first two taught "anchor on the doc comment, not the attribute". That rule
is what produced this one: I anchored on a line *inside* the doc block. The
correct rule is narrower — **anchor on the first line of the doc block, or on
the blank line above it.** A doc comment is one unit; any anchor inside it
splits it.

Nothing catches this. The code compiles, the tests pass, and rustdoc renders the
wrong paragraph without complaint. It has been caught by a reviewer all three
times, which is the honest thing to record about it.

## An escape sequence in a generated file

`scripts/bulk-equivalence-baseline.json` came back from #5031 with 18 em dashes
re-encoded as `—`, putting 17 entries the PR never touched into its diff. I
had edited the file with Python's `json.dump`, whose `ensure_ascii` defaults to
true; the guard's own `--update-baseline` writes
`JSON.stringify(entries, null, 2)`, which emits them literally. The next person
to regenerate would have flipped all 17 straight back.

Re-emitted through the generator. The diff is 18 lines, escaping only, and the
recorded `not-a-fan-out` disposition for `report_batch_metrics` survives the
round trip — which was the thing worth checking, since `--update-baseline` is
also what writes new entries as `uncovered`.

The rule that would have prevented it is already in AGENTS.md, one level up:
regenerate generated files with the repo's tooling, never by hand. A JSON file
with a generator is a generated file even when the edit is one field.

## Acknowledged, not changed

#5030's review observed that `apply_edit_block_op` is the same shape I put
`apply_purge_block_op` back for — a five-line signature and a two-line doc
around a three-line body — and that my own stated reason for keeping it out
(inlining both pushes the dispatch back over 70) means the helper exists to buy
line budget rather than to clarify anything.

That is a fair reading and I am recording it rather than arguing with it. The
threshold is the measurement that decides, and that is a weaker justification
than the other four extractions have.

## Test plan

```
node scripts/check-bulk-equivalence.mjs   # 58 inventoried, no new/stale entries
```

No code changed: a doc comment moved between two items in the same module, and a
generated file was re-serialized.
