# Session 1467 — the clone that had not drifted, and the fallback that cannot fire

Shipped item 1 of #4525: `billed_bytes` is one `pub(crate)` function in `operations.rs` instead of a
production expression and a hand-copy of it in the property tests. Item 2 — the source pin on
`batch_with_truncated_cap` — stays open on the issue's own sequencing note, because whatever marker
format survives the #4556 decision should be implemented once rather than twice.

## The interesting result was the negative one

The premise of the issue is that a hand-copied formula can drift from the production one it mirrors,
and that a shared function cannot. That premise is sound and the extraction is worth doing on it
alone. But the clone had **not** drifted: both sides were
`serde_json::to_string(…).map_or(0, |s| s.len()) + 2`, and the only textual difference —
`to_string(&rec)` in production against `to_string(rec)` in the test — is fully explained by
parameter ownership, since production iterates owned records and the helper took a reference.

That is worth recording because the opposite result was the one to be careful about. Had the two
disagreed, the extraction would have silently adopted one of them, and adopting the test's version
would have shipped the clone's bug into production. Checking which side was right *before* deleting
either was the whole risk in a change this small, and it was checked against `git show HEAD:` on both
files rather than against the builder's summary of them.

## A mutant survived, and it was the right answer

Two mutations were run against the extracted function. `+ 2` → `+ 3` reddens the suite:
`monotonicity_predicate_catches_a_truncating_cap` asserts a 126-byte floor and reports 127.

`map_or(0, …)` → `map_or(999_999, …)` does **not** redden it — 425 of 425 still pass. The instinct is
to treat a surviving mutant as a coverage gap and write a test that kills it. Here that would have
been wrong, and establishing so took reading `OpTransfer`'s field list rather than accepting the
claim: every field is a `String`, `i64` or `Option<String>`, the struct derives `Serialize` with no
custom impl, and `serde_json::to_string` can only return `Err` for a map with non-string keys, a
non-finite float, or a `Serialize` impl that errors — `std::io::Error` cannot occur because
`to_string` writes into an in-memory buffer. None of those can happen for this type. The arm is not
untested; it is unreachable, and no test can reach it without changing the struct.

So the disposition is a comment, not a test and not an issue. The comment records three things: that
the arm is dead today and the argument for why, what would make it reachable again (most plausibly a
`HashMap` keyed on something other than `String`, or a float field), and why `map_or(0, ..)` stays
rather than `unwrap`/`expect`. That last one is the part worth having written down at the call site:
this runs once per record on the sync send path, so a shared billing helper panicking there would
take down the session, whereas a record mis-billed at 0 bytes is already bounded by the
oversized-batch tolerance `batch_ops_for_wire` documents — a lone record ships in its own batch even
past `max_bytes`. Losing a byte count is a smaller failure than losing the session.

## The `+ 2` is derived, and says so

The doc comment explains the `+ 2` as the per-element envelope a record's own serialization does not
cover: a separating comma between elements of `SyncMessage::OpLogBatch`'s `records` array, plus the
array's brackets. That is factually right about the wire format — `SyncMessage` is
`#[serde(tag = "type")]` and `records` serializes as a plain JSON array — but `git log -S` back to the
formula's introduction in #2481/#2495 shows the original comment never claimed that breakdown; it
said only "a small per-element envelope allowance". So the explanation is a derivation, not a
recovered rationale, and the comment says as much rather than presenting it as sourced. Summing `+ 2`
per record over-provisions against the true amortized `N+1` bytes for `N` elements, which is
consistent with the value being declared an upper bound.
