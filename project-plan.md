# Block Notes App — Project Plan

> Local-first · Linux + Android · Journal-first · No cloud

**Total at ~10 h/week:** 12–18 months · **Daily driver:** Month 3–4

---

## Critical Path

These tasks block everything downstream. Ship them before moving on.

- Markdown serializer + tests
- Composite op log PK + hash chain
- Materializer CQRS split
- Cursor-based pagination from day one
- Android spike gate before Phase 2
- Crash-safe snapshot write sequence

## Non-Negotiables

- Op log append-only invariant
- Materializer CQRS split
- Three-way merge for sync
- Pagination on all list queries

---

## Phase 1 — Foundation

**Estimate:** 6–8 weeks
**ADRs:** ADR-04, ADR-05, ADR-06, ADR-07, ADR-08, ADR-13

> Data model lock, op log, materializer skeleton, CI gates. Nothing ships until this is bulletproof.

### Repo & Tooling

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p1-t1 | Init Tauri 2.0 workspace | infra | | Done | [ADR-01] Cargo workspace with src-tauri + frontend packages. Commit the skeleton before any logic. |
| p1-t2 | Vite + React 18 frontend scaffold | infra, frontend | | Done | [ADR-01] vite.config.ts with path aliases, strict TS config. |
| p1-t3 | Biome — non-negotiable day one | dx | **YES** | Done | [ADR-01, ADR-13] biome.json, lint + format scripts, pre-commit hook. Retrofitting later = whole-repo churn. |
| p1-t4 | GitHub Actions CI skeleton | infra, dx | | Done | [ADR-13] cargo test, cargo fmt --check, biome check, cargo sqlx prepare --check. Gates open immediately. |
| p1-t5 | Device UUID generation + persistence | backend | | Done | [ADR-07] UUID v4 on first launch, stored in config file outside the DB. Never regenerated. |

### Database & Schema

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p1-t6 | sqlx + sqlx-cli bootstrap | backend, dx | **YES** | Done | [ADR-04] DATABASE_URL env, sqlx::Pool, WAL mode pragma, single write connection. Read pool from Phase 1. |
| p1-t7 | 0001_initial.sql migration | backend | **YES** | Done | [ADR-05] Full schema: blocks, block_tags, block_properties, block_links, attachments, op_log, block_drafts, log_snapshots, peer_refs, all cache tables. All indexes. One migration, correctly ordered. |
| p1-t8 | .sqlx offline cache + CI check | dx, infra | | Done | [ADR-04, ADR-13] cargo sqlx prepare committed. CI gate active immediately — stale cache = build failure. |
| p1-t9 | thiserror + anyhow error types | backend | | Done | [ADR-11] AppError enum covering DB, IO, parse, ULID errors. Consistent Tauri command error serialisation. |
| p1-t10 | ULID generation utility (Rust) | backend | | Done | [ADR-05, ADR-11] Newtype wrapper. ulid crate. Used for all IDs from day one. |

### Op Log Core

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p1-t11 | Op log writer — local ops | backend | **YES** | Done | [ADR-07] Composite PK (device_id, seq). seq via MAX+1 serialised on write conn. parent_seqs written as null or single-entry array from day one — no migration needed at Phase 4. |
| p1-t12 | blake3 hash computation | backend | | Done | [ADR-07, ADR-11] Hash fn: blake3(device_id \|\| seq \|\| parent_seqs_canonical \|\| op_type \|\| payload_canonical). parent_seqs sorted lexicographically for determinism. |
| p1-t13 | Op payload types — serde structs | backend | | Done | [ADR-07] Rust structs for all op_type payloads (ADR-07). Exhaustive match — no catch-all arms. |
| p1-t14 | Block draft writer (2s autosave) | backend | | Done | [ADR-07] INSERT OR REPLACE into block_drafts. Tauri command. Delete on flush. |
| p1-t15 | Crash recovery at boot | backend | **YES** | Done | [ADR-07] Delete pending log_snapshots. Walk block_drafts, compare to op_log created_at, emit synthetic edit_block ops. Log warning per recovered draft. |

