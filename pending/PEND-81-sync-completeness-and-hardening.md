# PEND-81 — Make sync complete & rock-solid

**Goal:** take multi-device sync from "works for the common case (LAN, single
space, content edits) but silently diverges on metadata + is unverified
end-to-end" to **complete** (every op type's remote changes land correctly in
SQL) and **rock-solid** (proven by an automated multi-instance E2E harness +
failure-mode tests + a manual 2-device smoke checklist).

This plan is **transport-independent** — it is about the data model, projection,
verification, and robustness of sync, NOT the wire transport. The transport
migration (mDNS + TLS + TOFU → iroh QUIC) is **PEND-10** and is orthogonal: do
not duplicate transport hardening here (see §8). Most of this plan is needed
regardless of whether iroh ever lands.

> **Status note (2026-05-24).** Several sync correctness bugs found by the CR
> campaign already shipped this cycle and are NOT re-listed as work here: F1
> inbound-sync cascade-wipe (UPSERT, not REPLACE), F3 pairing daemon-activation
> (decoupled from the junk `peer_refs` row via a `sync.pending_pairing` marker),
> plus the F4/F5 space-correctness fixes. This plan covers what remains.

**PROGRESS (2026-05-25): §2A items #1 (properties) + #2 (tags) shipped.**
`apply_remote` now re-projects inbound **typed properties** (via
`property_definitions` routing — no engine-model migration needed) and **tags +
inherited tags** (`reproject_block_*_from_engine` + `tag_inheritance::rebuild_all`)
from the engine to SQL. **Remaining §2A:** #3 soft-delete/restore (needs Phase-2
real `deleted_at`), reserved hot-path property keys + agenda derivation, #4 derived
caches beyond `block_tag_inherited` (FTS/pages/agenda), #5 hard-delete cascade; plus
the targeted (non-global) inheritance reindex perf follow-up.

---

## 1. Current architecture (one screen)

- **Transport:** WebSocket-over-TLS, self-signed ECDSA certs, TOFU cert-pinning,
  mDNS discovery (RFC-1918-scoped), random port. 10 MB JSON/message cap; large
  blobs (snapshots, attachments) stream in ~5 MB binary frames.
  `sync_net/{connection,tls,websocket}.rs`, `sync_daemon/{discovery,server}.rs`.
- **Session state machine:** `Idle → ExchangingHeads → StreamingOps →
  ApplyingOps → Complete`, with `ResetRequired` (snapshot catch-up) and
  `Failed` side-exits. `sync_protocol/orchestrator.rs`.
- **Data flow:** the sync layer transfers **Loro CRDT state deltas** (engine
  bytes). On receive, `apply_remote` (`sync_protocol/loro_sync.rs`) imports the
  bytes into the per-space Loro engine and projects each changed block to SQL via
  `project_block_full_to_sql` (now an UPSERT of the **core columns only**).
- **Two models, one mismatch (the root cause):**
  - The **Loro engine** stores a *reduced* model: 5 core block fields,
    **string-only** property values (`apply_set_property(value: Option<&str>)`,
    `engine.rs`), and a **seed-only** `deleted_at` *marker* (not the real
    timestamp, and descendants are never marked in the engine).
  - The **SQL materialized view** stores the *full* model: typed property columns
    (`value_num`/`value_date`/`value_ref`/`value_bool`), `deleted_at` timestamps
    with a **descendant cascade** (CTE), reserved hot-path columns
    (`todo_state`/`priority`/`due_date`/`scheduled_date`), `page_id`, tags +
    inherited tags, and all derived caches.
  - The **materializer** (`materializer/handlers.rs::apply_op_tx`) projects
    **local** ops to SQL *completely and correctly* (typed values from the op
    payload, `deleted_at` timestamp + descendant CTE, tags + inheritance, cache
    reindex). But **remote changes arrive as CRDT bytes, not op records**, so they
    never go through the materializer — and the engine alone can't reconstruct the
    full SQL model.

---

## 2. What's actually broken / missing

### A. Data completeness — remote changes silently don't reach SQL (CRITICAL)

