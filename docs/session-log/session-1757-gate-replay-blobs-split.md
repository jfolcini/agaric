# Session 1757 — gate_replay_blobs, and a third copy of a rule that exists once

`gate_replay_blobs` is the batch boot-replay gate: one verdict per inbox blob,
with #792, #3188, #3189, #3190 and #3194 all interacting inside it. It carried
an `#[expect(clippy::too_many_lines)]`; clippy now accepts the file without one.
Workspace attribute count **29 → 28** (anchored grep, measured on both sides).

| helper | what it is |
|---|---|
| `decode_and_screen_own_peer` | the first sweep: decode once, settle what one blob can settle alone |
| `claim_own_lineage` | #3190 — claim this blob's own-peer range, or say why it clashes |
| `advance_base` | widen the cumulative reachability base by a blob's end frontier |
| `finalize_gate_decisions` | unwrap the positional slots |

The #3188 fixpoint stays in `gate_replay_blobs`, which is the only part that is
really about the batch as a whole.

## The #792 rule had three statements, and one of them says so

`own_peer_fork_in_meta` exists, and its own doc says why:

> Split out so `own_peer_fork_in_blob` and `screen_inbound_blob` cannot drift:
> there is exactly one statement of what a fork is.

`gate_replay_blobs` was carrying a third, inline copy — the same guard and the
same 300-character message, wrapped differently. Unwrapped and with the
placeholder names normalised, the two strings are identical, which is what made
the collapse safe to make rather than to assume. The gate now calls the shared
definition, and the function that was written to stop drift has three callers
instead of two.

This is the same shape as #5024's note and #5023's `has_fulltext`: the thing
that must agree in two places is the thing that eventually does not.

## Nine mutants, three survivors, one real gap

| mutant | result |
|---|---|
| invert the `local_own` guard in `claim_own_lineage` | killed (2) |
| overlap test `<` → `<=` | killed (2) |
| never record the accepted own range | killed (2) |
| `advance_base` keeps the LOWER counter | killed (3) |
| `advance_base` inserts `0` for a new peer | killed (9) |
| **decode failure verdict flipped to `Unreachable`** | **SURVIVED** |
| **ungated accept claims a frontier instead of none** | **SURVIVED** |
| the carry-nothing carve-out `blob_end <= 0` → `< 0` | SURVIVED — see below |
| the `finalize` fallback flipped to `Accept` | SURVIVED — unreachable by construction |

**The decode-failure rule was untested.** The batch gate's response to a blob
whose metadata will not decode — accept it, ungated, claiming no end frontier,
and let the real import surface the error — could be flipped either way with
the whole estate green. `own_peer_fork_in_blob_tolerates_malformed_bytes_792`
pins that tolerance on the *single-blob* guard; nothing pinned it on the batch
gate. `gate_replay_blobs_accepts_an_undecodable_blob_ungated_3188` closes both
arms: the verdict, and the empty `end_vv` that keeps the caller from being
asked to prove the op-log reached a frontier the blob never declared. Against
either mutant: 27 run, 1 failed, the new test alone.

The last two survivors are not gaps, and saying so is the point:

- The `blob_end <= 0` carve-out keeps an invariant rather than changing an
  answer. The range it would otherwise record is `[start, 0)`, and the strict
  overlap test can never match an empty range, so no test can distinguish the
  two. It stays — deleting it would leave the gate quietly depending on empty
  ranges being inert — and the helper's doc now says that, so the next reader
  does not mistake it for dead code or try to test it.
- The `finalize_gate_decisions` fallback is unreachable by construction: every
  slot is decided by the sweep or the fixpoint. It is a deliberate
  no-panic choice on the crash-recovery path, which is data-loss handling, not
  a rung on the ladder.

## Coverage boundary

Unlike session-1756's store slice, the app crate does not reach this code:
`gate_replay_blobs` has exactly one non-test consumer, `agaric-sync`'s
`replay_inbox_batch`, and the four new helpers are module-private. Running
`agaric-engine` (1028) and `agaric-sync` (968) in full is therefore the whole
of it, rather than a subset that misses where the coverage lives.

Both crates were run SEPARATELY: compiling the two test binaries together was
OOM-killed and took the container with it (exit 137).