### Materializer Skeleton

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p1-t16 | Foreground queue (tokio mpsc) | backend | **YES** | Done | [ADR-08] Viewport block reads. Low-latency. Single write conn serialises materializer ops. |
| p1-t17 | Background queue | backend | | Done | [ADR-08] tags_cache, pages_cache, agenda_cache, block_links index, FTS5 bootstrap. Stale-while-revalidate from day one — never block on cold boot. |
| p1-t18 | tags_cache rebuild trigger + query | backend | | Done | [ADR-08] LEFT JOIN from blocks to capture zero-usage tags. Staleness threshold: 5s. Used for #[ulid] autocomplete. |
| p1-t19 | pages_cache rebuild trigger + query | backend | | Done | [ADR-08] Rebuild on create/delete/restore/edit of page blocks. 5s threshold. |
| p1-t20 | agenda_cache materializer | backend | | Done | [ADR-08] Triggers: set_property (value_date), add_tag / remove_tag (date/YYYY-MM-DD pattern). Full recompute, 2s threshold. |
| p1-t21 | block_links index materializer | backend | | Done | [ADR-08] Trigger: edit_block. Parse [[ULID]] via regex. Diff against prior index. Delete removed, insert new. Pure read cache — drop+rebuild always safe. |
| p1-t22 | Pagination — cursor-based on ALL list queries | backend | **YES** | Done | [ADR-08] Zero exceptions. Enforced from Phase 1. Offset pagination is banned. Cursor/keyset only. |
| p1-t23 | Soft-delete cascade (recursive CTE) | backend | | Done | [ADR-06] delete_block with cascade:true. Single op covers subtree. Materializer walks descendants and sets deleted_at to same timestamp. |

### Tauri Commands (minimal set)

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p1-t24 | Tauri command: create_block | backend | | Done | [ADR-06, ADR-07] Writes create_block op. Returns new block. Validates parent_id exists if provided. |
| p1-t25 | Tauri command: edit_block | backend | | Done | [ADR-06, ADR-07] Writes edit_block op with to_text + prev_edit. Triggers materializer. |
| p1-t26 | Tauri command: delete_block / restore_block / purge_block | backend | | Done | [ADR-06, ADR-07] cascade:true always. restore checks deleted_at_ref timestamp matching. |
| p1-t27 | Tauri command: list_blocks (paginated) | backend | | Done | [ADR-08] Keyset pagination. Accepts parent_id filter, block_type filter, deleted_at IS NULL by default. |
| p1-t28 | Boot state machine (Zustand) | frontend | | Done | States: booting → recovering → ready \| [ADR-02] error. Blocks UI during crash recovery. No skeleton flash on clean boot. |

### Testing & CI

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p1-t29 | cargo test suite for op log + materializer | testing | **YES** | Done | [ADR-13] Test: op ordering, hash chains, crash recovery simulation, cascade delete, position compaction. |
| p1-t30 | Vitest project config | dx, testing | | Done | [ADR-13] jsdom environment, coverage with v8. Path aliases mirrored from vite.config. |
| p1-t31 | sqlx compile-time query validation in CI | dx, infra | | Done | [ADR-04, ADR-13] All query! macros validated at compile time. Offline cache keeps CI fast without a live DB. |

---

## Phase 1.5 — Daily Driver

**Estimate:** 4–6 weeks + 4–8 weeks real use
**ADRs:** ADR-01, ADR-20

> The editor you'll actually use every day. Serializer must ship and pass tests before any other task in this phase begins.

