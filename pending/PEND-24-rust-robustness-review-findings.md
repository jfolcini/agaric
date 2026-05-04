# PEND-24 — Rust robustness review findings (post-validation)

## Origin

Two-pass review run 2026-05-04: 7 parallel discovery subagents over the
whole Rust backend (~183 KLoC, 210 files), then 4 parallel validation
subagents that re-read the cited file:lines and surrounding context to
weed out hallucinations, exaggerations, and out-of-scope items.

The validation pass rejected **~50 %** of the original findings —
13 outright FALSE (reviewer misread the code), ~17 OUT-OF-SCOPE
(adversarial-peer threats that don't apply to the single-user model,
frontend contracts, theoretical races inside `BEGIN IMMEDIATE` tx,
intentional convergence-via-GC), and 4 ALREADY-KNOWN (existing
`MAINT-` / `M-` / `L-` / `TEST-` tracker comments in the source).

What's below is the **non-nit, post-validation set**: 2 CRITICAL,
3 HIGH, 6 MEDIUM. The 4 LOW findings (string typos, comment fixes,
documented-but-uncalled GC, marker-wording inconsistencies) are
not in this file — bundle them into a `chore:` commit when one of
the bundles below is touched.

> **Excluded by validation:** the 13 FALSE findings (e.g. import-depth
> off-by-one, `Arc<str>` use-after-free, `let _ = existing` redundancy,
> snapshot dropping `conflict_source`, `list_agenda_range` cursor
> stability, history-query missing space filter — all verified at
> file:line as misreads) are **not** here. The 4 already-known
> items (`MAINT-164` agenda timezone drift, `M-36`/`M-37` GCal
> disconnect, `TEST-38` Windows UNC, `L-94` tag-inheritance race)
> stay in their existing trackers.

## TL;DR

| ID | Severity | Cost | Risk | Impact | Status |
| --- | --- | --- | --- | --- | --- |
| **C1** — MCP `create_page` bypasses space-isolation invariant | CRITICAL | S (~1 h) | low | high | ✅ done session 663 — `create_page` routes through `create_block_inner_with_space`; `space_id` required on tool schema |
| **C2** — MCP `append_block` doesn't validate parent's space | CRITICAL | S (1-2 h) | low | high | ✅ done session 663 — `validate_block_in_space` helper + `space_id` on all 6 rw tools (`append_block`, `update_block_content`, `set_property`, `add_tag`, `create_page`, `delete_block`) |
| **H1** — Foreground `ApplyOp` retry-exhausted → silent drop, not persisted | HIGH | M (3-5 h) | medium | medium-high | ready |
| **H2** — Recurrence `++` mode 10k-iter cap can return date ≤ today silently | HIGH | trivial (~30 min) | low | medium | ✅ done session 662 (bundled with PEND-26 N3) |
| **H3** — Revoked GCal refresh token → infinite retry, no reauth event | HIGH | S (2-3 h) | low | medium | ready |
| **M1** — `record_failure` failure path silently leaks the task | MEDIUM | S (~1 h) | low | low-medium | ready |
| **M2** — `upsert_peer_ref` + `complete_sync` not in one tx (docstring violation) | MEDIUM | S (1-2 h) | low | medium | ✅ done session 663 — `_in_tx` variants; both `sync_protocol/orchestrator.rs` and `sync_daemon/snapshot_transfer.rs` bookkeeping pairs folded into single `BEGIN IMMEDIATE` |
| **M3** — Agenda projection silently skips malformed dates | MEDIUM | trivial (~15 min) | low | low | ✅ done session 663 — bundled with M5 |
| **M4** — `link_metadata` fetch parses 4xx HTML pages as metadata | MEDIUM | trivial (~30 min) | low | low-medium | ✅ done session 663 — narrow fix landed (early-return on non-2xx); `not_found` field deferred until frontend follow-up needs it |
| **M5** — `append_merge_op` doesn't dedup `parent_entries` | MEDIUM | trivial (~15 min) | low | low | ✅ done session 663 — bundled with M3 |
| **M6** — `restore_block_inner` async-only `page_id` refresh (asymmetric vs `move_block_inner`) | MEDIUM | S (1-2 h) | low | low | ✅ done session 663 — recursive-CTE `UPDATE page_id` synchronously inside tx (mirrors `move_block_inner`); deterministic test via materializer shutdown |

