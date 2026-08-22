# Session 1377 — Asking the bind's question at the moment the writes happen (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | `#4230` |
| **Items modified** | — |
| **Tests added** | +3 (backend, real loopback QUIC sessions) |
| **Files touched** | 4 + this log — see the PR's file list |

**Summary:** the responder has two branches. On the **bound** one it resolves the row by the
key the QUIC handshake authenticated and passes it as `expected_remote_id`, which the FSM
takes in preference to the peer's advertised heads — sound. On the **pairing** one it
deliberately leaves `expected_remote_id` unset, so `resolve_remote_peer_id` falls back to
`claimed_id`: the first non-self **advertised head**, an unverified claim. The bookkeeping is
then stamped on the row that claimed id names.

`streamed_at` (now read by #4203's refusal-suppression gate) and — worse —
`loro_vv_bytes`, the **export floor** the next session computes its incremental update from.
The binding is protected by `peer_is_bound_to_another_key`, but that runs **after** the
session, and the writes happen during it.

**The fix asks the bind's own predicate at the earlier moment**, rather than deferring the
writes until after the bind. Deferring would have meant hoisting `peer_advertised_loro_vvs`
out of the FSM and re-plumbing three call sites across two layers on a security path;
asking `peer_is_bound_to_another_key` at write time gives the same decision for a fraction
of the churn. Review verified that equivalence rather than accepting it: both sides call the
same predicate with the same `(claimed_id, authenticated endpoint_id)`, and the FSM's
`remote_device_id` is provably the same string the daemon scanned for `claimed_id`.

**No protocol semantics changed, and that was the point.** A refused claim still completes
its session, still converges, still gets `SyncComplete` — only the write onto the *other*
device's row is skipped. #2481 makes advertising another device's frontier **legitimate**
(`HeadExchange.heads` carries every device frontier in the local op log, ordered by device
id, so a real joiner advertises a foreign head first whenever it sorts lower), so failing
the session would have broken real pairing. Review confirmed #2481 says that.

**What review corrected.** The safety argument had two halves; one was right and one
overclaimed.

- **Right, and stronger than stated:** deferring-until-bind is not merely *equally* holed on
  an unbound row — it is **worse**, because `peer_is_bound_to_another_key` permits an unbound
  row, so the deferred design would run `bind_endpoint_id` and hand the claimant the row.
- **Wrong:** "such a peer has no pinned key to mismatch, so there is nothing to suppress"
  is false at the function's scope. `loro_vv_bytes` on an unbound row **is** read as an
  export floor (`head_exchange_outgoing_loro` reads it with no binding condition, and
  `bind_endpoint_id` is `ON CONFLICT DO UPDATE SET endpoint_id`, so a poisoned floor survives
  the real device's later bind), and `streamed_at` on an unbound row **is** read —
  `peer_pulled_from_us_recently` is reached from five `record_initiator_failure` sites, only
  one of which requires a pinned key. Both bounded (`apply_remote`'s reachability gate forces
  a snapshot, so it degrades to a forced full resync rather than silent corruption), but the
  sentence is now the residual and its bounds instead of a dismissal. Filed as **#4251**.

Review also named the one genuinely divergent case the docs did not: a **concurrent re-bind
of the claimed row mid-session**. The guard permits at T1, another session binds, the bind
would refuse at T2 — so "one predicate asked at both moments" is only true while the row's
binding holds still. The mirror exists too (`delete_peer_ref` mid-session). Both benign, both
strictly better than the status quo, now stated in the doc.

**Fail-closed, verified:** `may_key_bookkeeping_on` has exactly two returns, the
`list_peer_refs` result is handed to the predicate as a `Result` with no `unwrap_or_default`,
no `?`, no `ok()`, and the predicate's only `Err` arm denies. There is no path from an error
to a permit.

**No fourth writer.** Three `peer_refs` writers on the responder path, all gated.
`snapshot_transfer`'s writes are initiator-side, verified independently.

**Falsification, both directions.** Disarming the guard reddens the acceptance test reporting
*both* writes — the victim's `loro_vv_bytes` replaced by the attacker's real per-space
frontier JSON, and `streamed_at` re-stamped — while leaving the binding untouched, which
independently confirms #800's bind check was already sound. Review added the mutation that
matters more: a **blanket deny** inside any pairing window reddens the *legitimate* arm, so
the guard is held to a narrow refusal rather than a safe-looking one.

**Verification:** `cargo nextest run --workspace` → 6005 passed (1 known-flaky timing test,
passed on retry), 7 skipped; `cargo check --all-targets` clean; the three SQL guards exit 0.
No SQL changed, so no `.sqlx` regeneration.

**Also filed:** **#4252** — the export-floor **read** is still keyed on the unverified claim
this fix stopped writing under, so a legitimate #2481 joiner claiming a foreign head gets a
truncated stream and an unnecessary snapshot round trip. The write side now asks the
question; the read side does not.
