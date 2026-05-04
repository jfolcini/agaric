# PEND-28 — Rust maintainability review findings (post-validation)

## Origin

Two-pass maintainability review run 2026-05-04 (separate from the
PEND-24 morning robustness session and the PEND-26 afternoon
robustness second pass — same date, distinct lens). Six parallel
discovery subagents covered the production Rust under
`src-tauri/src/` (~98 KLOC of production code across 210 files,
tests / snapshots / fixtures excluded), partitioned by module
group:

* `commands/` (~17.5 KLOC)
* `gcal_push/` (~12.3 KLOC)
* `mcp/` (~6.95 KLOC)
* sync subsystem (~9.3 KLOC)
* core engine — `op.rs`, `op_log.rs`, `db.rs`, `lib.rs`, `error.rs`,
  `hash.rs`, `lifecycle.rs`, `materializer/`, `cache/` (~17.4 KLOC)
* auxiliary subsystems + utility files (~14 KLOC)

Validation pass: each Round-1 finding was re-checked at its cited
file:line range against the actual code. The lens was *maintainability*
(duplication, function length, naming, missing/misleading docs,
inconsistent error handling, leaky abstractions, dead code, API
ergonomics) — not robustness, not performance, not security.

The review pass produced ~36 findings across the six scopes.
Validation kept **2 H** and **4 M** as actionable non-nit items.
Everything else was either:

* **REFUTED** — the cited construct didn't exist or behaved
  differently (notably: the gcal "duplicated classifier" claim —
  `classify_date_err` already delegates to the shared `kind_display`;
  the `SyncMessage` "needs exhaustiveness" claim — the
  `handle_message` match in `sync_protocol/orchestrator.rs:297-604`
  is exhaustive and the compiler enforces it; the `mcp/registry.rs:55`
  OFFSET — no OFFSET in that file at all);
* **DOWNGRADED to LOW** — doc/clarity nits with no concrete
  maintainability cost (e.g. the dormant-daemon state-machine ASCII
  diagram, the `SnapshotTempFile` rename, the `LifecycleHooks`
  ordering rationale comment);
* **OUT-OF-SCOPE / already tracked** — the
  `gcal_push/mod.rs:30-45` blanket `#[allow(dead_code)]` is already
  flagged in-source as L-127; the `sync_scheduler::gc_unused_peer_locks`
  "documented but uncalled" is the same item PEND-24's intro already
  flagged as a LOW chore;
* **REFUTED on second look against PEND-26** — the materializer
  `pool.begin()` (DEFERRED) divergence from `BEGIN IMMEDIATE` was
  already reviewed in PEND-26 and rejected as a non-issue
  (invariant #2 is scoped to command handlers; the materializer is
  downstream and idempotent; SQLite WAL+DEFERRED gives sufficient
  snapshot isolation). Repeating it here would add noise.

> **Relationship to PEND-24 / PEND-26.** This is a *third* Rust review
> on the same day, with a different lens (maintainability, not
> robustness). The findings below do not overlap with PEND-24's
> CRITICAL/HIGH/MEDIUM list or PEND-26's N1-N4. PEND-24 closes
> correctness gaps; PEND-26 closes invariant-#8 / depth-cap gaps;
> this file closes a small set of "size and shape" maintenance
> hotspots that future feature work will benefit from straightening.

> **Process caveat — honesty about Round 2.** The Round-2 validation
> background subagents were lost when the session paused (twice, on
> two re-dispatches). The validation reported here was performed
> in-line by `read` + `grep` against the cited file:line ranges in
> the same session — *not* as an independent six-subagent
> corroboration. Verdicts are based on direct reads I can cite, but
> the methodology is weaker than PEND-24's. Findings should be
> spot-checked when picked up; in particular H1's claim of "34
> duplicated SELECT sites across 15 files" was verified by grep but
> not visually confirmed at every site.

## TL;DR

