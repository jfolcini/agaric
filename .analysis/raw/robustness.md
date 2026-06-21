# Robustness Analysis — Agaric (failure modes & resilience)

## Summary
I audited the durability/crash-safety/error-handling surfaces in scope: Rust `recovery/`,
`snapshot/`, `sync_daemon/`, `sync_net/`, `sync_protocol/`, `sync_files/`, `db/`, `op_log/`,
`draft/`, `link_metadata/`, attachment + import command paths; and TS `lib/tauri.ts`,
`logger.ts`, `workers/`, error boundaries, import/export, attachments, rendering.

**Finding: this scope is exceptionally robust.** I could not find a single high-confidence
genuine defect. Every pattern an automated sweep flags (`.unwrap()`, `JSON.parse` without
try/catch, "no error boundary", worker error handling, decompression bombs, partial-write
windows, bypass-sentinel leaks) is already deliberately guarded — usually with an inline
comment citing the issue number that motivated the guard. Two parallel grep-based sub-agents
returned ~15 candidate findings; **I verified each by reading the enclosing code and every
one was a false positive** (the grep matched a line inside an existing `try`/`catch`, a
`#[cfg(test)]` block, or a provably-unreachable branch). Reported below are only a couple of
genuinely-uncertain LOW/informational observations, all marked with honest confidence.

### Count by severity
- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- LOW: 2 (both low-confidence / defense-in-depth, may be WONTFIX)

---

### [LOW] `op_log` bypass relies on straight-line enable/disable, not an RAII guard
- **Location**: src-tauri/src/op_log/bypass.rs:18-47; callers snapshot/restore.rs:205-207,
  snapshot/create.rs:478-496
- **Evidence**: `enable_op_log_mutation_bypass` inserts a sentinel row into
  `_op_log_mutation_allowed`; `disable_op_log_mutation_bypass` deletes it. Callers pair them
  manually around a `DELETE FROM op_log`. If the *disable* call were ever skipped on a path
  that still commits, append-only enforcement is silently disabled DB-wide (the triggers gate
  on `WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)`).
- **Problem**: There is no type-level/RAII guarantee the disable runs before commit. The
  contract is doc-comment + convention.
- **Impact**: A future caller (or refactor) that early-returns to commit between enable and
  disable would silently turn off op-log immutability. NOTE: in the current code this is
  *not* a live bug — both call sites are straight-line, and any error between enable/disable
  causes the whole `tx` to roll back (the sentinel INSERT rolls back too). There is also a
  boot backstop, `clear_leaked_bypass_sentinel` (db/pool.rs:383-400), that deletes a leaked
  sentinel at startup and warns. So this is defense-in-depth, not a defect.
- **Fix**: (optional) wrap the sentinel in an RAII scope guard whose `Drop`/explicit
  `finish(&mut tx)` issues the DELETE, so the disable cannot be forgotten by construction.
  Given the existing straight-line discipline + boot backstop + the project's stated aversion
  to over-engineering, this may be WONTFIX.
- **Confidence**: low — current code is correct; this is a latent-maintenance hazard only.
- **Effort**: S