### Markdown Serializer — MUST SHIP FIRST

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p15-t1 | markdown-serializer.ts — standalone module | frontend | **YES** | [ADR-20] [REVIEWED] src/editor/markdown-serializer.ts. Zero deps on tiptap-markdown or any Markdown library. ~150 lines. Only schema: bold/italic/code/tag_ref/block_link. |
| p15-t2 | Serializer: parse() — Markdown → ProseMirror doc | frontend | **YES** | [ADR-20] [REVIEWED] Single-pass hand-rolled parser. Regex for token ID only. Mark stack — unclosed marks become plain text, never error. |
| p15-t3 | Serializer: serialize() — ProseMirror doc → Markdown | frontend | **YES** | [ADR-20] [REVIEWED] hardBreak → \n. paragraph wrapper → content only. Unknown nodes stripped + warn. Never emits \n\n. |
| p15-t4 | Serializer escape rules | frontend | | [ADR-20] [REVIEWED] \* for literal asterisk, \` for literal backtick. #[ without valid 26-char ULID passes through unescaped. |
| p15-t5 | Serializer test suite (Vitest) | testing | **YES** | [ADR-20] [REVIEWED] 110 tests, 100% coverage. Round-trip identity. Mark nesting (bold-in-italic, code adjacent to bold). Token at string boundaries. Unclosed mark revert. Known limitation: bold-inside-italic mark merging (REVIEW-LATER). |

### TipTap + Roving Instance

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p15-t6 | TipTap extension: tag_ref inline node | frontend | | [ADR-01, ADR-20] [REVIEWED] atom:true, inline:true. Attr: id (ULID). Renders chip from tags_cache. Never shows raw ULID. |
| p15-t7 | TipTap extension: block_link inline node | frontend | | [ADR-01, ADR-20] [REVIEWED] Same as tag_ref. Attr: id. Reads from pages_cache. Chip renders resolved page title. |
| p15-t8 | Roving TipTap instance — mount/unmount lifecycle | frontend | **YES** | [ADR-01] [REVIEWED] Exactly ONE instance at all times. Mount on focus (parse → setContent). Unmount on blur (serialize → compare → flush if dirty → clearHistory). Static div for all non-focused blocks. |
| p15-t9 | useBlockKeyboard hook | frontend | | [ADR-01] [REVIEWED] ArrowUp/Left at pos 0 → prev block. ArrowDown/Right at end → next block. Backspace on empty → delete+focus prev. Enter → \n. Tab → indent. Shift+Tab → dedent. |
| p15-t10 | Auto-split on blur | frontend | **YES** | [ADR-01] [REVIEWED] Serialized string contains \n → splitOnNewlines(). First segment: edit_block. Subsequent: create_block in order. Tags/props on first segment only. Same path as cross-block paste. |
| p15-t11 | # picker extension (tag autocomplete) | frontend | | [ADR-01] [REVIEWED] Intercept # keystroke → fuzzy search tags_cache. Select → insert tag_ref node with ULID. Never writes #tagname to storage. |
| p15-t12 | [[ picker extension (page/block link) | frontend | | [ADR-01] [REVIEWED] Intercept [[ → fuzzy search pages_cache. Select → insert block_link node with ULID. |
| p15-t13 | Viewport Intersection Observer | frontend | | [ADR-01] [REVIEWED] Off-screen blocks: static div with known height. Intersection Observer drives visible window. Zero per-block TipTap overhead for off-screen blocks. |

### Block CRUD UI

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p15-t14 | Block tree renderer (static) | frontend | | [ADR-01] [REVIEWED] Recursive render of block tree. Placeholder heights for unmeasured off-screen blocks. |
| p15-t15 | Block creation — Enter to create below | frontend | | [ADR-06] [REVIEWED] Calls create_block. Focuses new block immediately. |
| p15-t16 | Block deletion — Backspace on empty | frontend | | [ADR-06] [REVIEWED] Calls delete_block(cascade:true). Focus previous. Graceful on first block. |
| p15-t17 | Indent / dedent (Tab / Shift+Tab) | frontend | | [ADR-06] [REVIEWED] Flush first. Calls move_block. Emits batch move_block ops for position compaction. |
| p15-t18 | Flat tag panel | frontend | | [ADR-06] [REVIEWED] Apply/remove tags from a block. Reads tags_cache. Calls add_tag / remove_tag ops. |
| p15-t19 | Create tag block UI | frontend | | [ADR-06] [REVIEWED] Calls create_block(block_type:'tag'). Immediately available in tags_cache after materializer. |

### Journal View

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p15-t20 | Journal page — today's blocks | frontend | | [ADR-08] [REVIEWED] Query: agenda_cache WHERE date = today. Paginated. Reads from foreground materializer queue. |
| p15-t21 | Date navigation | frontend | | [ADR-08] [REVIEWED] Previous / next day. agenda_cache WHERE date BETWEEN ? AND ?. Skeleton on load (stale-while-revalidate). |
| p15-t22 | Page browser — all pages | frontend | | [ADR-06, ADR-08] [REVIEWED] WHERE block_type = 'page' AND deleted_at IS NULL. Default sort: reverse ULID (creation time desc). User pref settable. |

### Trash + Restore

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p15-t23 | Trash view | frontend | | [ADR-06] [REVIEWED] WHERE deleted_at IS NOT NULL AND is_conflict = 0. Paginated. Shows block content + deleted_at. |
| p15-t24 | Restore flow | frontend | | [ADR-06] [REVIEWED] Calls restore_block op. deleted_at_ref in payload. Only descendants with matching timestamp are restored. |
| p15-t25 | Permanent delete (purge) | frontend | | [ADR-06] [REVIEWED] Explicit UI confirm. Calls purge_block op. Irreversible. Also triggered auto after 30 days. |

### Android Spike — Gate Before Phase 2

| ID | Task | Tags | Critical | Status | Notes |
|----|------|------|----------|--------|-------|
| p15-t26 | Throwaway Tauri Android app | infra, testing | **YES** | Done | Built debug APK (154MB), installed and launched on Android 14 emulator (Pixel 6). Rust cross-compiled for x86_64-linux-android. Gradle + NDK 27 pipeline works. |
| p15-t27 | Validate: IME composition + virtual keyboard | testing | **YES** | Done | Virtual keyboard appears on input focus. Text input works. IME autocomplete suggestions show. Keyboard dismiss works. No layout breakage. |
| p15-t28 | Validate: Markdown round-trip under Android WebView | testing | **YES** | Partial | WebView renders React UI correctly. Read IPC (`list_blocks`) works. Write IPC (`create_block`) fails with runtime error — needs debugging but not a fundamental blocker. TipTap not yet integrated (Phase 2), so Markdown round-trip deferred. |
| p15-t29 | Spike decision — proceed or mitigate | infra | **YES** | Done | **PROCEED.** Core architecture proven: Rust backend init (SQLite + WAL + recovery) completes in 9ms on Android. WebView renders correctly. IPC bridge functional for reads. Write command failure is a debugging task, not architectural. |

#### Spike Details (2026-03-28)

- **Environment:** Android 14 (API 34), google_apis x86_64 emulator, NDK 27.0.12077973, JDK 17
- **Build time:** ~60s cold Rust cross-compile, ~30s Gradle first build
- **What works:** App launch, SQLite/WAL/device ID/crash recovery, WebView rendering, IME/keyboard, date navigation, list_blocks IPC
- **What needs work:** create_block IPC returns runtime error (likely materializer init or serialization issue), sidebar toggle on mobile, header icon overlap
- **Artifacts:** `src-tauri/gen/android/` (generated Android project), `src-tauri/target/x86_64-linux-android/` (cross-compiled binary)

---

## Phase 2 — Full Editor

**Estimate:** 8–12 weeks
**ADRs:** ADR-02, ADR-06, ADR-09, ADR-13

> Block links, history, move/merge, conflict UI. specta enters. E2E testing begins.

### specta + tauri-specta

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t1 | specta type export setup | dx, backend | | Done (Phase 1.5) | [ADR-11, ADR-13] specta + tauri-specta integrated. bindings.ts auto-generated. CI gate via ts_bindings_up_to_date test. |
| p2-t2 | Annotate all Tauri commands with specta | backend, dx | | Done (Phase 1.5) | [ADR-11, ADR-13] All 7 commands annotated. Types re-exported from bindings.ts into tauri.ts. |

### Block Links + Backlinks

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t3 | Backlinks panel — per-block | frontend | | Done | [ADR-06, ADR-08] Backend: list_backlinks query. Frontend: BacklinksPanel component with pagination. Commit `4c755bd`. |
| p2-t4 | [[link]] chip navigation | frontend | | Done | [ADR-01] BlockLink NodeView with click handler → onNavigate. BlockTree handleNavigate (flush → getBlock → load → focus). Commit `bca657c`. |
| p2-t5 | Broken link decoration | frontend | | Done | [ADR-01, ADR-06] resolveStatus callback → .block-link-deleted CSS class (opacity + strikethrough). Commit `bca657c`. |

### History Panel

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t6 | Per-block edit chain query | backend | | Done | [ADR-07] list_block_history query + HistoryEntry struct + get_block_history command. Commit `4c755bd`. |
| p2-t7 | History panel UI | frontend | | Done | [ADR-02, ADR-07] HistoryPanel component with op list, payload preview, restore action. Commit `4c755bd`. |
| p2-t8 | Non-text op history (tags, properties, moves) | frontend | | Done | [ADR-07] Included in HistoryPanel — shows all op types with getPayloadPreview. Commit `4c755bd`. |

### Move, Merge, Indent

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t9 | Drag-to-reorder blocks | frontend | | Done | [ADR-06] @dnd-kit/core+sortable, SortableBlock with GripVertical handle, reorder store action. Commit `3edc1a8`. |
| p2-t10 | Move block to different parent | frontend | | Done | [ADR-06] Indent/dedent via Tab/Shift+Tab already implemented in Phase 1.5. DnD extends this. Commit `3edc1a8`. |
| p2-t11 | Block merge (Backspace at start of non-empty block) | frontend | | Done | [ADR-06] onMergeWithPrev: concat content, delete current, focus prev. Commit `3edc1a8`. |

### Conflict Resolution UI

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t12 | Conflict copy display | frontend | | Done | [ADR-06, ADR-10] ConflictList component: list_conflicts query, paginated display. Commit `4c755bd`. |
| p2-t13 | Conflict resolution actions | frontend | | Done | [ADR-06, ADR-10] Keep (edit_block original + delete conflict) and Discard (delete conflict) actions in ConflictList. Commit `4c755bd`. |
| p2-t14 | 'Deleted tag' token decoration | frontend | | Done | [ADR-06] TagRef NodeView with resolveStatus → .tag-ref-deleted CSS class (opacity + strikethrough). Commit `bca657c`. |

### Status View

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t15 | In-memory status struct (Rust) | backend | | Done | [ADR-08] StatusInfo struct on Materializer (queue depths + op counters via atomic). get_status command. Commit `4c755bd`. |
| p2-t16 | Status panel UI | frontend | | Done | [ADR-08] StatusPanel component with 5s polling, card layout showing queue depths + op counts. Commit `4c755bd`. |
| p2-t17 | Property conflict audit list | backend, frontend | | Done | [ADR-08] Included as part of ConflictList (p2-t12/t13). Commit `4c755bd`. |

### E2E Testing

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p2-t18 | Playwright + tauri-driver setup | dx, testing | | Done | [ADR-13] Playwright config, CI integration, Chromium-only. 3 smoke tests. |
| p2-t19 | E2E: editor lifecycle (focus, edit, blur, flush) | testing | | Done | [ADR-13] 15 editor lifecycle tests (form CRUD, nav, persistence, edge cases). |
| p2-t20 | insta snapshot tests | testing, dx | | Done (Phase 1.5) | [ADR-13] 19 insta snapshots across all modules. Integrated into cargo-test prek hook. |

---

## Phase 3 — Search

**Estimate:** 3–4 weeks
**ADRs:** ADR-08, ADR-12, ADR-19

> FTS5, boolean tag queries, scheduled index maintenance. cargo-nextest enters. CJK limitations documented and explicit.

### FTS5 Integration

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p3-t1 | FTS5 virtual table definition | backend | | Done | [ADR-12] 0002_fts5.sql migration, unicode61 tokenizer, block_id UNINDEXED. |
| p3-t2 | FTS5 strip pass in materializer | backend | **YES** | Done | [ADR-12, ADR-20] fts.rs strip_for_fts: removes **, *, ` delimiters, resolves #[ULID] → tag name, [[ULID]] → page title. Batch variant for rebuild. |
| p3-t3 | FTS5 scheduled optimize | backend | | Done | [ADR-08, ADR-12] 500-edit/60-min threshold in materializer. FtsOptimize task variant. |
| p3-t4 | Full-text search Tauri command | backend | | Done | [ADR-12] search_blocks command, cursor-based pagination on (rank, rowid). |
| p3-t5 | Search UI — input + results | frontend | | Done | [ADR-12] SearchPanel with debounced input (300ms), cursor pagination, block type badges. |
| p3-t6 | CJK limitation notice in UI | frontend | | Done | [ADR-19] hasCJK() detects CJK codepoints, blue info banner when present. |