| ID | Severity | Cost | Risk | Impact | Status |
| --- | --- | --- | --- | --- | --- |
| **H1** — Canonical `BlockRow` SELECT clause repeated 34× across 15 files | HIGH | M (4-7 h) | low | medium-high | ready |
| **H2** — `apply_op_tx` is a 387-line per-op dispatcher with deeply nested arms | HIGH | M (4-8 h) | low | medium | ready |
| **M1** — `block_drafts` orphan sweep is documented as needing periodic invocation but no caller exists | MEDIUM | trivial-S (~1 h) | low | low-medium | ready |
| **M2** — `set_property_in_tx` is ~258 lines mixing validation, op-log append, and materialization | MEDIUM | S (2-4 h) | low | medium | ready |
| **M3** — `try_sync_with_peer` has 9 args with parallel call sites cloning identical state | MEDIUM | S (1-2 h) | low | low-medium | ready |
| **M4** — `enqueue_background_tasks` is ~174 lines of imperative per-op cache-invalidation routing | MEDIUM | S (2-3 h) | low | low-medium | ready |

H1 + H2 are the headline items. H1 is mechanical (introduce a
SQL-string macro, replace 34 sites, pin with a column-list parity
test). H2 is "extract one private fn per op variant" — pure
structural refactor, no behavior change.

M1 is a one-call-site wiring fix and closes M-93. M2 + M4 are
"split a long function". M3 is "wrap shared inputs in a
`SyncSessionContext` struct".

None of these require schema migrations, new op types, new stores,
new sync messages, or any architectural change.

---

## HIGH

### H1 — Canonical `BlockRow` SELECT clause repeated across many query sites

**Production sites (`SELECT id, block_type, content,` … the full
canonical column list):**

* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="430-430" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="1477-1477" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/queries.rs" lines="134-134" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/queries.rs" lines="168-168" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/pages.rs" lines="251-251" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/pages.rs" lines="723-723" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/properties.rs" lines="245-245" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/hierarchy.rs" lines="54-54" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/hierarchy.rs" lines="114-114" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/hierarchy.rs" lines="155-155" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/pagination/trash.rs" lines="50-50" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="320-320" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="333-333" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/recurrence/compute.rs" lines="100-100" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/recurrence/compute.rs" lines="506-506" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/recurrence/compute.rs" lines="874-874" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/tag_query/query.rs" lines="77-77" />
* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/snapshot/create.rs" lines="78-78" />

(`grep` found 34 total matches across 15 files; the rest are inside
test files and are intentional fixture / wire-format pins, not
duplications to refactor.)

**Problem:** the canonical column list — `id, block_type, content,
parent_id, position, deleted_at, is_conflict as "is_conflict: bool",
conflict_type, todo_state, priority, due_date, scheduled_date,
page_id` — is copy-pasted across every list-style query path.

The cost shows up the next time a column is added to the `blocks`
table. AGENTS.md's "Architectural Stability" section explicitly
allows column promotion as a deliberate, narrow exception (today
five hot-path columns: `todo_state`, `priority`, `due_date`,
`scheduled_date`, `page_id`). Each promotion currently means
hand-editing 13+ production sites in lockstep with the migration,
the dual-write in command handlers, and the materializer rebuild.
A missed site fails to deserialize at runtime (`query_as!` catches
*missing* columns by `BlockRow` field, but not silent ordering
drift across hand-typed lists).

**Suggested fix shape:**

1. Introduce a SQL-string macro analogous to the existing
   `descendants_cte_purge!()` / `tag_inh_subtree_active!()` /
   `ancestors_cte_standard!()` pattern. Place it where the existing
   block-tree macros live (probably `block_descendants.rs` or a
   dedicated `commands/blocks/sql_macros.rs`). Suggested name:
   `block_row_select_columns!()`.

2. Replace each of the 18 production site occurrences with
   `concat!(block_row_select_columns!(), " FROM blocks WHERE …")`,
   keeping the rest of the `query_as!` invocation identical.

3. Add a unit test (in `pagination/` or `block_descendants.rs`'s
   own test module) that diffs the macro's output against the
   `BlockRow` struct's `#[derive(FromRow)]` field list. The test
   parses the macro output as comma-separated SQL fragments and
   asserts each `BlockRow` field has a matching SELECT entry — so
   adding a field to `BlockRow` fails the test until the macro is
   updated, and removing a field from the macro fails too.