`apply_remote` projects only core columns. On an inbound sync, these remote
changes are **not** projected to SQL (the engine has them; SQL doesn't), so
SQL-backed views/queries silently diverge until a snapshot RESET / restart-replay:

1. **Typed properties** — remote `SetProperty`/`DeleteProperty` don't update
   `block_properties` or the reserved hot-path columns. (And the engine stores
   property values as **strings only**, so they can't even be re-projected with
   correct typing from the engine — `value_num`/`date`/`ref`/`bool` are lost. This
   is the hard part — see §3.)
2. **Tags** — remote `AddTag`/`RemoveTag` don't update `block_tags` /
   `block_tag_inherited`. (Re-projectable from `engine.read_tags`; the only
   *immediately*-safe item — see Phase 1.)
3. **Soft delete / restore** — remote `DeleteBlock`/`RestoreBlock` don't
   propagate. The engine marks only the delete *seed* (no descendants, no real
   timestamp), so per-block re-projection from the engine would **resurrect**
   soft-deleted descendants. Needs the real op (timestamp + descendant CTE).
4. **Derived caches** — `tags_cache`, `pages_cache`, `agenda_cache`,
   `block_tag_inherited`, `block_links`, FTS are not rebuilt after inbound sync
   (the orchestrator holds a `materializer` handle that is currently
   `#[expect(dead_code)]`).
5. **Hard delete (purge) cascade** — remote purge vs the SQL descendant cascade
   is not wired.

### B. Verification — no true end-to-end test (HIGH RISK)

- Every sync test is **single-process**: two registries/engines in one test, or
  the orchestrator logic in isolation. The real socket + TLS + framing + mDNS +
  pairing path is **never** exercised by an automated convergence test.
- **Untested failure modes:** connection drop mid-stream, corrupt/oversized
  frame, partial message, snapshot-fallback on real log compaction (+ the M-58
  reachability check), retry/backoff across sessions, **multi-device (3+)
  convergence**, simultaneous initiator+responder.
- Consequence: the items in §2A and the whole network path can regress invisibly.

### C. Robustness / efficiency

1. **No incremental sync** — `peer_refs.loro_vv_bytes` exists but is **not
   wired**; every sync effectively re-sends full state instead of a delta since
   the peer's version vector. (Verify in Phase 0; if true, this is both a perf and
   a correctness-surface issue.)
2. **Dual backoff** (MAINT-168) — FE (`useSyncTrigger.ts`, 60s→600s) and backend
   (`sync_scheduler.rs`, 1s→60s) run independent backoffs. Not a bug, but
   unprincipled; revisit for one authoritative scheduler.
3. **No transfer progress to the UI** for snapshot/attachment streaming
   (`send_binary_streaming_with_progress` exists, not hooked to the FE).
4. **Stale diagnostic** — `recv` timeout error says "30s" but `RECV_TIMEOUT` is
   180s (`sync_net/connection.rs`; also in `REVIEW-LATER.md` as `CR-MINOR`).
5. **Error surfacing** — audit that every `Failed`/timeout path emits a
    `SyncEvent::Error` the FE can show; today silent stalls are possible.

### D. Security / hygiene (within the AGENTS.md "no malicious actor" threat model)

1. **mDNS fallback** can announce on all interfaces when no RFC-1918 address is
    found (`enable_addr_auto()`), including public IPs on unusual networks.
2. **mTLS client cert is optional** (`client_auth_mandatory=false`); identity is
    checked post-TLS. A deliberate convenience trade-off — decide whether to keep.
3. **No pairing-passphrase expiry / no peer-revocation UX.** Decide what (if
    anything) belongs in the threat model.

---

## 3. The central decision — how to make inbound sync project completely

> **DECISION (locked 2026-05-24): Option A — enrich the Loro engine, re-project
> from engine state.** PEND-80 is the committed foundation that delivers this
> (typed property values, real `deleted_at`, `LoroTree`). Option B (op-based sync)
> is **rejected**: it is a larger protocol change (op-DAG diff/transfer +
> causal-ordering/idempotency/dedup) and would duplicate the version-vector
> machinery, whereas Option A keeps the state-based CRDT transport and is bounded
> to the engine + projection. The data-completeness phase (Phase 1) therefore
> depends on PEND-80 Phase 0–1 landing first. The Phase 0 spike below is reframed
> to **validate Option A** (lossless engine→SQL re-projection), not to choose A vs B.

The data-completeness gaps in §2A all stem from one fact: **remote changes arrive
as CRDT state, but the only complete projection logic is op-based (the
materializer), and the engine's reduced model can't reconstruct the full SQL
model** (string-only properties, seed-only `deleted_at`). Two coherent ways
forward were considered; **Option A is now locked** (see the decision banner).

### Option A — Enrich the Loro engine model, then re-project from the engine ✅ LOCKED (delivered by PEND-80)

Make the engine store the *full* per-block state (typed property values; real
`deleted_at`; enough to drive the descendant cascade), so `apply_remote` can
re-project everything losslessly from engine state.

- **Loro supports this** — not a capability gap. `LoroValue` has `I64`/`Double`/
  `Bool`/`String`/`Binary`/`Null` (the engine already stores `position` as `I64`),
  so typed property values map directly (`value_num→Double`, `value_bool→Bool`,
  text/ref/date→`String`); the string-only storage today is a deliberate
  simplification ("string values only at this stage", `engine.rs`). The real
  `deleted_at` is trivially a `String`. `LoroMap` is per-key LWW, so concurrent
  typed-value edits converge exactly as string values do today (no new merge
  problem).
