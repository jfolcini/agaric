# Session 1737 — the sync daemon supervisor and state machine splits (#4639)

Refs #4639, eleventh slice: the five `#[expect(clippy::too_many_lines)]`
sites in `agaric-sync` (`sync_daemon/session_supervisor.rs`:
`daemon_loop`, `try_sync_with_peer`, `run_sync_session`;
`sync_protocol/session_state_machine.rs`: `handle_message`,
`head_exchange_outgoing_loro`). Pure moves: every protocol send and
receive, engine call, SQL write and log line keeps its order.

- `daemon_loop` stays as a thin wrapper around `run_daemon`, because the
  Android multicast lock is held in a local binding whose `Drop` releases
  it on function exit; moving it into the helper would release it a frame
  early. Its bind, accept-loop spawn, mDNS attach and the three select
  branches are now `bring_up_endpoint`, `spawn_accept_loop`,
  `run_select_loop`, `run_change_round` and `run_resync_round`. The
  background short-circuit stays inline, because its `continue` targets
  the select loop.
- `SyncSessionContext` is built once above the select loop instead of
  identically in two branches. It is `Copy` and holds only shared
  references, so the literal has no side effects and no drops. The
  per-task context in the change round is untouched: those tasks are
  `'static` and still build from owned clones.
- `try_sync_with_peer` splits into the identity refusal, the dial, the
  session run and the two bookkeeping arms. The three scope guards keep
  their declaration and therefore drop order: the cancel guard is still
  the first local, the peer lock is still taken before the dial and held
  across the session, and the activity counter still reaches zero before
  the flag clears.
- `handle_message` is now a four-line dispatch over per-variant handlers.
  `fail_session` collapses four arms that were byte-identical except for
  one message string, so each message literal still appears exactly once.
- `on_op_log_batch` keeps the name of the message variant it handles, so
  the bulk-equivalence heuristic sees it and the baseline records why it
  is `not-a-fan-out`. The builder had renamed it to dodge the heuristic;
  that guard's own header prescribes a recorded disposition over a
  narrowed scope, because narrowing is how a real fan-out escapes.

## Verified

Reviewer (opus) reconstructed the ordered effect sequence of all five
roots with every helper inlined at its call site — tracing, emits,
protocol send and receive, SQL, `.ok()`, `.unwrap()`, `.expect` and every
string literal — and found each identical to `HEAD`, as was the ordered
sequence of state transitions in the state machine. A Rust-aware lexer
decoding `\`-continuations found the literal multisets differ only by the
five deleted `expect` reasons; the five literals whose continuation
indentation shifted decode byte-identically, and none is a
`STABLE_MESSAGES` entry (all 54 entries keep their raw-source counts).

The three lifetime claims hold. The Android multicast lock is still bound
in `daemon_loop`, whose only other statement is the `run_daemon` tail
call, so it drops after the daemon's teardown. The hoisted
`SyncSessionContext` is unchanged as a type, `Copy` over shared
references with no `Drop`, and both branches built an identical literal;
the borrow checker forbids mutating any field's source while it is held.
The three scope guards keep their declaration and drop order, with the
peer lock still taken before the dial and held across the extracted
session call. The event-sink binding drops a frame earlier but the
allocation's refcount still reaches zero in the same frame, and nothing
observes the count.

- `cargo clippy -p agaric-sync --lib --tests -- -D warnings`: clean, no
  `#[allow]` or `#[expect]` added anywhere.
- `cargo fmt --all -- --check`, `cargo check --workspace --all-targets`:
  clean.
- `cargo nextest run --workspace`: 6318 passed, 13 skipped.
- `cargo test --doc --workspace`: ok.
- `node scripts/check-bulk-equivalence.mjs`: 54 inventoried, no new or
  stale entries.
- Falsified on a copy, restored byte-exact: removing the mirrored
  `session.state` write that `fail_session` collapsed from four identical
  arms reddens
  `orchestrator_rejects_sync_complete_in_wrong_state`, at the assertion
  that the mirrored state must also transition to failed.