4. **Do not** rewrite the pagination cursor SELECT (which embeds
   `position`-based cursor columns at the end) — those are a
   different shape; leave them as-is unless cursor and row shapes
   are unified separately.

**Verification before landing:**

* Confirm the 18 production sites listed above are exhaustive by
  re-running `grep -nE 'SELECT id, block_type, content,'` on
  `src-tauri/src/`.
* Confirm none of the test-file matches (e.g. in
  `commands/tests/property_cmd_tests.rs`, `recurrence/tests.rs`,
  `pagination/tests.rs`, `reverse/tests.rs`,
  `commands/tests/page_cmd_tests.rs`) are load-bearing prod
  fixtures — they are wire-format pins and stay literal on purpose.

**Cost estimate:** 4-7 h. The longest part is auditing each site's
trailing `WHERE` / `ORDER BY` / `LIMIT` clauses to confirm the
macro substitution doesn't accidentally introduce a column the
caller's struct doesn't expect.

**Risk:** low. Mechanical substitution; compile-time SQL via
`query_as!` keeps the substitution honest at every site; the
parity test pins the relationship going forward.

---

### H2 — `apply_op_tx` is a 387-line per-op dispatcher with deeply nested arms

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/handlers.rs" lines="195-582" />

**Problem:** `apply_op_tx` is the single function that turns every
incoming `OpRecord` into a primary-state effect. The match has
12 arms; the `PurgeBlock` arm alone is over 100 lines with 13
separate `DELETE` / `UPDATE` statements. There are no per-variant
helpers; every arm inlines its full `sqlx::query` + bind chain.

This is the choke-point for:

* every new op type (a new variant means surgery inside one
  monolithic function);
* every new column on `blocks` or `block_properties` (every arm
  touching that column has to be updated by hand);
* every test wanting to exercise just one op type's transactional
  effect (today: there is no way; you have to drive the whole
  dispatcher).

The function is also the largest single barrier to anyone reading
the materializer for the first time — the dispatch + body
inversion (match arms longer than the function header that
contains them) is hostile to "what does CreateBlock actually do?"
exploration.

**Suggested fix shape:**

1. Extract one private async fn per op variant:

   ```text
   async fn apply_create_block_tx(conn: &mut SqliteConnection,
                                  payload: CreateBlockPayload) -> Result<(), AppError>
   async fn apply_edit_block_tx(...)
   async fn apply_delete_block_tx(...)
   async fn apply_restore_block_tx(...)
   async fn apply_purge_block_tx(...)        // takes ownership of the 100-line body
   async fn apply_move_block_tx(...)
   async fn apply_add_tag_tx(...)
   async fn apply_remove_tag_tx(...)
   async fn apply_set_property_tx(...)
   async fn apply_delete_property_tx(...)
   async fn apply_add_attachment_tx(...)
   async fn apply_delete_attachment_tx(...)
   ```

   All `pub(super)` so the dispatch + the per-variant tests live
   in the same `materializer::handlers` module. None of these need
   to escape the materializer.

2. `apply_op_tx` shrinks to:

   ```rust
   match op_type {
       OpType::CreateBlock => apply_create_block_tx(conn, p).await,
       OpType::EditBlock   => apply_edit_block_tx(conn, p).await,
       …
   }
   ```

   ~30-40 lines total.

3. **Do not** change behavior. The extraction is mechanical: cut
   each arm body, parameterize on the deserialized payload struct
   (the arms already do `let p: CreateBlockPayload = serde_json::from_str(...)`
   first), drop the arm body's `let p = …` line into the new
   function. Tag-inheritance / FTS / page-id side-effects already
   live in their own helpers — leave them alone.

4. Land it as a single commit titled
   `refactor(materializer): split apply_op_tx into per-op-type helpers`
   so the diff is a pure cut-and-paste review.

**Cost estimate:** 4-8 h. The variance is in how much per-variant
test coverage you choose to add as part of the refactor — a pure
extraction with no new tests is at the low end; adding one
fixture-based test per `apply_*_tx` (so each variant becomes
independently testable) is at the high end.

