# PEND-26 — Rust robustness review (second pass, post-validation)

## Origin

Two-pass review run 2026-05-04 (afternoon, separate from the
PEND-24 morning session). Six parallel discovery subagents over the
production Rust under `src-tauri/src/` (~165 KLoC reviewed; tests,
snapshots, fixtures excluded), then five parallel validation
subagents that re-read every cited `file:line` against the actual
code, looking for exaggerations, hallucinations, missing context,
and threat-model violations.

The review pass produced ~24 findings; validation rejected ~13
outright (misreads, speculative "what if X regresses" worries,
theoretical races outside the threat model, items already
documented in source comments) and demoted ~6 to INFO/style. Of
the eight findings that claimed an *invariant violation*, **zero
survived validation** — AGENTS.md invariants 1-9 are all correctly
enforced in the production Rust code reviewed. The four items
below are the surviving non-nit set.

> **Relationship to PEND-24** (morning session): scope and
> methodology were similar but not identical, and the two sessions
> independently surfaced different findings. The only point of
> contact is the recurrence `++` arm — see N3 below for how it
> relates to PEND-24 H2; they are *distinct bugs in the same code
> path* and should ship together.
>
> The validation pass for this session caught several findings that
> were factually wrong (e.g. "materializer uses `BEGIN DEFERRED`,
> violating invariant #2" — invariant #2 is scoped to command
> handlers; the materializer is downstream and idempotent; SQLite
> WAL+DEFERRED gives sufficient snapshot isolation; the snapshot
> creation path's read phase is *intentionally* DEFERRED with an
> explicit justification comment at `snapshot/create.rs:211-212`).
> Those are not in this file; the per-bucket review/validation
> reports are kept under `/tmp/agaric-review/` for audit if needed.

## TL;DR