C1 + C2 together is "make MCP rw tools accept and enforce `space_id`" —
single PR, biggest cross-space safety win, smallest diff. Schedule first.

H2 + M3 + M4 + M5 are each ≤30 min one-line fixes plus a regression
test; bundle them as one commit.

---

## CRITICAL

### C1 — MCP `create_page` bypasses the "every page belongs to a space" invariant

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/mcp/tools_rw.rs" lines="414-432" />

**Problem:** the MCP `create_page` tool calls `create_block_inner(...)` directly
with `parent_id = None`, instead of `create_block_inner_with_space(...)` —
the wrapper that enforces the `space` property on every page block per
BUG-1 / H-3a (see <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="284-301" />).

The tool has no `space_id` parameter, so an LLM agent with MCP write
access can create pages that have no space assignment. Every space-scoped
query downstream (page lists, agenda, search, backlinks, …) either skips
these pages or surfaces them in the wrong space.

**Relationship to other PENDs:**

* **Distinct from PEND-15** (hard space separation). PEND-15 hardens
  cross-space *references* at the op boundary via `commands/spaces.rs`.
  This bug is upstream of that — pages get created with no space at
  all. Fix it independently; PEND-15's cross-space link enforcement
  doesn't help if the page itself never had a space.
* **Distinct from PEND-18** (`SpaceId` newtype). PEND-18 lifts space
  enforcement into the type system at the IPC boundary. PEND-18 will
  *eventually* eliminate this class of bug structurally, but PEND-18
  is M-L (9-15 h) and ships behind a Phase 0 spike. C1 is the
  shortest path to closing the hole today.

**Fix:**

1. Add a required `space_id: String` field to `CreatePageArgs`.
2. Call `create_block_inner_with_space(..., Some(space_id))` instead
   of `create_block_inner(...)`.
3. Update the tool schema (`mcp/registry.rs`) so the parameter is
   advertised to clients.
4. Regression test: `tools_rw_tests::create_page_without_space_rejected`
   — invoke the tool with no `space_id`, assert
   `AppError::Validation`. Add a happy-path test that the page IS
   tagged with the supplied space.

**Verification step before landing:** grep all callers of
`create_block_inner` with `block_type = "page"`; confirm MCP is the
only one that bypasses `_with_space`. (The frontend Tauri command
`create_page_in_space_cmd` already routes through the `_with_space`
variant; verified during validation.)

---

### C2 — MCP `append_block` does not validate that `parent_id` lives in the agent's space

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/mcp/tools_rw.rs" lines="332-352" />

**Problem:** `append_block` accepts a `parent_id` ULID with no
verification that the parent's owning page is in the agent's authorised
space. An agent scoped to "Personal" can append content under a "Work"
page just by knowing a Work block ID.

`create_block_inner` is space-agnostic by design — it inherits the
page's space via the parent chain. That's correct for in-process
callers that have already validated the boundary, but the MCP boundary
*is* the validation point for the agent.

**Fix:**

1. Add a required `space_id: String` field to `AppendBlockArgs`.
2. Before calling `create_block_inner`, resolve the parent's owning
   page (`SELECT page_id FROM blocks WHERE id = ?`), then look up
   that page's `space` property, then assert it equals the supplied
   `space_id`. Reject with `AppError::Validation` on mismatch.
3. Apply the same pattern to every other MCP rw tool that takes
   a block ID as input: `update_block`, `delete_block`,
   `set_property`, `delete_property`, `move_block`, etc. Audit
   `mcp/tools_rw.rs` exhaustively.
4. Extract a `validate_block_in_space(pool, block_id, space_id)`
   helper in `mcp/handler_utils.rs` so the check is one line per
   tool, not duplicated.
5. Regression tests: cross-space `append_block` rejected; cross-space
   `update_block` rejected; cross-space `set_property` rejected.

**Sequencing with C1:** ship as one PR. Both fixes touch
`mcp/tools_rw.rs` and the same arg structs; splitting them just adds
merge friction.

**Sequencing with PEND-18:** PEND-18 will replace ad-hoc `space_id:
String` parameters with `SpaceId` newtypes and `SpaceScope` enums.
Land C1+C2 first with `String` parameters; PEND-18's mass rename
will sweep them up cleanly.

---

## HIGH