### Tag Queries

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p3-t7 | TagExpr tree + FxHashSet (Rust) | backend | | Done | [ADR-08] Boolean tag queries: AND, OR, NOT. FxHashSet for set operations on block_ids. LIKE for prefix queries. |
| p3-t8 | Prefix-aware tag search (#work/ → all sub-tags) | backend | | Done | [ADR-08, ADR-18] LIKE 'work/%' on tags_cache.name. No graph traversal. This is the org-mode use case (ADR-18). |
| p3-t9 | Tag filter panel in UI | frontend | | Done | [ADR-08] Combine multiple tag filters. AND/OR toggle. Results paginated. Reads tag query materializer. |

### Performance & Tooling

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p3-t10 | cargo-nextest migration | dx | | Done | [ADR-13] Suite is large enough now. nextest run. Parallel test execution, better output, instant rerun of failed tests. |
| p3-t11 | FTS5 perf benchmark | testing | | Done | [ADR-12] Seed DB with 10k / 100k blocks. Measure search latency. Verify segment count doesn't degrade after optimize. |
| p3-t12 | Materializer queue depth monitoring | dx, backend | | Done | [ADR-08] Log queue depths at high watermarks. Feeds Status View. Alert if background queue grows unbounded. |

---

## Phase 4 — Sync + Android

**Estimate:** 12–16 weeks
**ADRs:** ADR-09, ADR-10, ADR-07, ADR-02

> The most complex phase. DAG log, diffy merge, mDNS pairing, snapshot protocol, full Android. XState + TanStack Query enter.

### State Management Upgrade

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t1 | TanStack Query — server state layer | frontend, dx | | [ADR-02] Replace manual Tauri invoke + useState patterns. Invalidated by Tauri events. Enables stale-while-revalidate in frontend. |
| p4-t2 | XState — sync state machine only | frontend, backend | | Scope: sync lifecycle states only. Not the whole app. States: idle → discovering → pairing → streaming → merging → done \| error \| [ADR-02] reset_required. |

### DAG Op Log

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t3 | Multi-entry parent_seqs on merge ops | backend | **YES** | [ADR-07] Schema already supports this from Phase 1. Only write + read logic changes. Merge op parent_seqs = one entry per syncing device. |
| p4-t4 | LCA algorithm — per-block edit chain | backend | **YES** | [ADR-07] find_lca(op_a, op_b): walk prev_edit pointers. O(chain depth). Returns ancestor text_at(). No graph library needed. |
| p4-t5 | text_at() helper | backend | | [ADR-07] op_type='edit_block' → payload.to_text. op_type='create_block' → payload.content. Edge: no prior edit → create_block content. |

### diffy Integration

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t6 | diffy::merge() integration | backend | **YES** | [ADR-10] Call: diffy::merge(ancestor_text, ours, theirs). Ok(String) → new edit_block op. Err(MergeConflict) → conflict copy path. |
| p4-t7 | Conflict copy creation on merge failure | backend | | [ADR-06, ADR-10] New block: is_conflict=1, conflict_source=original_block_id, content=conflicting version. Original retains ancestor content. |
| p4-t8 | Property conflict LWW resolution | backend | | [ADR-10] Concurrent set_property for same (block_id, key): last-writer-wins on created_at, device_id as tiebreaker. Log to audit list. |
| p4-t9 | diffy integration tests | testing | **YES** | [ADR-10] Test: clean merge (non-overlapping edits), conflict (overlapping), ULID token handling, Markdown mark boundaries. |

### mDNS Discovery + Pairing

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t10 | mDNS peer discovery | backend | | [ADR-09] Local network only. Announce on launch, scan for peers. Tauri event on discovery. |
| p4-t11 | 4-word EFF passphrase generation | backend | | [ADR-09] ~51 bits entropy. Ephemeral — discarded after pairing or 5-minute timeout. Host generates per session. |
| p4-t12 | QR code display (passphrase + host address) | frontend | | [ADR-09] Both QR and 4-word text paths derive identical session keys. QR: encode passphrase + address. |
| p4-t13 | tokio-tungstenite + rustls transport | backend | | [ADR-09, ADR-11] WebSocket over TLS. Session key derived from passphrase. No persistent shared key. |

### Sync Protocol

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t14 | Head exchange + divergence walk | backend | **YES** | [ADR-09] Exchange latest (device_id, seq, hash) per device. Walk parent_seqs DAG to find common ancestor. Determine diverging ops. |
| p4-t15 | Op streaming (sender + receiver) | backend | | [ADR-09] Stream diverging ops. Receiver: INSERT OR IGNORE on composite PK — duplicate delivery is idempotent. |
| p4-t16 | RESET_REQUIRED detection + protocol | backend | **YES** | [ADR-09] Peer's last known op predates oldest retained op AND no snapshot covers it → RESET_REQUIRED. Never silent — explicit user confirm. |
| p4-t17 | peer_refs maintenance (atomic) | backend | | [ADR-09] last_hash, last_sent_hash, synced_at updated atomically at end of successful sync only. Failure = no update = safe restart. |
| p4-t18 | Sync UI — pairing, progress, conflicts | frontend | | [ADR-09] XState machine drives UI states. RESET_REQUIRED: explicit confirm dialog. Never a silent replace. |

### Snapshot + Compaction

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t19 | zstd + ciborium snapshot encoding | backend | | [ADR-07, ADR-11] CBOR document: schema_version, snapshot_device_id, up_to_seqs frontier, all core table rows. No cache tables. |
| p4-t20 | Snapshot write sequence (crash-safe) | backend | **YES** | [ADR-07] 1) INSERT status='pending'. 2) Compress+write data. 3) UPDATE status='complete'. Boot cleanup deletes pending rows. |
| p4-t21 | Snapshot apply (RESET path) | backend | | [ADR-07] Wipe core tables. Decode CBOR. Insert rows. Replay tail ops. Trigger background cache rebuilds + FTS5 optimize. |
| p4-t22 | 90-day op log compaction scheduler | backend | | [ADR-07] Background task. Runs when op_log rows older than 90 days exist. Produces log_snapshot. Purges old ops after snapshot status='complete'. |