- **Pros:** keeps state-based CRDT transport; CRDT convergence for all fields;
  contained to the engine + projection.
- **Cons (all app-level, not Loro):** duplicates projection logic the
  materializer already has; you still hand-code the descendant-delete cascade
  (Loro won't cascade a subtree soft-delete for you — flat `LoroMap`+`parent_id`,
  not `LoroTree`) and the reserved-key→hot-path-column routing; and it needs a
  Loro snapshot/op **format migration** (string→typed values; real timestamp) +
  relaxing the read paths that currently reject non-`String` property values.

### Option B — Operation-based sync: transfer op_log entries, replay via the materializer ❌ REJECTED (2026-05-24)

Transfer the missing **op_log records** (not Loro bytes), insert them with
`dag::insert_remote_op` (hash-chain/parent validation already exists), and replay
them in causal order through `materializer::apply_op_tx` — the *same* path local
ops take. The Loro engine stays as the content-merge function (`apply_op_tx` calls
`engine.apply_*`), so character-level convergence is preserved.

- **Pros:** **reuses the complete, battle-tested materializer** → typed
  properties (op payload carries the type), `deleted_at` timestamp + descendant
  CTE, tags + inheritance, caches — *all correct for free*. Pure event-sourcing;
  the op_log becomes the sync unit; natural audit trail.
- **Cons:** a real protocol change (op-DAG diff/transfer instead of Loro
  state-delta); causal-ordering + idempotency + dedup must be correct; need to
  reconcile with the existing HeadExchange + Loro version-vector machinery.

**Decision: Option A (locked).** The dual-model impedance is removed by making the
engine lossless (PEND-80), not by changing the transport. Option B's payoff (reuse
the materializer) does not justify a new op-DAG diff/transfer protocol plus the
causal-ordering/idempotency/dedup and version-vector reconciliation it would
require; Option A stays inside the existing state-based CRDT transport and is
contained to the engine + projection. The PEND-80-side cons (hand-coded descendant
cascade + reserved-key routing) are accepted — that logic already exists in the
materializer and is reused, not rewritten. Phase 0 is therefore a **validation
spike for Option A** (prove lossless engine→SQL re-projection for one typed
property + one subtree delete), not an A-vs-B bake-off.

---

## 4. Phased workplan

### Phase 0 — Validate Option A + plan Phase 1 (time-boxed, ~1–2 weeks)

- **A vs B is already decided (Option A — see §3).** This phase validates it on
  the PEND-80-enriched engine: re-project one typed `SetProperty` + one
  `DeleteBlock` (subtree) from engine state and assert SQL matches a
  locally-applied equivalent. Confirms PEND-80's lossless read surface is
  sufficient for `apply_remote` to project completely.
- Verify the §2C-#1 claim (is incremental sync actually wired?) and the
  is-conflict/convergence story.
- **Output:** a migration/compat note (Loro snapshot format, engine-format
  version, version-vector reuse — coordinate with PEND-80 §4) and the Phase-1 task
  breakdown. **Kill criterion:** if PEND-80's enriched engine still can't drive a
  lossless re-projection, escalate back to PEND-80 Phase 0 rather than proceeding.

### Phase 1 — Data completeness (the bulk; Option A — re-project from the enriched engine)

Make every op type's remote change project correctly to SQL, with tests per type:

- Typed properties (`SetProperty`/`DeleteProperty`) incl. reserved hot-path cols.
- Tags (`AddTag`/`RemoveTag`) + inheritance.
- Soft delete/restore with timestamp + descendant cascade.
- Hard delete (purge) cascade + attachment file cleanup.
- Move/create/edit (mostly covered by the F1 UPSERT; verify).
- Derived-cache rebuild after inbound sync (wire the orchestrator's
  `materializer`; remove the `#[expect(dead_code)]`). Prefer targeted reindex
  over a full global rebuild per sync.
