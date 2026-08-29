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

What the comparisons *do* have is an order structure, and that is what this file pins
instead. Both are dominance relations, so both should be reflexive, monotone in the local
side, and — for the reachability gate — transitive.

**A claim about transitivity that an earlier draft of this log made, and the test file
does not.** The draft said transitivity was "the one no example test gives you: what fails
first when 'absent' and 'counter zero' stop meaning the same thing". Neither half survives
scrutiny. Dominance *is* pointwise `>=`, so any gate agreeing with `model_reachable` is
transitive automatically — `reachability_matches_model` subsumes it. And in loro "absent"
and "counter zero" cannot come apart at all: `set_last` removes a peer's key rather than
storing an end of `0`, and it is the only way into a `VersionVector`, so the distinction
the sentence hinged on is not expressible. It was a hypothetical dressed as a motivation.

The property is kept as documentation that executes — it states the order law in the file
that depends on it — and the test file says so plainly. This paragraph exists because the
two halves of one PR disagreed for a round, and the log was the half that was wrong.

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

## One property could not be shown red, and the reason I gave was wrong

`batching_is_monotone_in_the_cap` — a larger `max_bytes` never yields more
batches — survived every mutation. The first version of this log explained why,
confidently and incorrectly:

> an `OpTransfer` with every field empty already serializes to **106 bytes** of
> field names and punctuation, so a cap truncated through `u8` (ceiling 255)
> partitions the same records the same way the untruncated cap does

106 is less than 255, so that sentence argues for the opposite of its
conclusion. Review caught it, with a counterexample: at `max_bytes = 250` and
`extra = 20`, the truncated caps are 250 and 14, which would partition 40
records into 20 batches and 40 — a monotonicity violation the property would
catch. On that reading the property is a bug-catcher for exactly the mutation I
had dismissed.

**Both of us were wrong, and measuring settled it.** The counterexample assumes
two records fit under a cap of 250. They do not: the smallest record the
strategy actually produces bills at 129 bytes, and `129 + 129 = 258 > 250`, so a
cap of 250 gives 40 singleton batches, same as 14. The probe:

```
PROBE billed=129 cap250 -> 40 batches, cap270 -> 40 batches
```

The real window is narrower than either account. A truncated cap changes the
partition only where it still fits **two** records, so it needs a cap of at
least twice the smallest record and at most 255.

**And the floor took a third attempt to get right.** The version of this section
that first replaced the 106 said 127, derived from a record with `parent_seqs:
None`. Review caught that too: `None` serializes as `"parent_seqs":null`, and
the strategy can also yield `Some("0")`, whose `"parent_seqs":"0"` is one byte
shorter. The true floor is **126**, so the window is a truncated cap of 252
through 255 rather than 254 or 255:

```
PROBE parent_seqs None -> 127, Some("0") -> 126
PROBE true floor = 126
PROBE window = caps 252 through 255
PROBE cap 251 -> 40 batches
PROBE cap 252 -> 20 batches
PROBE cap 256 -> 40 batches
```

Three values for one number: 106 measured the *type's* floor when the quantity
that matters is twice the *strategy's*; 127 measured the strategy's floor with
the wrong `Option` arm; 126 is derived and probed. Each was tighter than the
last and each was still an estimate dressed as a derivation until the probe ran.

And over 20,000 sampled records the strategy never reached that floor:

```
PROBE sampled_min=142 hand_min=127 two_of_hand_min=254
PROBE u8 ceiling = 255; can two minimum records share a truncated batch? true
```

(That run is quoted as it was, `hand_min=127` and all — it is the run whose
`hand_min` the next round corrected to 126. The `sampled_min` is the part it was
measuring and that number stands.)

142-byte records need 284 to pair, which no `u8` can express. So the window is
real and the random search does not reach it — which is why no mutation turned
the property red, and it is a different fact from the one I published.

## What that changed about the test

Not the property, which is correct as written; widening the generator to hit a
two-in-256 cap window would trade a reliable property for a flaky one. What
changed is that the property now has a **validation control** — the same device
the in-page-find sweep harness uses, and for the same reason: a property that
has never failed proves nothing until you have seen it fail.

`monotonicity_predicate_catches_a_truncating_cap` applies the predicate to a
local copy of the production loop with the truncating cast added, over records
at the exact 126-byte floor. A cap of 252 pairs them; 256 truncates to 0 and
cannot. Twenty batches becomes forty on a *larger* cap, which is precisely what
the property forbids. The predicate has power; the generator is what does not
reach the window.

The lesson is not "check your arithmetic", though that too. It is that
**"provably cannot" is a claim with a burden, and I met it three times with a
number instead of a derivation.** 106 was a real measurement of a real thing —
and it was the wrong thing, because the quantity that matters is twice the
*generator's* floor, not once the *type's*. 127 was the right quantity measured
against the wrong `Option` arm. 126 is the one that was probed rather than
reasoned about, and it is the first that a reviewer could not immediately
improve on.

Each correction was smaller than the last, which is the tell: the first was a
category error, the second an off-by-one, and both survived because I wrote a
figure and moved on rather than running the three lines that would have settled
it. The version that survives scrutiny is the one that says what was measured
and how it bounds the conclusion — which is what the doc comment now does, and
why it also records the two values it replaced, so the next person to touch that
number knows it has a history of looking obvious and being wrong.

## What this does not do

Step 2 of #4498 — pointing cargo-mutants at these modules — stays blocked on #3393. The
lane currently tests 13 of 607 mutants before its wall-clock budget stops it, so adding a
fifth glob would put more work into a queue that already cannot drain 2% of what it has.
The properties come first regardless of that ordering, which is why step 1 was the one
that was unblocked today.