| ID | Severity | Cost | Risk | Impact | Status |
| --- | --- | --- | --- | --- | --- |
| **N1** — `create_page_in_space_inner` does not uppercase-normalize `space_id` (invariant #8 gap) | MEDIUM | trivial (~10 min) | low | medium | ready |
| **N2** — Recursive-CTE depth-100 cap silently truncates cascade soft-delete / restore / purge | MEDIUM | S (1-2 h) | low | medium | ready |
| **N3** — Recurrence `++` arm `?` propagation silently drops the shifted date on overflow | MEDIUM | trivial (~15 min) | low | low-medium | ready (bundle with PEND-24 H2) |
| **N4** — `journal_for_date` MCP tool description under-advertises its write side-effect | LOW-MEDIUM | trivial (~5 min) | low | low | ready |

N1 + N3 + N4 are each ≤15 min one-line/wording fixes. Bundle them
as one commit "robustness misc — invariant-8 gap + recurrence
overflow + tool-schema clarity". N2 is the only one that needs a
shared helper + a regression test, ~1-2 h.

None of these require schema migrations, new op types, new stores,
or any architectural change.

---

## MEDIUM

### N1 — `create_page_in_space_inner` does not uppercase-normalize `space_id` (invariant #8 gap)

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/spaces.rs" lines="127-160" />

**Problem:** the `space_id` argument arrives at line 133 as a plain
`String`, and the validation lookup at lines 147-159 queries SQLite
directly against it. Every sibling command that accepts a ULID
parameter normalizes it to uppercase before use:

* `move_block_inner` — <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/move_ops.rs" lines="35-36" />
* `edit_block_inner` — <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="416-416" />
* `delete_block_inner` — <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="539-539" />
* tag commands, page commands, etc.

Per AGENTS.md invariant #8 ("ULID uppercase normalization — Crockford
base32 for blake3 hash determinism"), every entry point that
receives a ULID must normalize before SQL or hash use. This is the
only command in `commands/` that doesn't.

**Failure scenario:** a caller (today: front-end TypeScript via the
typed wrapper, which already uppercases at the React store level;
tomorrow: an MCP agent that constructs the `space_id` from raw
input, or an importer that re-uses a lowercased ULID literal from
markdown frontmatter) passes a lowercase ULID. The lookup at
lines 147-159 silently misses the live space (the row's `id` is
stored uppercase) and the caller sees a confusing "does not refer
to a live space block" error instead of a clear "invalid ULID
format" error. **No data corruption** — the worst case is a
confusing error message at the IPC boundary — but the contract
asymmetry across sibling commands is a real maintenance hazard,
and invariant #8 is documented as "every entry point", with no
exception listed.

**Fix:**

```rust
pub(crate) async fn create_page_in_space_inner(
    pools: &DbPools,
    materializer: &Materializer,
    space_id: String,
    title: String,
    // …
) -> Result<String, AppError> {
    let space_id = space_id.to_ascii_uppercase();   // ← add this line
    // … rest unchanged
```

That's it. One line, mirrors every other command in
`commands/blocks/*` and `commands/pages.rs`.

**Test:** add to `commands/tests/page_cmd_tests.rs` (or wherever
the existing `create_page_in_space` tests live):

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_page_in_space_accepts_lowercase_space_id() {
    let (pools, mat) = test_pools_with_personal_space().await;
    let space_id_lower = personal_space_id().to_ascii_lowercase();
    let result = create_page_in_space_inner(
        &pools, &mat, space_id_lower, "Test page".into(), /* … */
    ).await;
    assert!(result.is_ok(), "lowercase space_id should be accepted: {result:?}");
}
```

**Out-of-scope here:** there is **no companion bug** in
`create_space_inner` — it doesn't take an existing `space_id`
argument, it generates a new one, so the LOW finding "inconsistent
ULID normalization across creator commands" from the review pass
collapses entirely into N1. Don't touch `create_space_inner`.

---

### N2 — Recursive-CTE depth-100 cap silently truncates cascade soft-delete / restore / purge

**Files:**

* Macro definitions: <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/block_descendants.rs" lines="67-175" />
* Representative cascade caller: <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="635-680" />
  (`delete_block_inner` uses `descendants_cte_active!()`)
* Other call sites to audit: `soft_delete/restore.rs`, `soft_delete/trash.rs`,
  `commands/blocks/crud.rs` purge path, anywhere `descendants_cte_purge!()`
  or `descendants_cte_active!()` appears.

**Problem:** every recursive-CTE macro caps recursion at `d.depth <
100` per AGENTS.md invariant #9. This is correct **as a guard
against runaway recursion on corrupted data**. But **callers do not
detect when the cap is actually hit on legitimate data**, and there
is no warning surfaced.

Concretely: a user with a tree more than 100 levels deep
(synthetic stress, an importer that flattens an org-mode outline,
a future repeated-indent regression) deletes the root block. The
descendants CTE walks the first 100 levels, soft-deletes those,
and silently stops. Levels 101+ stay live but their ancestors are
tombstoned, so:

* They do not appear in any descendant query (their parent is
  deleted, the CTE filters `b.is_conflict = 0` but **not**
  `deleted_at IS NULL` in the recursive member of every macro).
* They cannot be restored via `restore_block_inner` because the
  cascade restore walk also tops out at 100.
* They become orphans of `page_id` rebuild — `cache/page_id.rs`
  walks the parent chain looking for a page, and that chain is
  itself bounded at 100.
* No error, no log, no breadcrumb in the activity feed.

This is the only AGENTS.md invariant whose **enforcement is
correct but whose silent failure mode is user-visible as data
loss**.

**Why MEDIUM and not HIGH:** in practice, no organic Agaric tree
is >100 deep. The threshold is far above any reasonable use. The
finding is MEDIUM because (a) the failure is silent and (b) the
fix is a single helper plus one warning per cascade caller, not a
schema change.

**Fix:**

Add a small helper in `block_descendants.rs`:

```rust
/// Re-check after a descendants/ancestors walk whether the depth
/// cap was actually hit. Callers that cascade soft-delete /
/// restore / purge should call this and either surface an error
/// (data-mutating commands) or log a warn (best-effort caches).
pub(crate) async fn cascade_depth_saturated<'e, E>(
    executor: E,
    root_id: &str,
) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let max_depth: Option<i64> = sqlx::query_scalar!(
        descendants_cte_active!() // 'WITH RECURSIVE descendants(id, depth) AS (…) '
        + " SELECT MAX(depth) FROM descendants",
        root_id
    )
    .fetch_one(executor)
    .await?;
    Ok(max_depth.unwrap_or(0) >= 99)  // 99 = "the cap was reached"
}
```

Then in `delete_block_inner`, `restore_block_inner`,
`purge_block_inner`, etc. — after the cascade cleanup — call:

```rust
if cascade_depth_saturated(&mut *tx, &block_id).await? {
    tracing::warn!(
        block_id = %block_id,
        op = "delete_block",
        "cascade-depth cap reached: tree was >= 100 levels deep; \
         descendants below depth 100 were not affected"
    );
    // Optional, more aggressive: return Err(AppError::Validation(
    //     "tree too deep for cascade — consider purging in chunks".into()
    // ));
}
```

Default to **warn-only** for `delete_block_inner` (don't break
delete on pathological trees), but err for `purge_block_inner`
(hard delete should be all-or-nothing).

**Test:** add a stress test (gated `#[ignore]` if too slow on CI)
that builds a 105-level chain and asserts the warn fires, plus
that a 99-level chain does not fire it:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "stress: builds a 105-deep tree"]
async fn cascade_depth_warn_fires_at_100() { … }

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cascade_depth_warn_does_not_fire_at_99() { … }
```

**Out-of-scope:** invariant #9 stays at depth 100. Don't bump the
cap; widening it just moves the cliff. The fix is detection +
surfacing, not a different bound.

---

### N3 — Recurrence `++` arm `?` propagation silently drops the shifted date on overflow

**Files:**

* The loop: <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/recurrence/parser.rs" lines="153-176" />
* The consumer: <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/recurrence/compute.rs" lines="270-300" />

**Problem:** in the `++` arm of `shift_date`, the loop body calls
`shift_date_once(current, interval)?`. If `shift_date_once` returns
`None` (date arithmetic overflow — e.g. an interval that pushes
`NaiveDate` past `chrono`'s representable range, or a leap-year
edge that the underlying `Days::checked_add` rejects), the `?`
propagates `None` out of the entire `shift_date` function.

The consumer in `compute.rs:270-295` then sees `shifted_due ==
None` and **proceeds to create the next recurrence sibling
without setting any due date at all**, instead of either
surfacing the overflow or skipping the sibling. The consumer
already has a `tracing::warn!` arm for *malformed* dates
(line 277), but `None` from the parser doesn't reach that arm —
it short-circuits earlier.

**Failure scenario:** the user has a recurring task with `++` on
an interval that overflows for a specific `original` date (e.g.
`++100y` from 1925 — overflows `NaiveDate::MAX` after a couple of
applications). Marking that task done creates a new recurrence
sibling with **no due date**, which then silently disappears from
the agenda and any date-filtered list. No log, no warning.

**Why this is distinct from PEND-24 H2:** PEND-24 H2 ("`++` mode
silently returns date ≤ today after 10 000-iter cap") is about
the loop *successfully* producing a value but that value is in
the past because the interval is too small to catch up to today
in 10 000 iterations. This finding is about
`shift_date_once` returning `None` on a *single* iteration,
which never happens in PEND-24 H2's scenario. Both bugs need to
be fixed; both fixes are in the same loop body. **Bundle them.**

**Fix (combined with PEND-24 H2):**

```rust
"plus_plus" => {
    let mut current = original;
    let mut hit_cap = true;
    for _ in 0..10_000 {
        let Some(next) = shift_date_once(current, interval) else {
            // N3: explicit overflow signal instead of silent ?
            return Err(AppError::Validation(format!(
                "recurrence ++ arithmetic overflow: \
                 original={original} interval={interval}"
            )));
        };
        current = next;
        if current > today {
            hit_cap = false;
            break;
        }
    }
    if hit_cap {
        // PEND-24 H2: cap-exceeded signal
        return Err(AppError::Validation(format!(
            "recurrence ++ cap exceeded: \
             original={original} interval={interval} today={today}"
        )));
    }
    current
}
```

The signature of `shift_date` itself needs to change from
`Option<String>` to `Result<String, AppError>` (or similar).
`compute.rs:handle_recurrence_in_tx` is the only caller; switch
its `if let Some(shifted) = shifted_due` arm to a `match` that
warns + skips on `Err`, mirroring the existing
`is_valid_iso_date` warn arm at line 277.

**Test:** in the existing `recurrence::tests`:

```rust
#[test]
fn plus_plus_overflow_returns_err() {
    // ++100y from a date close to NaiveDate::MAX overflows
    let result = parser::shift_date(
        date_at_year(NaiveDate::MAX.year() - 50),
        "++100y",
        chrono::Utc::now().date_naive(),
    );
    assert!(matches!(result, Err(AppError::Validation(_))));
}
```

**Out-of-scope here:** the *policy* decision in `compute.rs` —
whether to skip the recurrence sibling, fall back to today + 1
day, or surface the error all the way to the IPC layer — can be
debated separately. The minimum bar is "stop returning `None`
for the overflow case as if it were 'no shift requested'".

---

## LOW

### N4 — `journal_for_date` MCP tool description under-advertises its write side-effect

**Files:**

* JSON-RPC schema (the wire-visible description): <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/mcp/tools_ro.rs" lines="569-575" />
* Carve-out rationale (source-only): <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/mcp/tools_ro.rs" lines="226-275" />

**Problem:** `journal_for_date` lives in `mcp/tools_ro.rs` (the
"read-only" tool group by convention) and its JSON-RPC schema
description at line 572-573 says "Return the journal page for a
specific date in the given space, creating it if missing.
Idempotent per-space."

The phrase "creating it if missing" *is* in the schema, so this
is not a hidden side-effect — but in a long tool list, an LLM
agent skimming descriptions to pick read-only operations will
likely classify this as read-only based on the file name and the
"Return …" lead, missing the buried "creating it if missing"
clause. The deeper rationale (M-82 / M-84 carve-out: the tool
emits a `CreateBlock` op with origin `agent:<name>` on first
read-of-the-day) is *only* in the source code, not in the schema
delivered over the wire.

**Why this matters:** MCP agents that rely on tool grouping for
their own transactional or rollback logic (e.g. "I'll roll back
all writes if the user cancels") cannot rollback the
`journal_for_date` page creation, because they didn't classify it
as a write. The op is fully reversible (it's a normal
`CreateBlock` op, shows up in the activity feed, can be undone)
so this is a contract clarity issue, not a security defect.

**Fix:** change the schema description to lead with the side
effect:

```rust
"Return the journal page for `space_id` on `date`. **Creates the \
 page (one `CreateBlock` op with origin `agent:<name>`) if it \
 does not yet exist.** Idempotent per `(space_id, date)` after \
 the first call."