- **Quick win available now (do first, independent of PEND-80):** re-project
  **tags** from `engine.read_tags` in `apply_remote` (two-phase: upsert all
  blocks, then replace each block's `block_tags`) + enqueue the tag/content cache
  rebuilds. Closes §2A-#2 + #4-for-tags safely; the typed-property and
  delete/restore items wait on PEND-80's enriched engine.

### Phase 2 — Verification harness ("rock solid" centerpiece; M–L)

- **Two-instance E2E test** over real loopback TLS sockets: two full
  pools/engines/daemons, generate divergent ops on each, run a real session,
  assert **byte-for-byte SQL + engine convergence** for content, tags, typed
  properties, soft-delete/restore, moves, and purges.
- **Failure-mode tests:** connection drop mid-stream, corrupt/oversized frame,
  partial message, snapshot-fallback on real compaction (+ M-58 reachability),
  retry/backoff across sessions.
- **Multi-device convergence:** 3-device round-robin; simultaneous
  initiator+responder; idempotent re-sync (no drift on repeated syncs).
- **Attachment transfer** over the socket incl. streaming + the 50 MB / 256 MB
  caps.
- mDNS discovery can stay mocked (it's environment-dependent); everything above
  the socket must be real.

### Phase 3 — Robustness & efficiency (M)

- Incremental sync via per-space `loro_vv_bytes` (or op-DAG heads under Option B)
  so a sync sends only the delta. Test "no new ops → no-op sync."
- Unify / document the backoff story (MAINT-168).
- Wire snapshot/attachment **transfer progress** events to the FE.
- Fix the recv-timeout diagnostic string (CR-MINOR).
- Audit + guarantee `SyncEvent::Error` on every failure path; surface a sync
  status indicator in the FE.

### Phase 4 — Security / hygiene within the threat model (S–M; mostly decisions)

- Decide: mTLS client-cert mandatory? mDNS public-interface fallback scoping?
  pairing-passphrase expiry + peer-revocation UX? Each is a documented deliberate
  non-policy today; this phase is to make those choices explicit, not necessarily
  to change them.

---

## 5. Definition of "rock solid" (acceptance criteria)

- Every op type's remote change projects to SQL identically to the local path
  (one test per type; asserted against a locally-applied oracle).
- The two-instance E2E harness passes for content/tags/typed-props/delete/
  restore/move/purge convergence, is idempotent on re-sync, and covers the §2B
  failure modes.
- Incremental sync: a second sync with no new ops transfers ~nothing.
- A documented **manual 2-device smoke checklist** passes on a real build (pair,
  edit on each, add/remove tags, set typed props, delete+restore a subtree,
  attach a file, kill WiFi mid-sync and recover).
- No silent stalls: every failure surfaces a `SyncEvent::Error` to the FE.

---

## 6. Relationship to PEND-10 (iroh)

PEND-10 replaces the **transport** (mDNS+WebSocket+TLS+TOFU → iroh QUIC with NAT
traversal/relay) and explicitly keeps the sync_protocol state machine, op log,
merge engine, and threat model. **This plan touches none of the transport** — the
data-model/projection (Phase 0–1), the E2E harness (Phase 2, written above the
socket so it survives a transport swap), and most robustness items are needed
regardless. **Do Phase 0–2 independent of iroh.** Defer transport-coupled
robustness (connection pooling, relay, NAT) to PEND-10. If PEND-10 is imminent,
still do the data-model + harness first — a transport swap on top of incomplete
projection just moves bytes faster between diverging databases.

## 7. Cost / Impact / Risk

- **Cost:** L (multi-month epic). Phase 0 ~1–2 wk; Phase 1 L (the chosen approach
  is the bulk); Phase 2 M–L (the harness is the work); Phase 3 M; Phase 4 S–M.
  Schedule phase-by-phase — each phase is independently landable, and Phase 0
  gates the rest.
- **Impact:** HIGH for anyone who actually adopts multi-device sync — today remote
  metadata (tags, typed properties, deletes) silently diverges. **Note: the
  maintainer does not currently use sync**, so the *present* user-facing impact is
  ~zero; this is "make the feature trustworthy before relying on it." Weigh that
  before scheduling ahead of in-use features.
- **Risk:** HIGH-ish — this is the most concurrency- and failure-mode-sensitive
  subsystem, and the full handshake can only be validated with the new harness +
  real devices. Phase 0 + the E2E harness exist specifically to de-risk it.

## 8. Open questions

1. **Option A vs B** — ✅ **settled 2026-05-24: Option A** (enrich engine via
   PEND-80, re-project from engine state). Option B (op-based sync) rejected. See §3.
2. **Sequence vs PEND-10** — do the data-model + harness now, or wait until the
   transport decision (iroh) is made? (Recommendation: data-model + harness now;
   they're transport-independent.)
3. **Conflict visibility** — `is_conflict`/`conflict_source` were dropped
   (PEND-09); Loro convergence is the only truth. Is silent LWW/CRDT convergence
   acceptable, or does "rock solid" want surfaced conflicts for concurrent edits
   to the same field? (Verify the PEND-09 claim in Phase 0.)
4. **Scope of the E2E harness** — real loopback TLS sockets (recommended) vs a
   lighter in-process transport double. How much network-failure simulation is
   worth maintaining in CI?
5. **Threat-model choices (Phase 4)** — keep mTLS optional / mDNS fallback /
   no-expiry as-is, or tighten?

> **Note:** this is an epic. When scheduled, each phase (or even each op type in
> Phase 1) can become its own `PEND-*` so reverts stay surgical. Add the index
> row in `pending/README.md` when this lands (left untouched here — the index was
> being edited concurrently).
