# Session 1029 — per-peer-vv incremental sync (ends full-snapshot churn)

2026-06-15, continuing the sync-hardening track (after #610 in session 1028). Chained off
the merged #610 (same `orchestrator.rs`). The "performant" half of the #87/#610 work.

## Shipped

- **Incremental Loro sync via live version-vector exchange (#87 §10.5 / MAINT-228).** PR #1228.

  Production sync re-exported and re-imported a **full Loro snapshot per space on every
  session** because `head_exchange_outgoing_loro` called `prepare_outgoing` with
  `peer_vv=None` (`orchestrator.rs:825` pre-change). The entire incremental *apply* side was
  already built and tested — `apply_remote`'s `Update` arm, the MAINT-228 reachability gate
  (`classify_from_vv_reachability`), the #792 own-peer fork guard, the #535 write-ahead inbox
  — but **dead in production** because the send side never produced an `Update`.

  This wires the send side via **live VV exchange** (no stale stored per-peer state):
  - New `SpaceVersionVector { space_id, vv }` + a `#[serde(default)]` `loro_vvs` field on
    `SyncMessage::HeadExchange` (`types.rs`). serde-default = wire back-compat (older peer
    omits it → responder falls back to a full snapshot).
  - The initiator's `start()` advertises its per-space Loro version vectors
    (`collect_local_loro_vvs`).
  - The responder feeds the initiator's advertised vv per space to
    `prepare_outgoing(Some(vv))` → `export_update_since(vv)` → `LoroSyncMessage::Update`
    (the delta); a space the initiator didn't advertise (older peer / fresh space) still
    gets a full `Snapshot`.
  - Apply side **unchanged** — the from_vv the responder echoes is the initiator's own vv,
    so the reachability gate is trivially satisfied on the initiator and never false-fires.

  Net: a quiescent re-sync now ships ~nothing instead of a full per-space snapshot.

## Notes / lessons

- **The apply side was already complete and tested** — the change is purely the send-side
  wiring + a back-compat wire field. The hard part (delta apply, reachability, fork guard,
  crash-durable inbox) shipped earlier under MAINT-228/#535/#792; this just stops feeding it
  `None`. Reading the code first turned a feared "large protocol change" into a contained one.
- **Adversarial review caught a real self-own:** reading each engine's vv via `for_space`
  (the only engine accessor) bumps the registry's `dirty_count` — which arms the periodic
  daemon to write a full **disk** snapshot of all spaces on *every initiated session*, even
  quiescent ones. That trades network churn for disk churn — the opposite of the goal. Fixed
  by adding a read-only `LoroEngineRegistry::loro_vv(space_id)` accessor that reads under the
  lock without the `dirty_count` side effect (and never lazily creates an engine). The
  registry's own docstring had pre-declared the read-only over-count "harmless"; for a
  churn-reduction path it isn't.
- **`issue602_two_edited_devices_converge` now exercises the Update path end-to-end** (both
  devices register the space → the initiator advertises a vv → the responder sends a delta),
  so it doubles as the incremental convergence regression. The new
  `head_exchange_streams_update_when_initiator_advertises_vv` adds an explicit round-trip:
  asserts the responder picks `Update` (vs `Snapshot` when no vv), feeds it into the
  initiator's `apply_remote`, and asserts convergence (`ApplyOutcome::Imported` + the peer's
  block lands in SQL). Plus a serde back-compat test (`HeadExchange` without `loro_vvs`).
- Verification: clippy clean; 501 sync+loro nextest passed, 0 failed.

## Remaining sync follow-ups (tracked on #87)

- Single-session bidirectionality (immediate, not interval-bound, propagation).
- A true two-process loopback-TLS convergence harness (§2B — all convergence coverage is
  still single-process pumps).
- Hard-delete (purge) projection in `apply_remote` (§2A).