### Full Android

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p4-t23 | Full Android build pipeline | infra | | [ADR-01] Tauri 2.0 Android target. CI: cross-compile Rust, APK build. Not throwaway spike — production target. |
| p4-t24 | Android layout: virtual keyboard + safe areas | frontend | | [ADR-01, ADR-03] WindowInsets. Keyboard avoid. Tailwind rtl: variants active. Noto Sans rendering validated. |
| p4-t25 | Android: mDNS + sync UI | frontend | | [ADR-01, ADR-09] Same sync flow as Linux. QR scan for pairing on Android. Platform-specific camera permission. |

---

## Phase 5 — Polish

**Estimate:** 6–8 weeks
**ADRs:** ADR-12, ADR-17, ADR-19, ADR-20

> i18n, CJK search, export, auto-updates, graph view. The difference between a great tool and a shipped product.

### i18n

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p5-t1 | i18n framework selection + string extraction | frontend, dx | | [ADR-03] Extract all UI strings. RTL layout: Tailwind rtl: variants already prepared. Noto Sans covers CJK + Arabic. |
| p5-t2 | RTL layout validation | frontend, testing | | [ADR-03] Block tree, pickers, journal, history panel. rtl: Tailwind variants. Noto Sans rendering on Android confirmed. |

### CJK Search — Tantivy + lindera

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p5-t3 | Tantivy index — disk, alongside SQLite | backend | | [ADR-12, ADR-19] Background materializer queue maintains Tantivy. Source of truth = op log + blocks. Tantivy is derived. |
| p5-t4 | lindera integration (Japanese, Chinese, Korean) | backend | | [ADR-12, ADR-19] Tokenization example: 会議室 → ['会議', '室']. IPAdic + CC-CEDICT as priority. IPADIC-NEologd optional/off by default. |
| p5-t5 | Optional dictionary download flow | frontend | | [ADR-19] First CJK search → 'Better search available. Download ~18MB?' Stored in app-private storage. Non-blocking. |
| p5-t6 | FTS5 + Tantivy parallel index window | backend | | [ADR-12, ADR-19] Both maintained during transition. FTS5 for non-CJK. Tantivy for CJK queries once dictionary available. |

