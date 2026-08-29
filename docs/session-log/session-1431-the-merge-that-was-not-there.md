# Session 1431 — the merge that was not there

`agaric-sync` is 41K lines of peer-facing code carrying 376 example tests and, from the app
crate, exactly one property test. #4498 asks for properties on its pure decision functions.
This ships step 1: 18 properties and one generator-coverage guard over four surfaces in
`sync_protocol`, each scored against a model built from the generated data rather than from
a second reading of the implementation.

## The issue named a function that does not exist

#4498's step 1 asks for properties on "version-vector **merge** in `sync_protocol` —
commutativity, idempotence, and monotonicity under concurrent op sets". There is no vv
merge in this crate. `sync_protocol` only ever *compares* version vectors:

- `operations::check_reset_required` — does the peer claim more of **our own** ops than we
  can produce, i.e. did we lose our own tail (#2502, #602).
- `loro_sync::classify_from_vv_reachability` — is the peer's `from_vv` dominated by our
  `oplog_vv`, i.e. can we apply their delta at all.

Merging is `loro::VersionVector::merge`, reached through `agaric-engine`. So commutativity
and idempotence do not apply here — they are properties of a join, and neither of these is
one. Writing them anyway would have meant inventing a merge to test, or restating a
comparison as if it were one.

What the comparisons *do* have is an order structure, and that turned out to be the more
useful thing to pin. Both are dominance relations, so both should be reflexive, monotone in
the local side, and — for the reachability gate — transitive. Transitivity is the one no
example test gives you: it is what fails first when "absent" and "counter zero" stop
meaning the same thing, and a gate that confused the two would still pass every
two-vector example anyone would think to write.

The correction is recorded in the test file's header rather than only here, because the
next person to read #4498 will be reading it next to the code.

## Rejection sampling does not produce chains

The transitivity property, written the obvious way — draw three vvs, `prop_assume!` that
`a` covers `b` and `b` covers `c` — aborted the run:

```
Test aborted: Too many global rejects
successes: 52
local rejects: 0
global rejects: 1024
```

Three independent random vectors form a chain about 5% of the time. The fix is to
construct the chain by lifting each link with a non-negative per-peer delta, and then to
**assert the premises** rather than assume them — so a gate that disagreed with the
construction fails the test instead of passing it vacuously.

## Every property, shown red

The file carries a table naming, for 17 of the 18 properties, the mutation that killed
it: 15 mutations across the three production files, each applied to a copy, run, and
restored with a byte-identical comparison afterwards. Three worth naming:

- **`check_reset_required`'s `>` → `!=`.** Kills `matches_model` and
  `is_antitone_in_local`, and the second is the interesting one: it says that gaining ops
  locally can never *newly* conclude that we lost our tail. `!=` breaks that in a way no
  single example would catch, because for any one example it is still the right answer.
- **The reachability diagnostic naming `peer_id + 1`.** Kills only
  `diagnostic_names_a_real_violator`, which is the point of having it: the reason string
  reaches `SyncMessage::ResetRequired::reason` and the telemetry, so a message naming the
  wrong device sends whoever debugs a stuck sync to the wrong machine. The property asserts
  the named peer is *a* violator, not *the* violator — the gate iterates an `FxHashMap`, so
  which of several it reports is genuinely unspecified, and asserting more would be
  pinning hash order as a promise.
- **The persisted-bookmark decoder appending a marker.** Kills `decode_is_a_fixed_point`,
  the property that says whatever arbitrary bytes decode to must survive a re-encode. This
  is contrived against a JSON codec — but `encode_persisted_loro_vvs`' own doc comment
  reserves the right to move off JSON, and the failure it guards (a bookmark that reads
  back as a different frontier next session, so we ship a delta against state the peer
  does not have) is silent and lands in user data.

## One property could not be shown red, and that is written down

`batching_is_monotone_in_the_cap` — a larger `max_bytes` never yields more batches —
survived every mutation. Not for want of trying: splitting is "`g(state, record)` exceeds
`h(max_bytes)`", and every monotone `h` keeps the whole pass monotone. The one realistic
non-monotone `h` is a truncating cast, which this repo already lints for
(`cast_possible_truncation`), and it provably cannot bite: an `OpTransfer` with every field
empty already serializes to **106 bytes** of field names and punctuation, so a cap
truncated through `u8` (ceiling 255) partitions the same records the same way the
untruncated cap does, and the batch counts coincide.

The honest conclusion is not "the property is bad" but "the property is a ratchet, not a
bug-catcher" — it would break first if the loop were ever rewritten to reorder records to
fill batches — and that is what its doc comment now says. A green test whose failure you
cannot construct is worth keeping only if you say which of the two it is.

The attempt did leave one real improvement behind. Working out why the truncation could not
bite showed the record generator had drifted heavy enough (arbitrary `char`s, JSON-escaped
to as much as ten bytes each) that *every* batch was a singleton across the whole cap
range — which would have made three batching properties pass while proving nothing about
packing. That is now pinned by a plain `#[test]`, not a property:
`batching_generators_reach_the_multi_record_regime` samples the strategy through proptest's
deterministic runner and fails if the fullest batch at the widest cap holds fewer than
three records.

## What this does not do

Step 2 of #4498 — pointing cargo-mutants at these modules — stays blocked on #3393. The
lane currently tests 13 of 607 mutants before its wall-clock budget stops it, so adding a
fifth glob would put more work into a queue that already cannot drain 2% of what it has.
The properties come first regardless of that ordering, which is why step 1 was the one
that was unblocked today.
