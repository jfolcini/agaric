# Session 1763 — the responder session, and a decision nothing can watch

`handle_incoming_sync_inner` was `agaric-sync`'s last
`#[expect(clippy::too_many_lines)]` and the largest one left in the sweep: 316
code lines over nine phases, between a prologue and a shutdown. Anchored
workspace count **26 → 25**.

## Nine phases, nine names

The function did not need untangling so much as naming. Each phase came out as
the thing it already was:

| helper | phase |
|---|---|
| `opening_parts` / `recv_opening` | the first frame must be a `HeadExchange` |
| `heads_are_ambiguous` | #4380's "do the heads alone identify the joiner?" |
| `admit_peer` | S-1, the #855 passphrase proof, the self check |
| `lock_peer_or_reject` | S-5 per-peer mutual exclusion |
| `build_orchestrator` | `expected_remote_id` / the #4230 claim guard |
| `drive_responder_session` | `run_session`, closing the connection on failure |
| `offer_snapshot_catchup` | the #2503 post-`ResetRequired` merge stream |
| `run_file_transfer_phase` | F-14 |
| `bind_peer_to_key` | the TOFU bind, and #4380's two refusals |
| `record_advertised_name` | #4298 |
| `finish_responder` | the closing log and the protocol shutdown |

`ResponderCtx` carries the six facts settled before the peer speaks (pool, this
device's id, the authenticated endpoint id and its string spelling, the event
sink, the limits), so no helper needs five arguments to say where it is.

The four `reject` exits became `Ok(None)` from the helper that owns them:
`reject(...).await?` then `return Ok(None)`, with the caller returning `Ok(())`.
Same two outcomes as `return reject(...).await`, but the caller can tell
"rejected" from "errored" without reading the callee.

## What is not pure relocation

Three things, all stated rather than buried:

- **`bind_peer_to_key`'s branch chain is flattened** from
  `if / else if / else if / else if` to early returns. Same four branches, same
  order, De Morgan on the third.
- **`heads_are_ambiguous` is computed before `admit_peer`** rather than partway
  through the identity block. It is a pure function of the opening frame and the
  local device id, neither of which admission touches, so the move is safe — and
  the old ordering comment ("computed after, because that is the last reader of
  `stated_device_id` as an `Option`") is gone with the `Option` it described:
  `OpeningParts` holds the value now.
- **One clone dropped.** The old code returned `(claimed_id.clone(), true)` from
  the pairing branch; `claimed_id` had no later reader, so the helper moves it.

## Two mutants nothing can kill, and why that is the honest answer

Four mutants on the new seams. The two that matter most are the two adjacent
`bool`s, which is where a split scrambles arguments without the compiler
noticing:

| mutant | result |
|---|---|
| `bind_peer_to_key(.., heads_ambiguous, pairing_pending)` — swapped | killed (5) |
| `record_advertised_name`'s gate inverted to `pairing_pending \|\| bound_to_this_key` | killed (1: #4230) |
| **`offer_snapshot_catchup` reports it did not speak last** | **SURVIVED — whole suite green** |
| **`run_file_transfer_phase` reports it did not run** | **SURVIVED — whole suite green** |

(All four ran at 968 tests, before this branch took #5031's base; the suite is
969 now.)

The bind and the name are well pinned — #4380's three joiner tests, #4230's two
bookkeeping tests and #3507's pairing round trip all go red on a swap.

The other two are one rule: `spoke_last`, which decides whether this side waits
for the peer's close before tearing the connection down. It is genuinely
load-bearing — `Connection::close` lets the remote discard data it received but
has not delivered, so a wrong `false` throws away our own final frame — and
nothing in this crate can see it go wrong.

`finish_session` returns `Shutdown::Clean` on **both** branches in the happy
path: directly when the peer spoke last, and out of `classify_close` when we
did and the peer closed normally. So the decision leaves no trace in the return
value, and none in the log line that prints it. What separates the branches is a
race, and an in-process `quic_pair` has already read the frame before either
side closes.

That is not a fifth reading of a survivor — it is the first one, a real gap —
but it is a gap no test in this harness can close, and a test that tried would
pin the race rather than the rule. So it is recorded where the next reader will
be standing: `finish_responder`'s doc says the decision is unpinned, why both
branches look identical from outside, and what a wrong value costs. AGENTS.md
asks for exactly that when something cannot be tested.

This was equally true before the split. What the split changed is that the rule
is now three lines in one place instead of two assignments 80 lines apart, so
the next person to touch it can at least see what they are deciding.

## Test plan

```
cargo clippy -p agaric-sync --all-targets   # clean, no `expect` needed
cargo nextest run -p agaric-sync            # 969 passed, 0 failed
```

`handle_incoming_sync_inner` is reached only from this crate's daemon and its
tests, so `-p agaric-sync` is the coverage boundary — checked rather than
assumed, as in #5026, #5028, #5030 and #5031.