### Export

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p5-t7 | Export serializer — ULID → human names | backend | | [ADR-20] #[ULID] → #tagname (tags_cache). [[ULID]] → [[Page Title]] (pages_cache). Output: standard Markdown + Obsidian wikilinks. |
| p5-t8 | Export UI — per-page and full vault | frontend | | [ADR-20] File picker for destination. Progress indicator. Lossy by design — documented. Round-trip import deferred. |
| p5-t9 | Frontmatter YAML for properties | backend | | [ADR-20] block_properties → frontmatter on export. value_date, value_text, value_num, value_ref (as page title). |

### Auto-updates

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p5-t10 | Tauri updater setup | infra | | GitHub Releases as update server. Sign binaries. Linux: AppImage or .deb. Android: sideload or F-Droid track. |

### Graph View

| ID | Task | Tags | Critical | Notes |
|----|------|------|----------|-------|
| p5-t11 | Graph data query | backend | | [ADR-17] block_links JOIN blocks. Tag relationships via block_tags. Data already in schema — this is visualisation only. |
| p5-t12 | react-force-graph on WebGL canvas | frontend | | [ADR-17] ADR-17: D3 and Cytoscape rejected. react-force-graph chosen if graph view is built. Deferred to Phase 5. |

---

## Stack by Phase