**Risk:** low. No behavioral change; existing materializer tests
continue to drive the dispatcher and will catch any extraction
slip.

**Verification before landing:**

* `cargo nextest run -p agaric` — the 3000+ existing materializer
  / integration tests are the regression net.
* Diff the LOC delta: should be a wash (slightly higher because
  of the per-fn signatures + their `}` lines; offset by removed
  match-arm boilerplate).
* Spot-check that `PurgeBlock` still removes everything in the
  same order — that path is the highest-risk one.

**Note on H1+H2 sequencing:** H1 (BlockRow macro) does not touch
`apply_op_tx`. The two PRs are independent and can ship in either
order or in parallel.

---

## MEDIUM

### M1 — `block_drafts` orphan sweep is documented as needing periodic invocation but no caller exists

**Files:**

* <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/draft.rs" lines="124-143" /> — function
  `sweep_orphan_drafts(pool)` plus the `M-93` rationale: `block_id`
  has no FK to `blocks.id`, so drafts for hard-deleted blocks
  survive purges and produce noise on next boot.
* The doc explicitly says "periodic invocation … is left as a
  follow-up — the function being available is what enables the
  cleanup."

**Problem:** `grep` for `sweep_orphan_drafts` finds only the
definition itself plus 8 matches in `draft/tests.rs`. **Zero
production callers.** The "load-bearing fix" (the function's own
words) is present but dormant.

Failure scenario:

1. User hard-deletes a block (or a block is purged via op-log
   compaction) that had an in-progress draft.
2. The draft row in `block_drafts` survives (no FK to cascade).
3. On next boot, draft restore tries to load the orphan and surfaces
   "phantom drafts" in the UI, or throws a "block not found" warning.

The longer the user runs without a sweep, the more residue
accumulates. There is no upper bound today.

**Suggested fix shape:**

* Wire a periodic call into the materializer's idle hook or the
  lifecycle tick. The cadence in the function's own doc
  recommendation is "every N minutes" with no specific N — once
  per hour during foreground use, with a one-shot at boot, is
  more than sufficient (drafts are user-typed, so the rate of
  orphan creation is bounded by user clicks).
* Emit a metric / `tracing::debug!` of `rows_affected` so a
  regression in the sweep itself is visible.
* Update the doc comment at lines 127-131 to reference the new
  call site, then close M-93 in source.

**Cost estimate:** trivial-S (~1 h). The function exists, tests
pass, the wiring is one call site.

**Risk:** low. The function is `DELETE FROM block_drafts WHERE
block_id NOT IN (SELECT id FROM blocks WHERE deleted_at IS NULL)`
— it cannot delete rows for live blocks; the failure mode is
"didn't sweep aggressively enough", not "swept the wrong rows".

---

### M2 — `set_property_in_tx` is ~258 lines mixing validation, op-log append, and materialization

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="1339-1597" />

**Problem:** the function spans roughly 1339 → 1597 (a sibling
helper is documented at 1597). It bundles:

* property-key alphabet validation;
* property-value type-vs-payload validation (which value field
  must be set for a given declared type — `text` / `number` /
  `date` / `ref` / `boolean`);
* reserved-key dual-write setup (the `todo_state` / `priority` /
  `due_date` / `scheduled_date` columns on `blocks`);
* op-log append;
* materializer dispatch.

The validation block alone is ~130 lines with nested matches. The
function is called from several `_inner` paths (the recurrence
engine in `recurrence/compute.rs` calls it directly; so does the
property-set Tauri command), so changing it requires correlating
the change against multiple call-site contexts at once.

**Suggested fix shape:**

* Extract a `validate_property_value(declaration, payload) ->
  Result<ValidatedPropertyValue, AppError>` helper that owns the
  ~130-line validation block. Return a small enum that carries the
  resolved value type and the value. The remaining body of
  `set_property_in_tx` becomes ~120 lines: validation call,
  op-log append, dual-write to `blocks` columns when the key is
  reserved, materializer dispatch.
