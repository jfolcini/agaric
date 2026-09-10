# Session 1669 — the `ApplyHost` double, checked against the real host

#3443's 2026-09-04 audit named one gap that is not a relocation: sync owns the
`ApplyHost` trait, the engine's `Materializer` implements it, and every
session and driver test in `agaric-sync` runs against a `RecordingApplyHost`
double whose assumptions nothing compared with the real impl. The maintainer's
2026-09-08 status repeated it as the one item outside the narrowed slice worth
a follow-up.

## What the contract is

Reading the consumers rather than the trait: `session_state_machine.rs` reads
`loro_state()` at several points of one exchange, awaits `flush()` after every
import, and `sync_files` falls back to deriving the attachment root from the
pool when `app_data_dir()` is `None`. So the contract has three clauses, and
`contract_tests` in `apply_host.rs` asserts them through one `exercise`
function run against both hosts:

- `loro_state()` returns one registry (`Arc::ptr_eq` across two calls);
- `flush()` resolves, under a timeout, after `enqueue_inbound_sync_rebuilds`
  with one changed block and again with the #2264 empty import;
- `app_data_dir()` is `None` with no registered root.

What the real host does with the rebuilds stays the engine's to pin
(`materializer/tests/cache_rebuild.rs`); this pins only that the double and
the materializer agree on what a session may rely on.

## The stale count

`scheduled-deep-checks.yml`'s shard comment said "the eleven reverse tests"
that stayed app-side; the status comment counted ten. The count is dropped
rather than corrected, for the reason session 1665 gave: a number in a comment
only drifts.

## Verified

- `cargo nextest run --workspace -E 'test(contract_tests)'` — 5 passed (the two
  new `apply_host::contract_tests` plus the three `_3443` engine suites the
  filter also matches).
- Falsified against a copy, each restored and `cmp`-verified: the double
  handing out a fresh `LoroState` per call reddened the double's test on the
  `ptr_eq` clause; a never-resolving `flush` on the real impl reddened the
  materializer's test on the timeout; a rejecting `enqueue_inbound_sync_rebuilds`
  on the real impl reddened it on the enqueue clause. The other host stayed
  green each time.
- Not run locally: the full nextest suite and clippy (CI carries them; the
  laptop is in use).