### [LOW] Sync file-transfer failures are swallowed as non-fatal (by design) — verify UX surfacing
- **Location**: src-tauri/src/sync_daemon/orchestrator.rs:1088-1096 ("initiator file transfer
  failed (non-fatal)"); 1094-1096 ("could not determine app_data_dir, skipping file transfer")
- **Evidence**: After op-sync succeeds, attachment file transfer errors are logged at `warn`
  and the session still reports `Complete`. The `app_data_dir` lookup failure also just skips
  the whole transfer with a warn.
- **Problem**: A user whose op-sync completed but whose attachment bytes failed to transfer
  sees "sync complete" with no surfaced indication some attachments are missing. (This is the
  documented design — sync GC reconciles missing attachments later — so it is arguably
  correct graceful degradation, not a bug.)
- **Impact**: Transient "image not found" until the next sync round reconciles. No data loss
  (op-log + metadata are intact; only the blob lags).
- **Fix**: (optional) emit a distinct non-fatal `SyncEvent` (e.g. `AttachmentsPending { n }`)
  so the UI can show "N attachments still syncing" instead of an unqualified Complete.
- **Confidence**: low — this is very likely an intentional design choice per the threat model
  ("sync GC reconciles missing attachments anyway"), included only for the validator's
  awareness. Probably WONTFIX.
- **Effort**: M

---

## Verified-and-cleared (false positives from the automated sweep)

These were flagged by sub-agents or are the obvious grep hits; I read each and confirmed they
are correctly guarded. Listing them so the validator knows they were checked, not skipped.

- **"No React error boundaries" (claimed HIGH)** — FALSE. A robust root boundary exists at
  `src/components/common/ErrorBoundary.tsx` (full `getDerivedStateFromError` +
  `componentDidCatch` → logger + crash UI + bug-report), mounted in `main.tsx`, plus a
  per-feature `src/components/common/FeatureErrorBoundary.tsx` used across views
  (GraphView, HistoryView, PageEditor, AppSidebar, etc.).
- **`JSON.parse` without try/catch (claimed HIGH, multiple files)** — FALSE in every cited
  case. `lib/history-utils.ts:9/31/49` are all inside `try { … } catch {}`;
  `lib/editor-preferences.ts:20/47` inside try/catch returning a safe default;
  `lib/agenda-filters.ts:91` inside try/catch returning null; `lib/tag-colors.ts:125` inside
  try/catch returning `{}`. All localStorage/cursor parses degrade gracefully.
- **Worker missing error handling** — FALSE. `src/workers/graph-worker.ts` wraps the message
  dispatcher in try/catch and posts a structured `{type:'error'}` (no re-throw), AND
  registers global `error` + `unhandledrejection` handlers (#1614). Main-thread side
  (`graph-sim-helpers.ts`) registers `message`/`error`/`messageerror`.
- **Rust `.unwrap()` in production** — the only non-test hit in scope is
  `recovery/draft_recovery.rs:277` `heads.into_iter().next().unwrap()`, which is inside the
  `match heads.len() { 1 => … }` arm and therefore provably non-empty. Safe.
- **`AbortController` / listener / timer leaks** — `lib/tauri.ts withAbort` adds+removes the
  abort listener on both settle paths; sampled hooks (useToday, usePrefersReducedMotion,
  useLinkPreview, useTauriEventListener) all return cleanups.

## Areas reviewed in depth (and found sound)
- **db/pool.rs**: split read/write pools, `query_only` boot assertion, acquire-timeout aligned
  to UX budget, `next_delete_ms` CAS monotonic clock, boot bypass-sentinel cleanup. Exemplary.
- **op_log/append.rs**: `BEGIN IMMEDIATE` contract is lint-enforced (`check-raw-tx`), seq
  derivation atomic, hash determinism via ULID normalization. Sound.
- **snapshot/codec.rs**: zstd decompression-bomb bounds (ratio + slack + window_log_max),
  blake3 content checksum with streaming hashing reader, back-compat legacy path, schema
  version gate before tables decode. Best-in-class for the untrusted-decompression surface.
- **recovery/boot.rs**: once-only AtomicBool guard, ordered replay (cursor heal → op replay →
  sync-inbox replay → drafts → attachment backfill), "log + continue" non-fatal philosophy so
  boot always completes, chunked IN-clause for >999 drafts. Sound.
- **snapshot/restore.rs + create.rs**: bypass enable/disable straight-line, atomic
  multi-table wipe in one tx (op_log + loro_doc_state + loro_sync_inbox + log_snapshots +
  peer id), rollback-consistent. Sound.
- **sync_daemon/orchestrator.rs**: responder JoinHandle watcher surfaces panics/cancels,
  #1581 concurrency permit held for session lifetime, #637 CancelGuard ownership model
  prevents a sibling swallowing a user cancel, peer-lock GC on coarse cadence, mDNS graceful
  fallback. Sound.
- **commands/attachments.rs**: size cap (50 MB), MIME allow-list, path-shape escape check,
  on-disk size + existence verification, I/O moved outside the writer lock (#1620). Sound.
- **import.rs / commands/pages/markdown.rs**: depth clamp (MAX_IMPORT_DEPTH=20 < CTE 100),
  chunked per-subtree transactions with well-defined partial-import semantics, frontmatter
  reserved-key filtering. Content arrives pre-read from FE (no backend OOM-on-read). Sound.
- **link_metadata/html_parser.rs**: pure string parsing, all outputs length-capped,
  `truncate_str` slices on UTF-8 char boundaries (no multibyte panic). Sound.
- **workers/graph-worker.ts** & **lib/tauri.ts**: see above. Sound.

## Areas NOT deeply reviewed (coverage gaps for the validator)
- `sync_net/{connection,websocket,tls}.rs` — read the daemon-level wire usage but did not
  line-audit the websocket framing / chunked binary stream internals or TLS handshake error
  paths. Worth a dedicated pass.
- `sync_protocol/loro_sync.rs` & `orchestrator.rs` (per-session state machine) — read the
  daemon's driver loop; the state-machine transition error handling itself was not audited.
- `recovery/replay.rs` & `sync_inbox.rs` internals — read their call sites in boot.rs but not
  their bodies in full.
- `lib/logger.ts` / `logger-transport.ts` — not read in detail.
- import/export FE code (`lib/export-graph.ts`, bug-report-zip) — not audited.
- `materializer/` retry-queue durability — out of explicit scope but adjacent; not reviewed.
