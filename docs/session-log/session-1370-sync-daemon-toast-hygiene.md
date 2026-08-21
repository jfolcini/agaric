# Session 1370 — One mechanism, not three patches: the repeat-toast memory becomes a bounded set (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | `#4203`, `#4202`, `#4201` |
| **Items modified** | — |
| **Tests added** | +15 (backend) |
| **Files touched** | see PR #4232's file list |

**Summary:** Three follow-ups from #4197's review that turned out to be three properties of
one mechanism, so the mechanism changed once rather than three times.
`BackoffState.last_reported_error: Option<String>` — a single slot read and written through
**three separate** acquisitions of the scheduler's `backoff` mutex — becomes
`reported_errors: Vec<String>`, a bounded set of the streak's already-reported texts,
consulted and written through **one** new method `record_failure_and_take_report`.

- **#4201** — the set is what fixes alternating faults. A peer failing `A, B, A, B, …` never
  matched a single slot, so suppression never engaged and #4084's forever-toast returned at
  half rate. Overflow evicts the **oldest**, making that text reportable again: noisier,
  never quieter.
- **#4202** — collapsing check-and-record into one acquisition *removes* the interleaving
  window rather than documenting it, and does so without holding the lock across the
  event-sink call.
- **#4203** — the pinned-identity refusal now routes through the same gate.
  `record_pull_failure` becomes `record_initiator_failure` so the name stays honest.

**The review broke the load-bearing claim, and that is the important part of this session.**

Routing a *security-relevant* refusal through suppression was justified by: `streamed_at` is
stamped by the responder path, which resolves an inbound session on the key the QUIC
handshake **authenticated**, so a fresh stamp is positive evidence that the device holding
the *pinned* key streamed to us, and an impostor "can never refresh it".

Traced end to end, that is true of the **bound-peer** branch and false of the other one. On
the `pairing_pending` branch (`sync_daemon/server.rs:532-671`) the responder deliberately
leaves `expected_remote_id` unset, so `resolve_remote_peer_id` falls back to `claimed_id` —
the first non-self **advertised head**, an unverified claim. A device that proves the
pairing passphrase can name any existing paired peer and have `record_stream_in_tx` stamp
that peer's row.

The suppression stays: exploiting it needs an open 300 s pairing window *and* the
passphrase, and if the impostor is alone on the wire the row goes stale within two resync
intervals and the refusal shouts every cycle again. But the sentence licensing the change
was wrong, and the comment now states the exception and its gating instead. Filed as
**#4230**, where the worse half lives — the same claimed-id path also overwrites
`loro_vv_bytes`, the export floor for the next session, which is a data-correctness problem
with nothing to do with toasts.

**On "derived, not picked".** `MAX_REMEMBERED_REPORTS = 8` was presented as derived from the
five failure sites in `try_sync_with_peer`. The count of *sites* is right (five), but only
**four** distinct text builders exist, and two sites interpolate an iroh `Display` — so the
number of distinct texts one peer can produce is unbounded, not five. Eight is a bound with
a safe overflow, not a derivation. Recorded rather than restated, because the overflow
behaviour is what actually makes it safe.

**Three more fixes the review applied**

- The iroh `Display`-stability test built its endpoint with the **real system DNS resolver**.
  No query is issued today, so it was green — but every other endpoint-building test here
  uses a recording resolver precisely so a test that started phoning home would hang rather
  than pass quietly. It now uses `RecordingResolver` and **asserts no queries were made**, so
  "no network" is pinned rather than assumed.
- `remember_reported_failure` shipped as plain `pub` with a doc line saying production never
  calls it. A method that writes *"the user has already been told this"* without the user
  having been told is a hole, and a doc comment is not a boundary. Now
  `#[cfg(any(test, feature = "test-util"))]`, verified by compiling `agaric-sync` without
  that feature.
- The section header claimed "five user-facing failure texts … these five functions" against
  three functions and one constant, and omitted `Sync cancelled: {e}` — the initiator's one
  user-facing error text that deliberately does **not** route through the gate.

**What the change can and cannot suppress:** it can withhold a text byte-equal to one of the
last 8 reported for *that peer* in *that streak*, and only while the peer is demonstrably
still pulling from us. It cannot withhold a first report of any text, a text differing by one
byte, anything while the peer is dark in both directions, anything after `record_success` or
`clear_backoff`, or a text evicted by the cap. Every failure is still booked in the backoff
and still logged.

**Verification:** `cargo nextest run --workspace` → 5979 passed, 7 skipped.
`cargo check --all-targets` clean; `cargo check -p agaric-sync --lib` (no `test-util`) clean.
The #4202 concurrency test was run 20× against the fix (deterministic green) and against a
split-acquisition mutant (reliably red) — the builder's first version of it was green 3/3
against broken code and was rewritten to race a fresh peer per round.

**Also filed:** `#4231` — `SyncScheduler.backoff` is never pruned for a peer that never
succeeds, and its keys come from mDNS announcements. Pre-existing; this PR multiplies each
stuck entry's payload by up to eight strings.

**Commit plan:** single commit on `claude/sync-daemon-toast-hygiene`, shipped as PR #4232.