* Keep the dual-write logic inside `set_property_in_tx` — it
  belongs with the op-log append (atomicity per AGENTS.md
  "hot-path properties" rule) and would be awkward to extract
  separately.
* Add a unit test pinning the validation enum (one test per
  declared type × value-field-shape combination — small matrix,
  ~10 cases).

**Cost estimate:** S (2-4 h). The longer end is the test matrix.

**Risk:** low. Validation is the leftmost step; the extraction is
a pure restructure.

---

### M3 — `try_sync_with_peer` has 9 args; parallel call sites clone identical state

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/sync_daemon/orchestrator.rs" lines="544-554" />

**Problem:** the signature carries 9 parameters (suppressed via
`#[allow(clippy::too_many_arguments)]`), and `daemon_loop` calls
it twice — once on the active-sync arm, once on the periodic-resync
arm — with identical clones of `pool`, `materializer`, `scheduler`,
`event_sink`, `cert`, `cancel`, `device_id`, etc.

Adding a new parameter (e.g. a `LifecycleHooks` reference for
foreground-aware backoff) means hand-editing both call sites in
lockstep with the signature change. The compiler will catch a
missed arity, but the two call sites drift in *order* easily — a
recent FEAT-13 / MAINT-108 patch added a parameter and the two
sites had different cloning patterns for ~half a session before
being unified.

**Suggested fix shape:**

* Introduce a `SyncSessionContext` struct in
  `sync_daemon/orchestrator.rs` (or `mod.rs`) holding the shared
  state by `Arc` / reference (no clones needed for the inputs that
  are already `Arc`-wrapped):

  ```rust
  pub(super) struct SyncSessionContext<'a> {
      pub pool: &'a SqlitePool,
      pub materializer: &'a Materializer,
      pub scheduler: &'a SyncScheduler,
      pub event_sink: &'a SyncEventSink,
      pub cert: &'a SyncCert,
      pub cancel: &'a CancellationToken,
      pub device_id: &'a str,
  }
  ```

* `try_sync_with_peer` becomes
  `try_sync_with_peer(ctx: &SyncSessionContext<'_>, peer: &DiscoveredPeer, …)`.

* Both `daemon_loop` arms construct the context once and pass `&ctx`.

**Cost estimate:** S (1-2 h). Pure renaming + wrapping.

**Risk:** low. No behavioral change; the test in
`sync_daemon/tests.rs` that exercises `try_sync_with_peer`
directly via test fixtures continues to compile after a small
fixture adjustment.

---

### M4 — `enqueue_background_tasks` is ~174 lines of imperative per-op cache-invalidation routing

**File:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/dispatch.rs" lines="149-322" />

**Problem:** the function maps `op_type` → set of
`MaterializeTask` rebuilds via a 12-arm match. Some arms are
unconditional (`set_property` always rebuilds the agenda + projected
agenda); others branch on `block_type_hint` (`create_block` for a
`block_type = "tag"` rebuilds the tags cache; for `"page"` rebuilds
the pages cache).

This is *data*: the relationship between op type and required
cache invalidation is a fixed matrix. Today it lives as imperative
code, which makes it hard to:

