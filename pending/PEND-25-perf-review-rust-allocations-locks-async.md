# PEND-25 — Rust performance review (2026-05-04): allocations / locks / async findings

## TL;DR

Two-pass performance review of the Rust backend (`src-tauri/`, ~183 K LOC across 210 files), focused exclusively on perf. **Pass 1**: six parallel investigation subagents partitioned the codebase by area. **Pass 2**: five parallel skeptical-validator subagents re-opened every finding against the actual code, grepped callers for frequency, cross-checked indexes against `migrations/`, and downgraded or refuted overstated claims.

Of 53 raw findings, this file logs the **18 that survived validation as ≥ LOW severity**. Items demoted to NIT, INVALID/HALLUCINATION, or "non-issue correctly flagged by the reviewer themselves" are deliberately omitted (see [§ Out of scope](#out-of-scope) for the rationale).

**Scope vs PEND-20:** this plan is the *Rust-level* (allocation, lock, async, dep-bloat) companion to PEND-20's *SQL-level* findings (indexes, `json_extract`, CTE materialisation, FTS chunking). The two are independent and don't conflict — pick from either.

> **These are findings, not commitments.** Each item is independently approve-able. Suggested ordering is at the bottom; the highest-leverage mechanical wins are L1, L3, L9, L2, L5 (in that order).

## Methodology

For each finding the validator subagent:

1. Re-opened the file at the cited lines (30–80 lines of context).
2. Grepped callers to estimate realistic call frequency (hot path vs cold path).
3. Cross-checked SQL index claims against `src-tauri/migrations/*.sql`.
4. Sanity-checked complexity claims, allocation counts, and memory math.
5. Marked the finding `VALID`, `OVERSTATED`, `INVALID`, or `NEEDS-MORE-CONTEXT`.

Severity floor for inclusion in this file:

- **MEDIUM**: real perf concern with measurable user-visible impact, or material binary-size / startup-latency concern.
- **LOW**: real but small impact, or larger but on a cold path; mechanical fixes welcome, no urgency.

`NIT` (technically true, no measurable impact) and `NON-ISSUE` (false alarm) are tracked in this PR's session notes only, not here.

## Summary

| ID  | Severity | Category    | Location                                                                  | Cost     | Risk | Confidence |
|-----|----------|-------------|---------------------------------------------------------------------------|----------|------|------------|
| M1  | MEDIUM*  | startup     | `src-tauri/src/lib.rs` setup hook (3 deferrable `block_on`s)              | M (4–7h) | low  | medium     |
| M2  | MEDIUM   | dep-bloat   | `src-tauri/Cargo.toml:169` (`oauth2` reqwest 0.12 vs repo 0.13) — MAINT-91| L (8h+)  | med  | high       |
| L1  | LOW      | lock        | `src-tauri/src/materializer/dispatch.rs:60–74`                            | trivial  | low  | high       |
| L2  | LOW      | allocation  | `src-tauri/src/materializer/handlers.rs:78,136`                           | S (1–2h) | low  | high       |
| L3  | LOW      | allocation  | `src-tauri/src/sync_protocol/operations.rs:364–368`                       | trivial  | low  | high       |
| L4  | LOW      | allocation  | `src-tauri/src/sync_protocol/operations.rs:479,489`                       | trivial  | low  | high       |
| L5  | LOW      | hash        | `src-tauri/src/backlink/{query.rs,grouped.rs}` + `materializer/dedup.rs`  | S (1h)   | low  | high       |
| L6  | LOW      | allocation  | `src-tauri/src/fts/strip.rs:68–73, 157–161`                               | S (1–2h) | low  | high       |
| L7  | LOW      | sql         | `src-tauri/src/fts/index.rs:240–257`                                      | S (1h)   | low  | high       |
| L8  | LOW      | memory      | `src-tauri/src/commands/agenda.rs:371–539` (on-the-fly fallback)          | M (3–5h) | med  | high       |
| L9  | LOW      | allocation  | 7 sites: `commands/{properties.rs:159,428; mod.rs:705; blocks/crud.rs:490,656,775,1054}` | S (2h) | low | high  |
| L10 | LOW      | allocation  | `src-tauri/src/dag.rs:178–204` (`walk_edit_chain`)                        | trivial  | low  | medium     |
| L11 | LOW      | allocation  | `src-tauri/src/merge/detect.rs:161–166`                                   | trivial  | low  | high       |
| L12 | LOW      | allocation  | `src-tauri/src/mcp/server.rs:512` (error-clip path)                       | trivial  | low  | high       |
| ~~L13~~ | — | — | ~~`src-tauri/src/sync_protocol/operations.rs:171, 767`~~ | — | — | — |
| L14 | LOW      | allocation  | `src-tauri/src/gcal_push/connector.rs:118–122` (`EventPatch` builder)     | trivial  | low  | high       |
| L15 | LOW      | memory      | `src-tauri/src/gcal_push/connector.rs:255` (unbounded `dirty_tx`)         | S (1–2h) | low  | high       |
| L16 | LOW      | n+1         | `src-tauri/src/gcal_push/connector.rs:486+589–595` (per-date agenda fetch)| S (2h)   | low  | high       |
| L17 | LOW      | allocation  | `src-tauri/src/error.rs:169` (`Serialize` always calls `to_string`)       | trivial  | low  | high       |

*M1 is rated MEDIUM **conditional on a profile**: only 3 of the 11 `block_on` calls are deferrable; the original reviewer's "window appears frozen" wording was speculative. **Profile on Android first.**

---

## MEDIUM

### M1 — Defer 3 boot-time `block_on` calls in the Tauri `setup` hook

**Location:** <ref_file file="/home/javier/dev/agaric/src-tauri/src/lib.rs" /> — 11 confirmed `tauri::async_runtime::block_on(...)` calls in the `.setup()` closure at lines 561, 617, 637, 652, 661, 684, 692, 724, 741, 761, 1083.

**Validation outcome:** the original reviewer claimed all 11 were a problem and that they "freeze the window". Pass 2 found:

- 8 are **correctness-required at boot**: pool init (561), `recovery::recover_at_boot` (617), FTS / `block_tag_refs` count probes (652, 661, 684, 692), `spaces::bootstrap_spaces` (724), `recovery::refresh_caches_for_recovered_drafts` (761).
- **3 are deferrable** to a `tauri::async_runtime::spawn` after the window is created:
  - **637**: `link_metadata::cleanup_stale(&pools.write, 30)` — purges stale link-preview rows >30 days; not blocking on UI.
  - **741**: `spaces::migrate_personal_pages_to_work` — one-shot migration the comment already labels "non-fatal — log and continue; the next boot will retry."
  - **1083**: `gcal_push::migration::migrate_legacy_gcal_to_personal_space` — legacy gcal config migration; already non-fatal on failure.
- The "window appears frozen" claim is **speculative**. Tauri 2's `setup` runs concurrently with window creation; the actual wall-clock impact is unmeasured.

**Why it's a perf concern:** on Android specifically, every ms of boot wait time is user-visible. If profiling confirms the 3 deferrable calls add >100 ms of boot work, moving them to a post-window-show task is essentially free.

**Fix outline:**

1. **Profile first.** On Android: `adb shell am start -W com.agaric.app/.MainActivity` and instrument `tauri::async_runtime::block_on` wrapper with `tracing::info!("block_on duration_ms = …")` for the three lines above. Don't refactor without evidence.
2. If the cumulative cost is non-trivial, replace each of the 3 `block_on(...)` calls with `tauri::async_runtime::spawn(async move { … })` and let them run after the window appears. Errors must continue to flow through the same `tracing::warn!` paths (they are already non-fatal).
3. Keep the other 8 `block_on` sites as-is. They are correctness-load-bearing.

**Cost / Risk / Confidence:** M (4–7 h including profiling) / low / medium.

### M2 — `oauth2` v5 pulls a duplicate `reqwest 0.12` alongside the repo's `reqwest 0.13`

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/Cargo.toml" lines="158-180" />

**Status:** **already tracked as MAINT-91** in `pending/REVIEW-LATER.md`. Surfacing here only because it was independently re-discovered by the perf-review pass and should be sequenced with binary-size work for Android.

**Why it's a perf concern:** ~500 KB of duplicated TLS + HTTP code in the release binary. Doesn't affect runtime perf, but matters for APK download size and install time.

**Fix outline:** as MAINT-91 already documents — write a thin `oauth2::AsyncHttpClient` adapter over `reqwest 0.13` and drop oauth2's `reqwest` feature flag in one commit (the repo's reqwest 0.13 stays the only HTTP stack).

**Cost / Risk / Confidence:** L (per MAINT-91 estimate) / medium / high. **Do not pursue independently of MAINT-91** — same body of work.

---

## LOW

### L1 — `Mutex<Option<Sender>>` cloned on every materializer enqueue

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/dispatch.rs" lines="59-74" />

**Evidence:**

```rust
pub(super) fn fg_sender(&self) -> Result<mpsc::Sender<MaterializeTask>, AppError> {
    self.fg_tx
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .ok_or_else(|| AppError::Channel("foreground queue closed".into()))
}
```

The sender is set once during materializer construction and never replaced; the `Mutex<Option<Sender>>` shape is over-strong.

**Validation note:** the original reviewer cited "17+ call sites"; that figure refers to a different comment (the 17+ dispatch sites in `commands/**`). Actual call sites of `fg_sender` / `bg_sender` are **7**.

**Fix outline:** replace `Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>` with `Arc<OnceLock<mpsc::Sender<MaterializeTask>>>` in `Materializer`. Initialise via `OnceLock::set` during construction. The 7 call sites become `self.fg_tx.get().cloned().ok_or_else(...)`.

**Cost / Risk:** trivial / low. No correctness risk — `OnceLock` enforces the same single-write semantic.

### L2 — Cloning `OpRecord` into `DeferredNotification` in batch apply

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/handlers.rs" lines="62-82" />

**Evidence:**

```rust
for record in records.iter() {
    let snapshot = snapshot_for_op(&mut tx, record).await?;
    // ... apply ...
    if gcal_handle.get().is_some() {
        pending_events.push(DeferredNotification {
            record: (*record).clone(),  // clones OpRecord (5 owned String fields)
            snapshot,
        });
    }
}
```

**Validation note:** only triggers when GCal integration is active; M-10 already wraps the batch in `Arc<Vec<OpRecord>>` so the input side is cheap.

**Fix outline:** change `DeferredNotification.record: OpRecord` to `record: Arc<OpRecord>`. At construction store `Arc::clone(record)` (cheap atomic increment) instead of deep-cloning. `notify_gcal_for_events` and downstream consumers take `&OpRecord` so the `Arc` is transparent. **Pairs naturally with L9** (same shift to `Arc<OpRecord>` in the dispatch queue).

**Cost / Risk:** S (1–2 h) / low.

### L3 — Double clone of `block_id` for HashMap-by-block grouping in `apply_remote_ops`

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/sync_protocol/operations.rs" lines="361-377" />

**Evidence:**

```rust
let mut groups: HashMap<Option<String>, Vec<OpRecord>> = HashMap::new();
let mut group_order: Vec<Option<String>> = Vec::new();
for record in to_materialize {
    let key = record.block_id.clone();          // clone 1
    if !groups.contains_key(&key) {
        group_order.push(key.clone());            // clone 2
    }
    groups.entry(key).or_default().push(record);  // moves the first clone
}
```

For 5 000-op batches with ~100 unique block IDs, this is ~5 100 unnecessary `Option<String>` clones.

**Fix outline:** restructure to one `Option<String>` allocation per record using `entry(...).or_insert_with(Vec::new)` and a parallel `group_order` push gated on insertion outcome. Sketch:

```rust
for record in to_materialize {
    let key = record.block_id.clone();        // unavoidable: needed by both maps
    match groups.entry(key) {
        Entry::Vacant(v) => {
            group_order.push(v.key().clone());
            v.insert(vec![record]);
        }
        Entry::Occupied(mut o) => o.get_mut().push(record),
    }
}
```

Two clones per *first* occurrence, one per repeat — vs the current two per record.

**Cost / Risk:** trivial / low.

### L4 — `Arc::new(record.clone())` on merge-outcome path

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/sync_protocol/operations.rs" lines="476-497" />

**Evidence:** `MergeOutcome::Merged(ref record)` and `MergeOutcome::ConflictCopy { ref conflict_block_op, … }` each call `Arc::new(record.clone())`. The records are not used after the `enqueue_foreground` await on either arm.

**Fix outline:** rebind to owned values with `let record = record;` after a `MergeOutcome` `match` that destructures by value (not `ref`), then `Arc::new(record)` directly. **Cold path** (only on conflict resolution, rare).

**Cost / Risk:** trivial / low.

### L5 — `std::collections::HashMap` instead of `FxHashMap` (already a dep)

**Locations:**

- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="219-222" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="259-264" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="290-291" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="353-358" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/query.rs" lines="394-395" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/grouped.rs" lines="183-186" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/grouped.rs" lines="259-266" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/grouped.rs" lines="538-540" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/grouped.rs" lines="626-633" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/backlink/sort.rs" lines="6-8" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/dedup.rs" lines="3-10" />

**Why:** SipHash (the default) is cryptographically secure but ~3× slower than `rustc_hash::FxHasher` on small keys. Maps in scope are typically ≤100 entries, so the absolute saving is small — but the change is mechanical and aligns with AGENTS.md's noted preference.

**Fix outline:** add `use rustc_hash::{FxHashMap, FxHashSet};` per file, replace each `std::collections::HashMap` with `FxHashMap`. For `materializer/dedup.rs:5–10` (`hash_id` helper), swap `DefaultHasher::new()` for `rustc_hash::FxHasher::default()`. One mechanical commit.

**Cost / Risk:** S (≤1 h) / low.

### L6 — Five sequential `Regex::replace_all().to_string()` materialisations in `strip_for_fts`

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/fts/strip.rs" lines="63-78" /> and <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/fts/strip.rs" lines="155-165" />

**Evidence (paraphrased):** five back-to-back `result = REGEX.replace_all(&result, "$1").to_string();` for bold, italic, code, strike, highlight markup. Each `.to_string()` materialises the `Cow<str>` even when the regex didn't match.

**Validation note:** **cold path** — runs on full FTS rebuild and on tag/page rename reindex, NOT on every block edit (per-edit FTS goes through a different path).

**Fix outline:** combine the five patterns into one alternation regex with named or numbered captures and a single `replace_all` call — or chain via `Cow` and only `.to_string()` once at the end. Stay inside the existing `LazyLock<Regex>` shape so compile cost stays one-time.

**Cost / Risk:** S (1–2 h) / low. Regression risk is bounded by the existing FTS-strip tests.

### L7 — Per-row `INSERT INTO fts_blocks` in reindex loop

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/fts/index.rs" lines="220-260" />

**Evidence:** the loop issues one `INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)` per row inside a single transaction. Comment correctly notes that `strip_for_fts_with_maps` is sync and can't be moved out of the loop.

**Validation note:** in WAL-mode SQLite, 1 000 inserts in a transaction is ~5–10 ms — already fast. Cold path (rebuild + tag/page rename only).

**Fix outline:** chunk into multi-row `INSERT … VALUES (?,?), (?,?), …` blocks of ~100–500 rows. Same correctness guarantees, modest constant-factor win on rename storms.

**Cost / Risk:** S (1 h) / low.

### L8 — On-the-fly projected-agenda fallback fetches **all** repeating blocks before paginating

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/agenda.rs" lines="371-540" /> (`list_projected_agenda_on_the_fly`)

**Evidence:** the SQL query has no `LIMIT`; the function calls `.fetch_all(pool)` and applies cursor pagination *after* projection.

**Validation note:** **only fires when the projected-agenda cache is empty AND no cursor has been issued** (the cache is rebuilt at boot via `lib.rs:715`). For typical users with dozens of repeating tasks this is fine; for users with thousands it spikes RAM on first page-load before the cache warms.

**Fix outline:** push a SQL-side `LIMIT` of ~`fetch_limit * REPEAT_FANOUT_FACTOR` (a conservative multiplier for the projection blow-up). If the projected output is short of the requested page, fall back to the existing unbounded fetch. Keep the existing parity test (PEND-05, currently `#[ignore]`d under MAINT-196) green.

**Cost / Risk:** M (3–5 h) / medium. Touches a function that already has known projection drift (MAINT-196) — sequence after MAINT-196 lands.

### L9 — `op_record.clone()` before `enqueue_*` in 7 commands

**Locations:**

- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/properties.rs" lines="156-163" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/properties.rs" lines="425-432" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/mod.rs" lines="700-712" />
- <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/blocks/crud.rs" lines="488-498" />
- `src-tauri/src/commands/blocks/crud.rs:656` (mirror pattern)
- `src-tauri/src/commands/blocks/crud.rs:775` (mirror pattern)
- `src-tauri/src/commands/blocks/crud.rs:1054` (mirror pattern)

**Evidence (representative):**

```rust
tx.enqueue_edit_background(op_record.clone(), block_type.clone());  // takes ownership
tx.commit_and_dispatch(materializer).await?;
if let Some(snapshot) = gcal_snapshot {
    materializer.notify_gcal_for_op(&op_record, &snapshot);  // needs original
}
```

The clone is unavoidable today because `enqueue_*_background` takes ownership of `op_record` while the post-commit GCal notification borrows the original.

**Validation note:** the original reviewer claimed "15+ commands" — actual is **7**. Each `OpRecord` is small (5 owned `String`s plus payload); per-command cost is negligible, but the duplication is a code-clarity tax across 7 sites.

**Fix outline:** change the `enqueue_*_background` family to take `Arc<OpRecord>` (or `&Arc<OpRecord>`) instead of `OpRecord`. Each call site changes from `op_record.clone()` to `Arc::clone(&op_record)` (atomic increment, no String allocations). `notify_gcal_for_op` continues to take `&OpRecord` — the `Arc::deref` is invisible. **Pair with L2** since both want the same `Arc<OpRecord>` shift.

**Cost / Risk:** S (~2 h) / low. `Tx` plumbing is contained.

### L10 — `walk_edit_chain` clones `device_id` strings on every iteration

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/dag.rs" lines="170-210" />

**Evidence:** `HashSet<(String, i64)>` populated by cloning `row.device_id` per iteration. Bound is `MAX_LCA_STEPS = 10 000`.

**Validation note:** **cold path** — used only for LCA computation during merge conflict resolution. The actual hot-path LCA at `dag.rs:536` already uses `HashSet<(&str, i64)>` with borrowed strings.

**Fix outline:** reuse the borrowed-`&str` shape from the hot-path LCA. Either store hashes (`u64` via `FxHasher`) or thread lifetimes through `walk_edit_chain` so the visited set borrows from `rows`.

**Cost / Risk:** trivial / low. Confidence is `medium` because the cold-path nature shrinks the win.

### L11 — Two-allocation truncation of a 64-char blake3 hex digest

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/merge/detect.rs" lines="158-168" />

**Evidence:**

```rust
let conflict_digest: String = blake3::hash(conflict_text.as_bytes())
    .to_hex()        // returns ArrayString<64> (stack)
    .to_string()     // alloc 1: String of 64 chars
    .chars()
    .take(16)
    .collect();      // alloc 2: String of 16 chars
```

**Validation note:** cold path (sync merge only). The original reviewer described `to_hex()` as returning a `String`; it actually returns `arrayvec::ArrayString<64>` — minor, doesn't change the fix.

**Fix outline:** `let hex = blake3::hash(...).to_hex(); let conflict_digest = hex.as_str()[..16].to_owned();` — one allocation, no `.chars()` walk.

**Cost / Risk:** trivial / low.

### L12 — Error-clip path allocates twice in MCP tool dispatch

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/mcp/server.rs" lines="508-518" />

**Evidence:**

```rust
let short: String = err.to_string().chars().take(ERROR_CLIP_CAP).collect();
```

`err.to_string()` allocates the full message; `.chars().take(N).collect()` allocates the truncated copy.

**Validation note:** error path only — failed tool calls are <5 % of MCP traffic in practice. No latency floor is set by this allocation.

**Fix outline:** introduce a small helper:

```rust
fn truncate_chars(s: &str, n: usize) -> String {
    s.char_indices().nth(n).map_or_else(|| s.to_owned(), |(byte_idx, _)| s[..byte_idx].to_owned())
}
```

Pass `&err.to_string()` through it (or, better, take `impl Display` and write into a `String::with_capacity(ERROR_CLIP_CAP)` buffer via `write!`).

**Cost / Risk:** trivial / low.

### ~~L13~~ — *Excluded:* op payload JSON-parsed twice on the merge path

**Locations originally flagged:** `src-tauri/src/sync_protocol/operations.rs:171, 767`.

**Excluded by user direction**, mirroring PEND-20's exclusion of the same surface: the merge layer (`sync_protocol/operations.rs::merge_diverged_blocks` and friends) is being replaced wholesale by CRDT (PEND-09). Optimising it now is wasted work.

Listed here only so a future review pass doesn't re-discover and re-file it. Re-evaluate post-PEND-09; almost certainly the entire function disappears.

### L14 — Three `String::clone` in `EventPatch` builder per digest event

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/gcal_push/connector.rs" lines="115-125" />

**Evidence:** `event.summary.clone()`, `event.description.clone()`, `event.transparency.clone()` per built `EventPatch`.

**Fix outline:** widen the `EventPatch::with_*` setters from `String` to `impl Into<String>` and pass `event.summary` directly when the source is owned. Or change `EventPatch` to borrow (`&'a str`) and resolve at serialisation time.

**Cost / Risk:** trivial / low.

### L15 — `dirty_tx` is an `mpsc::UnboundedSender<DirtyEvent>` in the GCal connector

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/gcal_push/connector.rs" lines="252-260" />

**Validation note:** the original reviewer's "several MB" memory math was **off by ~50×**. Correct envelope: `NaiveDate` is 4 bytes; `DirtyEvent { old_affected_dates: Vec<NaiveDate>, new_affected_dates: Vec<NaiveDate> }` is ~88 B per event with 5 dates per Vec. 1 000 buffered events ≈ 88 KB, not "several MB". The 500 ms debounce window plus the consumer's `BTreeSet` dedup naturally bound queued growth.

**Fix outline:** **defensive only** — replace with `mpsc::channel(N)` for `N ∈ [256, 1024]` and use `try_send` so producers never `.await` on backpressure (single-user app — drops are recoverable on the next reconcile cycle). Don't bother unless a real bursty workload appears.

**Cost / Risk:** S (1–2 h) / low.

### L16 — Per-date sequential agenda fetch in the GCal connector cycle

**Location:** loop at <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/gcal_push/connector.rs" lines="484-495" /> calling `push_date(...)` which in turn calls <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/gcal_push/connector.rs" lines="585-610" />

**Evidence:** each dirty date triggers a separate `list_projected_agenda_inner(date, date, ...)` call. For a 30-day window with 20 dirty dates that's 20 sequential queries.

**Validation note:** background task. Cycle frequency is 500 ms debounce + 15 min reconcile, not 1 Hz. 20 queries × ~2 ms ≈ 40 ms is fully acceptable.

**Fix outline:** if profiling shows it's worth the change, batch into a single `list_projected_agenda_inner(min_date, max_date, ...)` call and group the results in-process. Keep the existing per-date GCal upsert semantic — only the read query collapses.

**Cost / Risk:** S (~2 h) / low. Don't pursue without a profile demonstrating real cost.

### L17 — `AppError::Serialize` always materialises `to_string()` even on the success path

**Location:** <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/error.rs" lines="165-175" />

**Evidence:** `state.serialize_field("message", &self.to_string())?;` always allocates the formatted message, even when no IPC consumer reads it.

**Validation note:** errors crossing the IPC boundary are rare; this is on the cold path.

**Fix outline:** keep as-is. Documenting here only because it's the "boundary cost" of the AppError pattern — if AppError ever moves to `Cow<'static, str>` for static-string variants the saving is automatic.

**Cost / Risk:** trivial / low. **Likely no fix needed**; flagging for completeness.

---

## Recommended ordering

Highest-leverage mechanical wins first, dependencies in mind:

1. **L1** — `Mutex<Option<Sender>>` → `OnceLock<Sender>`. Tiny diff, removes 7 lock acquisitions per IPC dispatch.
2. **L3** — `entry()` API in `apply_remote_ops`. Drops 2× `block_id.clone()` per remote op. Tiny diff.
3. **L5** — `HashMap` → `FxHashMap` sweep + `materializer/dedup.rs` hasher. One mechanical commit, broad surface.
4. **L9 + L2** — `Arc<OpRecord>` shift across `enqueue_*_background` family **and** `DeferredNotification`. Land together (same type change).
5. **L11, L4, L14, L17, L12** — micro-fixes (each ≤30 min). Batch into a single "perf nits" PR.
6. **L6 + L7** — FTS strip / reindex polish. Cold path, low priority. Batch with any other FTS work.
7. **L10** — `walk_edit_chain` borrowing. Cold path. Schedule whenever a merge-detect change brings the file into scope.
8. **L8** — projected-agenda on-the-fly fallback. **Sequence after MAINT-196** (drift refactor) lands.
9. **L15, L16** — only if profiling shows concrete need. Otherwise leave alone.
10. **M1** — defer 3 boot `block_on` calls. **Profile on Android first.**
11. **M2** — see MAINT-91; not standalone work.

*L13 deliberately omitted — superseded by PEND-09 CRDT migration (matches PEND-20's same-surface exclusion).*

---

## Out of scope

The following 1st-pass findings were demoted and are **not** in this file:

- **8 hallucinations / wrong claims** caught by validation:
  - "redundant `device_id.to_string()`" at `op_log.rs:197` — `device_id` is `&str`, the conversion is required.
  - "JSON re-parse to extract block_id" at `gcal_push/dirty_producer.rs:210` — wrong function; `compute_dirty_event` doesn't call `extract_block_id_from_payload`.
  - "O(N·M·log M) intersection" at `backlink/query.rs:124` — math error; `FxHashSet::contains` is O(1), so it's O(N·M).
  - "1000 placeholder allocations" at `backlink/query.rs:316` — wrong; `repeat_n("?", n).collect()` is exactly **2** allocations regardless of N.
  - "block_on() not awaited" at `lib.rs:706, 715, 751` — those are `try_enqueue_background` (intentionally non-blocking).
  - "Several MB" memory estimate for `dirty_tx` channel — off by ~50×; correct envelope is ~88 KB.
  - "Missing composite index for space filter" — false; SQLite's existing partial index `(value_ref) WHERE key = 'space'` is functionally equivalent and more space-efficient.
  - "17+ sender call sites" for `Mutex<Option<Sender>>` — actual is 7.

- **NIT-tier** items (technically true, no measurable impact): `tokenize_query` allocations, dynamic SQL `format!` placeholder building, `set_todo_state_inner` `block_id.clone()` (driven by helper signature), 10-byte `date_str.clone()`, `link_metadata` `to_lowercase()`/`format!` patterns (cold path: once per pasted URL), `dedup_tasks` consuming a `Vec` (output `Vec` is unavoidable).

- **Reviewer-acknowledged non-issues**: `OnceLock<reqwest::Client>` (correct), streaming `zstd::Decoder` + `ciborium::from_reader` (correct), exponential-backoff scheduler (correct), `LazyLock<Regex>` everywhere, `BEGIN IMMEDIATE` discipline, cursor pagination invariants, recursive-CTE `is_conflict = 0` filtering, snapshot in-memory materialisation (acknowledged limitation per L-105 — out of scope per AGENTS.md "Architectural Stability").

- **Already tracked elsewhere**: PERF-19 (backlink cursor linear scan), PERF-20 (backlink filter `try_join_all` concurrency cap), MAINT-91 (oauth2 reqwest), MAINT-196 (projected-agenda projection drift). These existed in `pending/REVIEW-LATER.md` before this review and remain there.