### Day One / Phase 1
| Dep | Side | Notes |
|-----|------|-------|
| Tauri 2.0 | infra | Shell + IPC. Android target proven in spike. |
| React 18 + Vite | frontend | Fast HMR. Strict TS from day one. |
| Biome | dx | Replaces ESLint + Prettier. Non-negotiable day one. |
| sqlx + sqlx-cli | backend | Async SQLite, compile-time query macros, migrations. |
| thiserror + anyhow | backend | Typed errors + ergonomic propagation. |
| blake3 | backend | Op log hash chaining. |
| FxHashMap | backend | Hot-path hash maps. FxHashSet for tag queries. |
| Zustand | frontend | Boot + editor state enums only. Minimal. |
| shadcn/ui + Tailwind | frontend | Copy-paste, owned, no lock-in. Noto Sans bundled. |
| Vitest | dx | Frontend unit tests. Serializer test suite lives here. |
| GitHub Actions + tauri-action | infra | CI before features. |

### Phase 1.5
| Dep | Side | Notes |
|-----|------|-------|
| TipTap 2 | frontend | ProseMirror wrapper. Single roving instance. |
| markdown-serializer.ts (custom) | frontend | Own code. No tiptap-markdown. ~150 lines. |

### Phase 2
| Dep | Side | Notes |
|-----|------|-------|
| specta + tauri-specta | dx | TypeScript type generation from Tauri commands. |
| Playwright + tauri-driver | dx | E2E tests. |
| insta | dx | Snapshot tests once schema is stable. |

### Phase 3
| Dep | Side | Notes |
|-----|------|-------|
| cargo-nextest | dx | Suite large enough to feel slow. Parallel execution. |

### Phase 4
| Dep | Side | Notes |
|-----|------|-------|
| diffy | backend | Word-level three-way merge. |
| zstd | backend | Snapshot compression. |
| ciborium | backend | CBOR for snapshot encoding. |
| tokio-tungstenite + rustls | backend | Sync transport. |
| TanStack Query | frontend | Server state, invalidated by Tauri events. |
| XState (sync machine only) | frontend | Scope: sync state machine. Not the whole app. |

### Phase 5
| Dep | Side | Notes |
|-----|------|-------|
| Tantivy | backend | CJK full-text search. FTS5 retained in parallel. |
| lindera | backend | Morphological analyser. Dictionaries are optional downloads. |
| react-force-graph | frontend | Graph view. WebGL canvas. |