### H1 — Foreground `ApplyOp` retry exhaustion → silent drop, not persisted

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/consumer.rs" lines="391-421" />

**Problem:** when a foreground `ApplyOp` task exhausts its in-memory
retry budget, the materializer logs a `tracing::warn!` and bumps
`fg_apply_dropped`, but **does not persist** the failure to a durable
queue. The recovery comment claims "sync replay is the recovery
mechanism" — but if the op originated *locally* and failed to
materialize, there is nothing for sync replay to bring back from a
peer.

This is a real divergence risk between op-log (source of truth) and
the primary materialized state. The op is durable; the apply-failure
is not.

**Relationship to PEND-03** (background silent-drop fix): PEND-03
extends `materializer_retry_queue` to cover global cache rebuilds
(per-block tasks already have persistence). H1 covers the *foreground*
queue's `ApplyOp` / `BatchApplyOps` tasks, which are a different
class — neither PEND-03 nor the existing schema covers them today.
**H1 should land after PEND-03 so the schema extension lands once.**

**Fix options:**

* **Option A — Extend `materializer_retry_queue` to cover
  ApplyOp/BatchApplyOps (recommended).** After PEND-03, the table
  already has nullable-via-sentinel `block_id` semantics and a
  `task_kind` column. Add `RetryKind::ApplyOp { seq, device_id }`
  (composite key, not block_id). Replace the warn-and-drop branch
  with `record_failure()`. The retry sweeper at next boot
  re-enqueues. Idempotent op-log apply means re-attempts are safe.

* **Option B — Document and surface, no persistence.** Document
  the divergence window in AGENTS.md "Backend Architecture", surface
  `fg_apply_dropped > 0` in the status banner, expose a Tauri
  command `force_rematerialize()` that re-reads the op log from
  scratch. Lower implementation cost, leaves the gap if the user
  ignores the banner.

**Chosen: A.** Correctness over cheapness, mirrors the PEND-03
decision rationale, reuses the same retry plumbing.

**Files touched** (assuming PEND-03 has landed):

| File | Change |
| --- | --- |
| `src-tauri/src/materializer/retry_queue.rs` | Add `ApplyOp { seq: i64, device_id: String }` variant to `RetryKind`. Update `from_task()`/`to_task()` to handle composite key. Use sentinel `block_id = '__APPLY_OP__'` and pack `seq:device_id` into `task_kind` (or add a third column — discuss). |
| `src-tauri/src/materializer/consumer.rs` | Replace warn-and-drop at lines 391-421 with `record_failure()`. Bump `fg_apply_persist_errors` if `record_failure` itself fails. |
| `src-tauri/src/materializer/coordinator.rs` | Add `fg_apply_dropped_persisted` counter alongside `fg_apply_dropped`. |
| `AGENTS.md` | Add a sentence to "Materializer" backend section: "Foreground `ApplyOp` failures persist to `materializer_retry_queue` like per-block tasks; same backoff schedule (1m → 1h cap)." |

**Test:** `materializer_tests::foreground_applyop_exhausted_persists_and_re_enqueues_on_boot`.

**Reviewer correction folded in:** the original review claimed this
was CRITICAL. Validation downgraded to HIGH on the basis that:
(1) the warn IS surfaced via the status-banner metric, (2) the op
itself is in `op_log` (durable), (3) the next mutation on the same
block re-dispatches. The fix is still warranted but it isn't a
data-loss hair-on-fire.

---

### H2 — Recurrence `++` mode silently returns date ≤ today after 10 000-iter cap

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/recurrence/parser.rs" lines="158-169" />

**Problem:** the `++` shift loop iterates `current = shift_date_once(current,
interval)` and breaks either when `current > today` or after 10 000
iterations. There is no post-loop assertion that the contract held,
and no caller validation. With a `+1d` interval and an `original` date
~30 years in the past (~10 950 iterations), the cap is hit and the
function returns a `current` value still in the past.

**Caller** (`recurrence/compute.rs::handle_recurrence_in_tx`) uses the
returned value for end-condition checks and sibling creation — so
completing a recurring task with a very old original date silently
creates a sibling with a past due date instead of advancing past today.

**Why 10 000 isn't enough:** the cap is there to prevent infinite
loops on bad data. But for legitimate `+1d`-with-old-original-date
inputs, 10 000 is roughly 27 years — which is realistic for a
"started doing this every day in college" task.