* audit (you cannot answer "which op types touch the agenda
  cache?" without reading every arm);
* extend (adding a new cache means touching several arms);
* test (you cannot pin "every op that mutates a tag relationship
  invalidates the tags cache" without re-reading the function).

The function ends at line 322 (174 lines total, including the
trailing `_other` `tracing::warn!` arm for unknown op types).

**Suggested fix shape:**

* Define a per-op-type table:

  ```rust
  fn invalidations_for_op(record: &OpRecord, hint: Option<&str>)
      -> Vec<MaterializeTask> {
      match record.op_type.as_str() {
          "create_block" => {
              let mut tasks = Vec::with_capacity(5);
              if let Ok(h) = serde_json::from_str::<CreateBlockHint>(&record.payload) {
                  match h.block_type.as_str() {
                      "tag"  => tasks.push(MaterializeTask::RebuildTagsCache),
                      "page" => tasks.push(MaterializeTask::RebuildPagesCache),
                      _ => {}
                  }
                  if !h.block_id.is_empty() {
                      let id: Arc<str> = Arc::from(h.block_id.as_str());
                      tasks.push(MaterializeTask::UpdateFtsBlock { block_id: Arc::clone(&id) });
                      tasks.push(MaterializeTask::ReindexBlockTagRefs { block_id: id });
                  }
              }
              tasks.extend([
                  MaterializeTask::RebuildTagInheritanceCache,
                  MaterializeTask::RebuildProjectedAgendaCache,
                  MaterializeTask::RebuildPageIds,
              ]);
              tasks
          }
          "set_property" | "delete_property" => vec![
              MaterializeTask::RebuildAgendaCache,
              MaterializeTask::RebuildProjectedAgendaCache,
          ],
          // …
      }
  }
  ```

* `enqueue_background_tasks` becomes a thin loop:

  ```rust
  for task in invalidations_for_op(record, block_type_hint) {
      self.try_enqueue_background(task)?;
  }
  ```

* Add a unit test pinning the matrix (one row per op type, asserts
  `invalidations_for_op` returns the expected set). When someone
  adds a new cache, the test forces them to update every row.

* **Do not** convert this to a `static` table at the top of the
  file — the per-arm logic still needs to read `record.payload`
  for the `create_block` `block_type_hint` branch and the
  `block_id`-bearing tasks. The function-with-match form below is
  the right shape.

**Cost estimate:** S (2-3 h). The match is mostly cut-and-paste;
the test matrix is the bulk of the time.

**Risk:** low. Existing materializer integration tests verify
end-to-end cache rebuild behavior; they catch any matrix drift.

---

## Excluded by validation (not in this file, kept here for the audit trail)

* **gcal H2 "duplicated classifier" claim** — REFUTED.
  `classify_date_err` already calls the shared `kind_display(kind)`
  at <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/gcal_push/connector.rs" lines="724-742" /> ; the doc above the function explicitly
  says "Per-variant string formatting is centralised in
  `kind_display` so this classifier and `classify_cycle_failure`
  cannot drift". Already correctly designed.
* **sync M2 "`SyncMessage` lacks compile-time exhaustiveness"** —
  REFUTED. The match in <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/sync_protocol/orchestrator.rs" lines="297-604" /> handles all 12 variants explicitly with no
  `_ =>` catch-all. The compiler enforces exhaustiveness today.
* **aux M4 "`mcp/registry.rs:55` uses OFFSET"** — REFUTED. No
  OFFSET anywhere in `mcp/registry.rs`. The only OFFSET in
  production code is the documented invariant-#3 carve-out at
  <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/history.rs" lines="438-501" /> for `undo_page_op_inner`'s "fetch the
  Nth row" semantics.
* **mcp H1 "JSON-RPC `\"id\": null` deviation"** — DOWNGRADED.
  The deviation at <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/mcp/server.rs" lines="233-240" /> is deliberate
  and documented in-source ("most MCP clients still expect a
  response"). At most a LOW.
* **core L3 "`commit_without_dispatch` has no production callers"**
  — REFUTED. Used at <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/journal.rs" lines="168-170" />.
* **mcp L1 "`ConnectionState::initialized` set but never read"**
  — REFUTED. Read by tests pinning the state machine. The right
  framing — "no production guard prevents `tools/call` before
  `initialize`" — is correct but is a low-impact protocol-strictness
  question, not a maintainability finding.
* **gcal_push `mod.rs:30-45` blanket `#[allow(dead_code)]` on six
  submodules** — already tracked in-source as L-127.
* **`gc_unused_peer_locks` documented but never called** — already
  noted in PEND-24's intro as a LOW chore, deliberately not in
  PEND-24's actionable list.
* **Materializer `pool.begin()` (DEFERRED) divergence from
  `BEGIN IMMEDIATE`** — already addressed by PEND-26's intro:
  invariant #2 is scoped to command handlers; the materializer is
  downstream and idempotent; SQLite WAL+DEFERRED gives sufficient
  snapshot isolation.