```

Optional follow-up: move the tool out of `tools_ro.rs` into a
clearly-named "read-mostly" group, or split the read path
(`journal_for_date_existing`, returns 404 if missing) from the
create path (`journal_for_date_or_create`). Not required —
description tightening alone is enough for the contract clarity
goal.

**Test:** add a snapshot test that pins the description text:

```rust
#[test]
fn journal_for_date_description_mentions_create_side_effect() {
    let schema = mcp::tools_ro::tool_schema("journal_for_date");
    let desc = schema["description"].as_str().unwrap();
    assert!(desc.contains("Create"), "description should advertise create side-effect");
    assert!(desc.contains("CreateBlock"), "description should name the op type");
}
```

**Out-of-scope:** the M-82 / M-84 carve-out itself. Whether
agents *should* be able to create pages via a read-classified
tool is a product decision; this finding is purely about the
schema being honest about what it does today.

---

## What was rejected by validation

For audit. The full per-bucket validation reports are at
`/tmp/agaric-review/0{1..6}-*-validated.md`.

* **"Materializer `apply_op` / `BatchApplyOps` use `BEGIN
  DEFERRED`, violating invariant #2"** (4 review findings, one
  root cause). Invariant #2 is scoped to *command handlers*,
  which write to both op-log and primary state. The materializer
  is a downstream consumer applying idempotent ops (`INSERT OR
  IGNORE`, `UPDATE … WHERE`); SQLite WAL + DEFERRED gives
  snapshot isolation that is sufficient for idempotent writes.
* **"Snapshot creation race in `snapshot/create.rs:213`"**.
  Reviewer missed the inline justification at lines 211-212 ("A
  DEFERRED tx is fine here — it only needs read isolation.
  SQLite promotes to a read-lock on the first SELECT and holds it
  until commit."). The write phase at line 234+ is correctly
  IMMEDIATE.
* **"`extract_block_id_from_payload` silently returns `None`"**.
  The function logs `tracing::warn!(error = %e, payload = %…,
  "failed to parse op_log payload JSON; block_id index will miss
  this row")`. The reviewer even quoted the warn line in the
  evidence section but still labeled the behavior "silent".
* **"`tag_query::resolve_expr` panic on empty AND"**. Guard at
  `resolve.rs:175` returns early on empty `exprs`; the
  `try_join_all` at line 188 produces exactly `exprs.len()`
  results, so `.next().unwrap()` is unreachable on empty.
* **"`tag_inh_ancestors_walk!` violates invariant #9"**. Macro
  docstring (`tag_inheritance_macros.rs:154-159`) explicitly
  documents the carve-out; every call site re-applies
  `b.is_conflict = 0 AND b.deleted_at IS NULL` at projection.
* **"Lease renewal failure leaves stale held-lease assumption"**.
  No in-memory lease state exists; every cycle reads the lease
  fresh from the database via `BEGIN IMMEDIATE`.
* **"`move_block_inner` writes `page_id` column without a
  `SetProperty` op"**. Intentional — `dispatch.rs:308-311`
  enqueues `RebuildPageIds`, which recomputes from the parent
  chain on remote apply. Tests in `page_cmd_tests.rs` confirm
  cross-device consistency.
* **"`restore_all_deleted_inner` `deleted_at` collision
  window"**. Documented at `crud.rs:972-987` (I-CommandsCRUD-9),
  gated by AGENTS.md Architectural Stability rules. Negligible
  probability under single-user load.
* **Speculative "what if X regresses" findings** — `parse_window_days`
  defensive clamping, MCP inner-handler limit clamping,
  `now_rfc3339()` system-clock dependency, `peer_refs.rs`
  arbitrary-string `peer_id`, MCP error 200-char clipping,
  `FixedClock`-vs-`SystemClock` timezone difference. Each is
  documented and intentional; rejected.
* **Theoretical races** — `sync_cert.rs` torn-write recovery
  (single-call-at-startup), `sync_scheduler.rs` mutex poison
  (recovery is correct), `TempAttachmentWriter` spawn-cleanup
  (Drop fallback present), `finalised` flag on early commit
  error path (Drop handles it).
* **Style nits** — FTS epsilon `1e-9` (pinned by an explicit
  test), deeplink `InvalidUlid` wording (UX clarity, not
  robustness), spaces-bootstrap `BlockId::from_trusted(...).expect(...)`
  (load-bearing safety net with companion test).

---

## Sequencing notes

* **N1 + N3 + N4 ship as one PR** — three trivial fixes, all
  invariant / contract clarity, no shared infrastructure. Call
  it "robustness misc — invariant-8 gap + recurrence overflow +
  tool-schema clarity".
* **N3 must be coordinated with PEND-24 H2** — same loop body in
  `recurrence/parser.rs`. Land them in the same commit so the
  signature change of `shift_date` (`Option<…>` → `Result<…>`) is
  one transition, not two. If PEND-24 H2 ships first, N3 becomes
  a much smaller addition (just the overflow `return Err` arm).
  If N3 ships first, PEND-24 H2 becomes a smaller addition (just
  the cap-exceeded `return Err` arm).
* **N2 is independent** of all other PEND-* work. It introduces
  one tiny helper in `block_descendants.rs` plus warns at four to
  six call sites. The PEND-13 drift test (already shipped)
  exercises the cascade paths and will catch any regression.
* **None of the four findings** conflicts with PEND-09 (CRDT
  migration), PEND-10 (iroh transport), PEND-12 (build.rs
  codegen for space-filter), or PEND-15 (hard space separation).
  N1's invariant-#8 normalization is upstream of PEND-15
  (close it independently of PEND-15 timing).

## Recommended order

1. **N1 + N3 + N4 bundle** — ~30 min total + tests, biggest
   safety/clarity win for smallest diff. Coordinate N3 with
   PEND-24 H2 if that ships in the same window.
2. **N2** — ~1-2 h, helper + warn + one stress test (gated
   `#[ignore]` for the >100-deep tree).

Total: **~2-3 h of work** to close all four. After this, the
production Rust under `src-tauri/src/` has zero confirmed
robustness findings from this review pass.