**Fix:**

```rust
"plus_plus" => {
    let mut current = original;
    let mut hit_cap = true;
    for _ in 0..10_000 {
        current = shift_date_once(current, interval)?;
        if current > today {
            hit_cap = false;
            break;
        }
    }
    if hit_cap {
        // Conservative: signal to the caller that the shift could not
        // catch up to today within the safety budget.  Caller should
        // log + either skip the recurrence or fall back to today + 1
        // day, depending on policy.
        return Err(AppError::InvalidOperation(format!(
            "recurrence ++ cap exceeded: original={original} interval={interval} today={today}"
        )));
    }
    current
}
```

(Or return `Option<NaiveDate>` and have the caller treat `None` as
"skip this recurrence sibling and warn." Pick whichever is more
ergonomic for `handle_recurrence_in_tx`.)

**Test:** `recurrence_tests::plus_plus_with_very_old_origin_returns_err`
— construct a block with `original = today - 11_000 days`, `interval =
+1d`, assert error rather than silent past date.

**Out-of-scope here:** the caller's policy decision (skip vs warn vs
fallback). This finding is "stop returning a stale date silently";
the policy can be debated separately if needed.

---

### H3 — GCal connector retries indefinitely on revoked refresh token

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/gcal_push/oauth.rs" lines="514-515" />
(plus the connector retry loop in `gcal_push/connector.rs`)

**Problem:** `refresh_token` correctly returns
`AppError::Gcal(GcalErrorKind::Unauthorized)` on `invalid_grant` /
`unauthorized_client` (refresh token revoked). The connector loop's
`fetch_with_auto_refresh` retries once on 401, but on terminal
`Unauthorized` it just logs the error and lets the cycle continue.

Per the connector's per-date diff engine, every dirty date will
re-attempt the refresh, burning Google API quota and battery. The user
is never told why their calendar stopped syncing.

**Fix:**

1. In `fetch_with_auto_refresh`, when the second attempt returns
   `Unauthorized`, treat it as terminal:
   * Set `gcal_settings.reauth_required = 'true'` (one column add or
     reuse an existing settings key — verify before migrating).
   * Emit a Tauri event `gcal:reauth_required` with the connected
     account email so the frontend can render a banner.
   * Pause the connector loop (next tick should observe the flag and
     short-circuit until cleared by a successful re-auth).
2. Clear the flag on successful re-auth (`gcal_connect` flow).
3. Frontend listener (separate small commit): show a non-dismissable
   toast/banner with a "Reconnect Google Calendar" button.

**Files touched:**

| File | Change |
| --- | --- |
| `src-tauri/src/gcal_push/oauth.rs` | (no change — already returns the typed error) |
| `src-tauri/src/gcal_push/connector.rs` | Detect `Unauthorized`-after-refresh; flip flag; emit event; short-circuit further per-date pushes this cycle. |
| `src-tauri/src/commands/gcal.rs` | On `gcal_connect` success, clear `reauth_required`. |
| `src-tauri/migrations/00NN_gcal_reauth_flag.sql` | (only if a new column is needed; otherwise reuse `gcal_settings` key) |
| frontend | Tauri event listener + banner component (defer to a follow-up commit). |

**Test:**
`gcal_connector_tests::revoked_refresh_token_emits_reauth_event_and_pauses`
— mock the OAuth client to return `invalid_grant`, run one connector
cycle, assert event emitted + flag set + subsequent cycle short-circuits.

**Threat-model note:** this is purely UX / wasted-quota; no
data-integrity concern. Severity is HIGH because the user is
silently broken until they happen to notice the calendar stopped
syncing.

---

## MEDIUM

### M1 — `record_failure` failure path silently leaks the task

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/consumer.rs" lines="524-554" />

**Problem:** when a background task exhausts its in-memory retry budget
AND `record_failure` itself fails (e.g., transient DB error during
persistence), the task is logged at `error` level but never reaches
the persistent retry queue. The `bg_dropped` metric is **not** bumped
on this branch (only on the success arm), so operators see no signal.

The reviewer's original CRITICAL rating was downgraded by validation
because: (1) the error IS logged at `error` level, (2) the next
mutation on the same block re-dispatches the task. The actual loss
is bounded but real.

**Fix:**

1. Retry `record_failure` once with a short delay (e.g., 100 ms) before
   giving up — most transient DB errors clear within milliseconds.
2. Add a dedicated counter `retry_queue_persist_errors: AtomicU64`
   on `QueueMetrics`. Bump it on every failure of `record_failure`
   (including the retry's failure). Surface it in the status banner
   with the same prominence as `bg_dropped`.
3. On the persist-failure path, ALSO bump `bg_dropped` so the
   "tasks gone" total is accurate. Today the `bg_dropped` semantics
   ("successfully persisted to retry queue") are a footgun — operators
   reading the metric think it's "dropped tasks" when it's actually
   "dropped tasks WHO MADE IT TO THE RETRY QUEUE."

**Files touched:**

| File | Change |
| --- | --- |
| `src-tauri/src/materializer/consumer.rs` | Add 100 ms retry of `record_failure`; bump `bg_dropped` + `retry_queue_persist_errors` on failure. |
| `src-tauri/src/materializer/coordinator.rs` | Add `retry_queue_persist_errors: AtomicU64` to `QueueMetrics`. |
| `src-tauri/src/sync_events.rs` | Surface the new counter in the status-banner event payload. |
| frontend | Render the new counter in `StatusBanner`. |

**Test:**
`materializer_tests::record_failure_persist_error_is_metered` — mock
the retry-queue insert to return `Err`, run one consumer cycle, assert
both `bg_dropped` and `retry_queue_persist_errors` are bumped and the
warn log fires.

**Sequencing with PEND-03:** if PEND-03 has landed, this fix sits on
top of the extended schema cleanly. If PEND-03 hasn't landed, do this
one anyway — the metric semantics fix is independent of which
`task_kind`s the queue covers.

---

### M2 — `upsert_peer_ref` + `complete_sync` not in one transaction

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/sync_protocol/orchestrator.rs" lines="527-528" />
(docstring contract at <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/peer_refs.rs" lines="141-142" />)

**Problem:** the post-session bookkeeping sequence calls
`peer_refs::upsert_peer_ref` and `complete_sync` (which writes
`last_hash` / `last_sent_hash` / `synced_at`) back-to-back on the pool,
despite the `peer_refs::update_on_sync` docstring saying it
*"should run inside a `BEGIN IMMEDIATE` transaction in production to
prevent concurrent modifications."*

A crash between the two calls leaves a peer row whose `last_hash` is
stale relative to what was actually applied. Next session re-uses the
stale hash, potentially re-applying or skipping ops.

**Mitigation in place:** the orchestrator runs serially per peer
(one session per peer at a time), so the race window is bounded to
"crash mid-bookkeeping" rather than "two concurrent writers." That's
why this is MEDIUM, not HIGH.

**Fix:**

1. Add `upsert_peer_ref_in_tx(&mut tx, ...)` and `complete_sync_in_tx(
   &mut tx, ...)` variants in `peer_refs.rs` and the existing call
   site. Existing pool-taking variants stay (used in tests / one-off
   call paths).
2. In `orchestrator.rs`:

   ```rust
   let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
   peer_refs::upsert_peer_ref_in_tx(&mut tx, &peer_id).await?;
   complete_sync_in_tx(&mut tx, &peer_id, &last_hash, &last_sent_hash).await?;
   tx.commit().await?;
   ```

3. Audit the rest of `sync_protocol/orchestrator.rs` for similar
   "two consecutive pool writes" patterns; fold them in.

**Files touched:**

| File | Change |
| --- | --- |
| `src-tauri/src/peer_refs.rs` | Add `_in_tx` variants. |
| `src-tauri/src/sync_protocol/orchestrator.rs` | Wrap the bookkeeping pair in `BEGIN IMMEDIATE`. |
| `src-tauri/src/sync_protocol/tests.rs` | Test: crash injection between upsert and complete; verify next session detects + recovers. |

**Open question:** does `sync_daemon/orchestrator.rs` (separate from
`sync_protocol/orchestrator.rs`) have the same issue? Audit before
landing — they share peer-ref bookkeeping.

---

### M3 — Agenda projection silently skips blocks with malformed dates

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/agenda.rs" lines="445-487" />

**Problem:** date parsing failures fall through with
`let Ok(...) else { continue };` and no logging. Dates are validated
at write time via `set_property_in_tx` (`is_valid_iso_date`), so the
silent skip can only fire if the DB is already corrupted or a
sync-protocol bug let through a bad value. Either way, the
observability gap makes the corruption invisible.

**Fix:** one `tracing::warn!` before each `continue` in the parsing
helpers (`agenda.rs:445-487`):

```rust
let Ok(base) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
    tracing::warn!(
        block_id = %block.id,
        source = source_name,
        date_str,
        "agenda projection: skipping block with malformed date"
    );
    continue;
};
```

Same pattern for `repeat_until` parsing at the top of the function.

**Files touched:** `commands/agenda.rs` only.

**Test:** `agenda_tests::malformed_date_is_warned_and_skipped` —
inject a malformed `due_date` directly via SQL (bypassing
`set_property`), run the projection, assert the warn fires and the
block is skipped (not crashed-on, not silently included).

---

### M4 — `link_metadata` fetch parses 4xx HTML pages as metadata

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/link_metadata/mod.rs" lines="75-131" />

**Problem:** the fetcher reads the response, checks `Content-Type`,
and proceeds to parse the body as HTML for any status code that
returned a body — including 404, 500, etc. A 404 error page's `<title>`
("Page not found") is parsed and cached as if it were the target
page's metadata.

**Fix:**

```rust
let response = client.get(url).send().await.map_err(...)?;
let status = response.status();
let final_url = response.url().to_string();

if !status.is_success() {
    return Ok(LinkMetadata {
        url: final_url,
        title: None,
        description: None,
        favicon: None,
        auth_required: matches!(status.as_u16(), 401 | 403),
        not_found: matches!(status.as_u16(), 404 | 410),
        // …
    });
}
// existing Content-Type + body-parse path
```

Distinguish 401/403 (likely needs login — show "Sign in to view"),
from 404/410 (gone — show as broken link), from 5xx (transient —
maybe retry on next render).

**Files touched:**

| File | Change |
| --- | --- |
| `src-tauri/src/link_metadata/mod.rs` | Status-check early return; new fields on `LinkMetadata` if needed. |
| `src-tauri/src/link_metadata/types.rs` | Add `auth_required` / `not_found` fields if not present (verify schema). |
| frontend | `RichContentRenderer` / link card component: render distinct chrome for 401/403 vs 404 vs error. (Defer.) |

**Test:** `link_metadata_tests::status_404_returns_minimal_metadata`,
`link_metadata_tests::status_401_marks_auth_required`. Use
`mockito` or similar to fake the HTTP response.

---

### M5 — `append_merge_op` doesn't dedup `parent_entries`

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/dag.rs" lines="426-434" />

**Problem:** the function rejects `parent_entries.len() < 2` and
sorts for canonical hashing, but never deduplicates. A buggy caller
can feed duplicate `(device_id, seq)` pairs into the merge op's
`parent_seqs`, producing an op whose hash is technically valid but
whose parent set is degenerate. Downstream merge resolution doesn't
expect duplicates.

**Fix:** dedup after sort, before hashing:

```rust
let mut sorted_parents = parent_entries;
sorted_parents.sort();
sorted_parents.dedup();

if sorted_parents.len() < 2 {
    return Err(AppError::InvalidOperation(
        "merge op requires at least 2 distinct parent entries".into(),
    ));
}
```

(Re-check the count post-dedup — if a caller fed `[(A, 1), (A, 1)]`,
that collapses to one entry and is no longer a valid merge.)

**Files touched:** `src-tauri/src/dag.rs` only.

**Test:** `dag_tests::append_merge_op_rejects_duplicate_parents`,
`dag_tests::append_merge_op_dedups_then_rejects_if_under_two`.

**PEND-09 caveat:** the merge layer is being replaced wholesale by
CRDT (PEND-09), so this fix has a finite lifetime. Land it anyway —
it's 5 lines + 2 tests, and PEND-09 is months out per the README
sequencing. A degenerate merge op landing in the op log before PEND-09
ships is permanent corruption that PEND-09's snapshot-and-replay
migration will faithfully reproduce.

---

### M6 — `restore_block_inner` async-only `page_id` refresh (asymmetric vs `move_block_inner`)

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="754-787" />

**Problem:** `restore_block_inner` clears `deleted_at` synchronously
inside the command tx, but the native `page_id` column (denormalized
ancestor cache, migration `0027`) is recomputed only via the
materializer's async `RebuildPageIds` task, dispatched from
`materializer/dispatch.rs:278-287` after commit.

There's a brief window after `commit_and_dispatch` returns but before
the materializer's `RebuildPageIds` runs in which space-scoped page
queries may see stale `page_id` rows for the restored subtree.

**This is technically consistent with the architecture** (event sourcing
plus async materialized views — the column is a maintained cache, not
the source of truth). It is *not* consistent with `move_block_inner`,
which DOES update `page_id` synchronously inside the same tx via a
recursive-CTE `UPDATE` (<ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/move_ops.rs" lines="219-234" />).

The asymmetry is the bug — readers (and future contributors) cannot
rely on either a "page_id is always synchronous in the tx" rule
*or* a "page_id is always async" rule.

**Fix options:**

* **Option A — Make `restore_block_inner` synchronous (mirror
  `move_block_inner`).** Add a recursive-CTE `UPDATE blocks SET
  page_id = ?` over the restored subtree, inside the existing
  `tx`. Pre-existing tests in `command_integration_tests/lifecycle_integration.rs`
  pin observable behaviour; if they pass after the change, we know
  the async path's eventual outcome was already what callers expected.

* **Option B — Add a regression test pinning the documented
  async behaviour.** `restore_block_returns_synchronously_with_stale_page_id`
  — assert that immediately after restore, `page_id` may be stale
  until the materializer runs. Document the staleness in
  AGENTS.md "Backend Architecture".

**Chosen: A.** Symmetry with `move_block_inner` is the simpler
contract. The recursive-CTE UPDATE is small (~10 lines), has a
template in `move_block_inner` to copy from, and removes an entire
class of "why is this `page_id` wrong right after restore?" support
questions.

**Files touched:**

| File | Change |
| --- | --- |
| `src-tauri/src/commands/blocks/crud.rs` | Add the recursive-CTE `UPDATE blocks SET page_id = ?` after the `deleted_at` clear (lines ~770). Keep the existing `recompute_subtree_inheritance` call. |
| `src-tauri/src/command_integration_tests/lifecycle_integration.rs` | Test: `restore_block_synchronously_refreshes_page_id` — soft-delete a block, move its parent under a different page, restore the original block, query `page_id` *before* the materializer can run, assert it's the new ancestor. |

**Open question:** are there other non-`move_block_inner` paths that
clear/restore `page_id` async-only? Audit `commands/blocks/crud.rs`
and `commands/blocks/move_ops.rs` exhaustively before landing —
PEND-13 (`page_id` ↔ space drift audit, already shipped) covers
the *consistency* invariant; this fix covers the *synchrony*
invariant.

---

## What was rejected

For provenance — these were in the original review and validated as
not actionable. Don't re-file them:

* **FALSE — reviewer misread the code:**
  * Import depth `>` vs `>=` — `>` is correct (`> 20` clamps 21+,
    `>=` would over-clamp 20 itself).
  * Snapshot drops `conflict_source` — the INSERT *does* include
    `conflict_source`; the omitted `page_id` is intentionally
    rebuilt by `RebuildPageIds`.
  * `list_agenda_range` cursor stability — `rows` and `ac_dates` are
    built in lockstep from the same query.
  * History query missing space filter — blocks within a page tree
    share the page's space by construction.
  * Journal page space validation race — the validation runs inside
    the same `BEGIN IMMEDIATE` tx.
  * `set_todo_state_inner` `let _ = existing` — the only place that
    converts missing-block to a typed error; removing it would
    silently allow no-op state transitions.
  * Recurrence end-condition `ref_date` validation — the code at
    `recurrence/compute.rs:147-154` *does* call `is_valid_iso_date`.
  * `next_sibling_position_excluding_sentinel` returns `None` — it
    returns `Result<i64, _>`, never `Option`.
  * Draft autosave races flush — Tauri's IPC command queue serializes.
  * `JoinSet` panics not caught — the `Err` arm in `consumer.rs` IS
    `JoinError`, which wraps panics.
  * `Arc<str>` use-after-free — impossible by Rust's type system.
  * `snapshot_covers_remote_heads` `<` vs `<=` — reviewer's own
    write-up admitted "the code is actually correct."
  * `build_page_response` panics on empty rows — `PageRequest::new`
    clamps `limit ≥ 1`; the panic branch is unreachable.

* **OUT-OF-SCOPE per threat model** (single-user, multi-device, no
  malicious peers):
  * DoS / rate-limit / message-size caps for sync peers.
  * Path-traversal guards against sync peers.
  * Adversarial-peer cert pinning beyond TOFU.
  * Frame-reordering detection (WebSocket RFC 6455 guarantees it).
  * `parse_pairing_qr` passphrase-format validation (UX, not
    robustness).

* **OUT-OF-SCOPE per architecture** (event sourcing + async
  materialized views):
  * Silent drop on backpressure for non-retryable tasks (intentional).
  * "Cache lag between command commit and materializer rebuild"
    (intentional; primary state is correct).
  * Compaction wrapper-tx TOCTOU (`L-42`/`L-43` document it as
    a recount, not an atomicity gate; inner tx is atomic).
  * Attachment file unlink after `commit_and_dispatch` (`C-3b`/`C-3c`
    document convergence-via-GC).

* **ALREADY-KNOWN** (existing tracker comments):
  * Agenda `.+`/`++` projection uses `chrono::Local::now()` (`MAINT-164`).
  * GCal disconnect keyring failure demoted to warn (`M-36`/`M-37`).
  * Tag-inheritance rebuild contract via BEGIN IMMEDIATE (`L-94`).
  * Non-Windows `\\server\share\file` opaque component (`TEST-38`).

* **NIT** (real but not robustness-relevant; bundle as a `chore:`
  commit when one of the bundles above is touched):
  * `recv timed out after 30s` error string (`RECV_TIMEOUT = 180s`).
  * `gc_unused_peer_locks` documented "call hourly", never called
    (slow bounded leak; realistic peer counts are small).
  * `MAX_IMPORT_DEPTH` comment claims "matches CTE bound" — 20 ≠ 100.
  * `commands/logging.rs` "bytes" vs `bug_report.rs` "chars"
    truncation marker.
  * FTS rank cursor `f64` (composite `(rank, block_id)` keyset uses
    block-id tiebreaker, SQL comparison is `>`).

## Sequencing notes

* **C1 + C2 ship as one PR** — same file (`mcp/tools_rw.rs`), same
  arg-struct refactor pattern. Don't split.
* **H2 + M3 + M4 + M5** are each ≤30 min one-line fixes plus a
  regression test. Bundle them as one commit (call it
  "robustness misc — log + dedup + status-check") when any one of
  them is touched.
* **H1 should land after PEND-03** (background silent-drop fix) so
  the `materializer_retry_queue` schema extension lands once. If
  PEND-03 hasn't shipped, do `H1 Option B` (document + surface)
  first, then upgrade to `H1 Option A` after PEND-03.
* **M1 is independent** of PEND-03 (it fixes the metric semantics,
  not the schema). Do whenever convenient.
* **M2 is independent** of all other work. Audit
  `sync_daemon/orchestrator.rs` for a sibling case before landing.
* **M6 is independent** but shares a recursive-CTE template with
  PEND-13 (already shipped). PEND-13's drift test will catch any
  regression.
* **None of the bundles** conflict with PEND-09 (CRDT migration)
  or PEND-10 (iroh transport). C1/C2 are upstream of PEND-15
  (hard space separation) — close them first regardless of
  PEND-15 timing. M5 is "wasted" by PEND-09 but lands anyway,
  per the rationale in M5's body.

## Recommended order

1. **C1 + C2** — MCP space enforcement (~1-3 h, biggest safety win)
2. **H2** — recurrence `++` cap (~30 min)
3. **M3 + M4 + M5** — bundled robustness misc (~1 h total)
4. **M2** — peer-ref + complete_sync atomicity (~1-2 h)
5. **H3** — GCal reauth event (~2-3 h, includes frontend follow-up)
6. **M6** — `restore_block_inner` synchronous `page_id` (~1-2 h,
   gated on no other refactors of `crud.rs` in flight)
7. **M1** — `record_failure` metric semantics (~1 h)
8. **H1** — foreground `ApplyOp` persistence (3-5 h, after PEND-03)

Steps 1-5 alone: **~5-9 h** of work, captures the C-tier and most
of the H/M tier. The remainder is incremental.
