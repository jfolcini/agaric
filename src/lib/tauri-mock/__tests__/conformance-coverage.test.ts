/**
 * #3083 — behavioral conformance-coverage ratchet (anti-drift).
 *
 * `handlers-drift.test.ts` guards command-NAME coverage: every command in
 * `bindings.ts` has a mock handler. That is necessary but NOT sufficient — a
 * handler can exist and still silently diverge from the real Rust backend
 * (create_block page_id, purge_block cascade, reserved-key property routing,
 * the tag-space bug all shipped past a name-only check). BEHAVIORAL parity is
 * enforced by the #763 conformance harness: `conformance/fixtures/*.json`
 * replay op sequences against a backend-authored `expected`, asserted by BOTH
 * `src-tauri/src/command_integration_tests/conformance.rs` (real backend) and
 * `./conformance.test.ts` (mock).
 *
 * This file is the RATCHET on top of that harness. It fails when:
 *
 *   1. a state-MUTATING IPC command has NEITHER a conformance fixture that
 *      drives it NOR a justified allowlist waiver — so a new mutating command
 *      cannot land without a fixture or an explicit, reasoned exemption;
 *   2. a READ-ONLY IPC command has NEITHER a conformance QUERY step that drives
 *      it NOR a justified waiver (#3347 — see `READ_NO_QUERY_ALLOWLIST`); and
 *   3. a required (op, scenario) tuple from the manifest below is not pinned by
 *      any fixture — so the specific behaviors we care about (the recent escape
 *      classes) stay covered as fixtures land.
 *
 * Neither check re-runs the replay (that is `conformance.test.ts`'s job); this
 * file only asserts that the coverage SURFACE has not regressed.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Command extraction (mirrors handlers-drift.test.ts)
// ---------------------------------------------------------------------------

const BINDINGS_PATH = path.resolve(import.meta.dirname, '..', '..', 'bindings.ts')

/** Every Tauri command name literal in the auto-generated `bindings.ts`. */
function extractBindingsCommandNames(): string[] {
  const source = readFileSync(BINDINGS_PATH, 'utf8')
  const re = /__TAURI_INVOKE\("([a-z][a-z0-9_]*)"/g
  const names = new Set<string>()
  for (const match of source.matchAll(re)) {
    names.add(match[1] as string)
  }
  return [...names].toSorted()
}

const RUST_COMMANDS_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'src-tauri',
  'src',
)

/**
 * Every `#[tauri::command]` function in the Rust tree, mapped to its literal
 * argument list. Used to classify by EVIDENCE (does it take a write handle?)
 * rather than by the verb in its name (#3332).
 */
function extractRustCommandSignatures(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.rs')) {
        const source = readFileSync(full, 'utf8')
        // `#[tauri::command…]`, any further attributes (`#[instrument…]`), then
        // the fn header. The arg list is balance-scanned so nested generics /
        // tuples in a parameter type cannot truncate it.
        const re =
          /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*pub\s+(?:async\s+)?fn\s+(\w+)\s*\(/g
        for (const m of source.matchAll(re)) {
          let depth = 0
          let i = (m.index ?? 0) + m[0].length - 1
          const start = i
          for (; i < source.length; i++) {
            const ch = source[i]
            if (ch === '(') depth++
            else if (ch === ')') {
              depth--
              if (depth === 0) break
            }
          }
          out.set(m[1] as string, source.slice(start, i + 1))
        }
      }
    }
  }
  walk(RUST_COMMANDS_DIR)
  return out
}

/**
 * A Rust command MUTATES when its signature takes a write handle. `WritePool`
 * is bound without `PRAGMA query_only`, so taking it is the backend's own
 * statement that the command can write; `WriteCtx` wraps it.
 */
function takesWriteHandle(signature: string): boolean {
  return signature.includes('WritePool') || signature.includes('WriteCtx')
}

// ---------------------------------------------------------------------------
// Read-only classifier
// ---------------------------------------------------------------------------

/**
 * A command is READ-ONLY (has no backend-observable persistent effect) when its
 * name begins with one of these query verbs. Everything NOT matched here is a
 * MUTATING candidate and must be covered by a fixture or allowlisted below —
 * so a new command with a mutating-shaped name is caught automatically.
 *
 * #3347 — read-only is NO LONGER an exemption from the coverage requirement. It
 * used to be: a read command needed neither a fixture nor a waiver, so the
 * `list_` / `search_` / `query_` surface the UI renders from had zero
 * differential coverage and the mock could answer it however it liked. A
 * read-only command now needs a conformance QUERY step or an entry in
 * `READ_NO_QUERY_ALLOWLIST`. The classification still decides WHICH requirement
 * applies (op fixture vs query step), not whether one applies at all.
 *
 * The verb is a HEURISTIC, not evidence. `it('the read-only classifier agrees
 * with the Rust signatures', …)` below cross-checks every name classified here
 * against whether the Rust command actually takes a write handle, so a
 * `fetch_and_cache_*` / `load_or_create_*` / `resolve_and_pin_*` cannot slip
 * through on its prefix alone (#3332).
 *
 * `'fetch_'` used to sit in this list. Its only member, `fetch_link_metadata`,
 * takes `State<'_, WritePool>` and upserts into the link-metadata cache — it
 * was exempt from BOTH the fixture requirement and the honesty audit purely
 * because of its verb. It is now a mutating candidate carrying an explicit
 * waiver in `NO_FIXTURE_ALLOWLIST`.
 */
const READ_ONLY_PREFIXES: readonly string[] = [
  'get_',
  'list_',
  'query_',
  'search_',
  'count_',
  'read_',
  'find_',
  'compute_',
  'resolve_',
  'load_',
  'is_',
  'collect_',
  'export_',
]

/** Read-only commands whose names don't carry a query-verb prefix. */
const READ_ONLY_EXACT: ReadonlySet<string> = new Set<string>([
  'batch_resolve',
  'first_child_for_blocks',
  'trash_descendant_counts',
  'filtered_blocks_query',
  'run_advanced_query',
])

function isReadOnly(command: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => command.startsWith(p)) || READ_ONLY_EXACT.has(command)
}

/**
 * #3332 — commands that DO take a Rust write handle yet stay classified
 * read-only, because the only thing they write is a DERIVED cache the
 * conformance snapshot does not model. Each needs an explicit, reasoned entry:
 * the classifier cross-check below fails on any other write-handle-taking
 * command that a read-only verb would otherwise have waved through.
 */
const READ_ONLY_CACHE_WRITERS: Readonly<Record<string, string>> = {
  list_page_links:
    'lazy `page_link_cache` rebuild on the write pool (list_page_links_inner_split); ' +
    'the cache is derived from block_links and is outside the conformance snapshot scope',
}

// ---------------------------------------------------------------------------
// Allowlist — mutating commands NOT (yet) driven by a conformance fixture
// ---------------------------------------------------------------------------

/**
 * Each entry is a mutating command with a justified reason it needs no
 * conformance fixture of its own. Categories:
 *
 *   - `batch of <op>`      — a bulk variant whose per-item logic IS the single
 *                            op already pinned by a fixture (named in the reason).
 *   - `covered by <test>`  — behavior pinned by a dedicated mock unit test.
 *   - `NOT cross-checked; regression-guarded by <test>` — the ONLY assertions
 *     on this command's behaviour are mock-internal unit tests with
 *     hand-written expectations. Nothing compares them against the Rust
 *     backend, so this is a regression guard, NOT parity evidence. #3331 is
 *     why the category exists: the mock's whole `delete_block` reversal
 *     restored the target row alone while the backend restored the entire
 *     cohort, and every time-travel command sat behind a `covered by
 *     revert.test.ts` waiver that read like coverage.
 *   - `<X> outside the conformance snapshot scope` — mutates state (drafts,
 *     attachments, spaces, aliases, peers, property_definitions) that the
 *     blocks/properties/tags/op_log snapshot in `conformance-snapshot.ts` does
 *     not model. A future snapshot extension would move these to fixtures.
 *   - `no persistent state` — telemetry / notifications / runtime toggles.
 *
 * ADDING A COMMAND HERE IS A WAIVER, not a free pass: prefer a fixture. The
 * `it('allowlist stays honest', …)` test below fails if an allowlisted command
 * later gains a fixture (delete the redundant entry) or leaves `bindings.ts`.
 */
const NO_FIXTURE_ALLOWLIST: Readonly<Record<string, string>> = {
  // ── Batch / bulk variants (per-item logic pinned by the single-op fixture) ──
  add_tags_by_ids: 'batch of add_tag (tag_add_remove.json)',
  create_blocks_batch: 'batch of create_block (block_crud_basic.json)',
  delete_blocks_by_ids: 'batch of delete_block (cascade_delete_subtree.json)',
  move_blocks_batch: 'batch of move_block (move_multilevel_subtree.json)',
  purge_blocks_by_ids: 'batch of purge_block (purge_block.json)',
  restore_blocks_by_ids: 'batch of restore_block (restore_block.json)',
  set_property_batch: 'batch of set_property; covered by set-property-batch.test.ts',
  set_todo_state_batch: 'batch of set_todo_state (agenda_basic.json)',
  purge_all_deleted: 'iterates purge_block over all tombstones (purge_block.json)',
  restore_all_deleted: 'iterates restore_block over all tombstones (restore_block.json)',

  // ── Undo / redo / revert / op-log time-travel (op-log rewrite) ──
  // #3331 — the whole time-travel surface is UNCROSS-CHECKED: the Rust
  // conformance runner replays raw `OpPayload`s, so no fixture can drive an
  // undo/revert command, and the mock unit tests below hand-write their own
  // expectations. Reading these as coverage is what let the cohort divergence
  // ship. Keep the wording honest until a fixture can drive a reversal.
  undo_op: 'NOT cross-checked; regression-guarded by revert-cohort.test.ts / undo-op-refs.test.ts',
  undo_ops: 'NOT cross-checked; regression-guarded by revert.test.ts / undo-op-refs.test.ts',
  undo_page_op:
    'NOT cross-checked; regression-guarded by revert-cohort.test.ts / undo-move.test.ts',
  undo_page_group: 'NOT cross-checked; regression-guarded by undo-op-refs.test.ts',
  redo_page_op: 'NOT cross-checked; regression-guarded by undo-move.test.ts',
  revert_ops: 'NOT cross-checked; regression-guarded by revert-cohort.test.ts / revert.test.ts',
  restore_page_to_op: 'NOT cross-checked; regression-guarded by revert.test.ts',
  compact_op_log_cmd: 'op-log maintenance; rewrites history, not blocks/props/tags',

  // ── Draft staging (drafts table, outside the conformance snapshot scope) ──
  save_draft: 'draft staging table outside the conformance snapshot scope',
  delete_draft: 'draft staging table outside the conformance snapshot scope',
  flush_draft: 'draft staging table outside the conformance snapshot scope',
  flush_all_drafts: 'draft staging table outside the conformance snapshot scope',

  // ── Attachments (blob store, outside the conformance snapshot scope) ──
  add_attachment_with_bytes: 'attachments blob store outside the conformance snapshot scope',
  delete_attachment: 'attachments blob store outside the conformance snapshot scope',
  rename_attachment: 'attachments blob store outside the conformance snapshot scope',

  // ── Pages / spaces / property definitions ──
  create_page_in_space:
    'a page is a root block (create_block); space scoping outside snapshot scope',
  create_space: 'space registry outside the single-space conformance snapshot scope',
  move_blocks_to_space: 'cross-space move outside the single-space conformance snapshot scope',
  set_page_aliases: 'page-alias table outside the conformance snapshot scope',
  create_property_def: 'property_definitions registry (app-layer), not projected block state',
  delete_property_def: 'property_definitions registry (app-layer), not projected block state',
  update_property_def_options:
    'property_definitions registry (app-layer), not projected block state',

  // ── Link metadata cache (#3332) ──
  // Classified read-only by its `fetch_` verb until #3332; it takes
  // `State<'_, WritePool>` and `fetch_link_metadata_inner` upserts into the
  // cache on a stale/miss.
  fetch_link_metadata: 'link_metadata cache is outside the conformance snapshot scope',

  // ── Import / quick capture (composes covered create/edit ops) ──
  import_bibliography: 'covered by import-bibliography.test.ts',
  import_markdown:
    'composes create_block/edit_block (block_crud_basic.json); parsing covered by e2e',
  quick_capture_block: 'composes create_block into the daily journal (block_crud_basic.json)',

  // ── Sync / pairing / peer registry (transient transport / device metadata) ──
  start_sync: 'sync transport session; no durable domain state to snapshot',
  cancel_sync: 'sync transport session; no durable domain state to snapshot',
  start_pairing: 'pairing transport session; no durable domain state to snapshot',
  confirm_pairing: 'pairing transport session; no durable domain state to snapshot',
  // #3493 — cancel now deletes the pending-pairing marker (an `app_settings`
  // row), so this is no longer "no durable state". It stays excluded for the
  // same reason `confirm_pairing` (which writes that row) is: the marker is
  // pairing-window plumbing, not projected block state.
  cancel_pairing: 'pending-pairing marker (app_settings), not projected block state',
  set_peer_address: 'peer registry (device metadata) outside the conformance snapshot scope',
  update_peer_name: 'peer registry (device metadata) outside the conformance snapshot scope',
  delete_peer_ref: 'peer registry (device metadata) outside the conformance snapshot scope',

  // ── Observability / runtime toggles (no persistent domain state) ──
  log_frontend: 'no persistent state — forwards a frontend log line',
  ingest_otel_spans: 'no persistent state — telemetry export',
  set_trace_sampling: 'no persistent state — runtime tracing toggle',
  notify_task: 'no persistent state — OS notification side effect',
  mcp_set_enabled: 'no persistent domain state — MCP server runtime toggle',
  mcp_rw_set_enabled: 'no persistent domain state — MCP server runtime toggle',
  mcp_disconnect_all: 'no persistent domain state — MCP transport reset',
  mcp_rw_disconnect_all: 'no persistent domain state — MCP transport reset',
}

// ---------------------------------------------------------------------------
// Allowlist — read-only commands NOT (yet) driven by a conformance query step
// ---------------------------------------------------------------------------

/**
 * #3347 — each entry is a READ-ONLY command with a justified reason it carries
 * no conformance query step yet. The categories are deliberately narrower than
 * the mutating allowlist's, because "it only reads" is never itself a reason:
 * a read command IS the surface the UI renders, so a mock that answers it
 * differently from the backend is exactly the failure #3347 exists to catch.
 *
 *   - `fixture candidate: <why not yet>` — nothing structural blocks a query
 *     step; it simply is not written. This is the honest majority. Every entry
 *     in this category is a to-do, not a verdict.
 *   - `<X> outside the conformance snapshot scope` — reads state the fixture
 *     seed cannot express (attachments, drafts, aliases, spaces, peers,
 *     property_definitions, link metadata).
 *   - `<return shape>` — the response carries no row identity the query
 *     projection can bind: a bare scalar, a rendered string, a keyed count
 *     map, or a multi-partition envelope. `conformance-query.ts` projects one
 *     `rows` list of canonical block tokens plus one `has_more`/`total_count`
 *     pair, so these need a projection EXTENSION, not just a fixture step —
 *     which is why they are NOT "fixture candidate"s.
 *   - `<arg not fixture-expressible>` — the command is selected by a
 *     coordinate the two stacks generate independently (an `op_log`
 *     `(device_id, seq)` point), so no fixture can name the same input on
 *     both sides.
 *   - `wall-clock / environment dependent` — the answer is not a function of
 *     the seeded state, so no recorded expectation can bind it.
 *   - `no domain state` — process/runtime/telemetry status reads.
 *
 * A reason must name the ACTUAL blocker. A plausible-but-wrong one is worse
 * than none: it forecloses the question with a wrong answer, and the next
 * reader takes it at face value. Both journal lookups sat here behind "derived
 * from the wall-clock date" until someone opened `journal.rs` and found
 * `WHERE content = ?date` — an explicit argument, trivially seedable. They are
 * now query steps in `query_journal_pages.json`.
 *
 * ADDING A COMMAND HERE IS A WAIVER, not a free pass: prefer a query step. The
 * `it('read allowlist stays honest', …)` test below fails if an allowlisted
 * command later gains a query step, stops being read-only, or leaves
 * `bindings.ts`.
 */
const READ_NO_QUERY_ALLOWLIST: Readonly<Record<string, string>> = {
  // ── Point reads over blocks / properties / tags ──
  //
  // #3826 CLOSED this group. Eleven commands (`batch_resolve`,
  // `first_child_for_blocks`, `get_block`, `get_blocks`, `get_batch_properties`,
  // `get_properties`, `get_property`, `list_blocks`, `list_tags_for_block`,
  // `list_inherited_tags_for_block`, `load_page_subtree`) were waived here as
  // "point reads over rows the #763 snapshot already diffs". True, and not a
  // reason to skip them: the snapshot diffs the ROWS, never each command's own
  // projection, pagination and filtering of them. They are now driven by the
  // `query_point_reads_*`, `query_list_blocks_pagination`,
  // `query_inherited_tags` and `query_batch_properties_empty_entry` fixtures,
  // and the residual turned out to hold three real divergences (#3870, #3871,
  // #3872) that the waiver had been quietly covering for.

  // ── Legacy tag / property query surface ──
  query_by_property: 'fixture candidate: superseded by filtered_blocks_query, still IPC-reachable',
  query_by_tags: 'fixture candidate: superseded by filtered_blocks_query, still IPC-reachable',
  query_by_tag_expr: 'fixture candidate: tag-expression surface with no query step yet',
  list_all_tags_in_space: 'fixture candidate: tags_cache-backed listing with no query step yet',
  list_tags_by_prefix: 'fixture candidate: tags_cache prefix scan with no query step yet',
  list_property_keys: 'fixture candidate: distinct-key scan with no query step yet',
  list_property_values: 'fixture candidate: distinct-value scan with no query step yet',

  // ── Links / backlinks ──
  // The EDGES are pinned twice (the snapshot's `page_links`, and the
  // `list_page_links` query step); these commands' grouping, filtering and
  // counting on top of them are not.
  get_backlinks: 'fixture candidate: grouping/pagination over edges the snapshot already pins',
  query_backlinks_filtered: 'fixture candidate: filtered backlinks over already-pinned edges',
  count_backlinks_batch:
    'returns `HashMap<page_id, count>` — a keyed count map, not the canonical ' +
    'block-id rows the query projection binds',
  list_backlinks_grouped: 'fixture candidate: grouped backlinks over already-pinned edges',
  list_unlinked_references: 'fixture candidate: content scan over already-pinned block content',
  // The envelope IS the uncovered part — "same FTS scan" is an argument FOR
  // covering it, not a waiver. The real blocker is the return shape: this
  // command answers with TWO independently-capped page envelopes
  // (`{ pages, blocks }`), while the query projection carries a single `rows`
  // list and a single `has_more`/`total_count` pair.
  search_blocks_partitioned:
    'two-partition `{pages, blocks}` return shape; one projection row-list cannot ' +
    'hold both partitions — needs a partition-qualified row token in both runners',

  // ── Pages / journal / templates ──
  list_all_pages_in_space: 'fixture candidate: unpaginated twin of list_pages_with_metadata',
  list_template_page_ids_in_space: 'fixture candidate: template-property scan with no step yet',
  // `get_journal_page_by_date` / `list_journal_pages_in_range` are NOT waived:
  // they are query steps in `query_journal_pages.json`.
  //
  // Only `list_projected_agenda` is wall-clock dependent — its `_inner` takes
  // `chrono::Local::now().date_naive()` and threads it through the recurrence
  // projection. The two `count_agenda_*` commands are plain `agenda_cache`
  // lookups keyed by their EXPLICIT `dates` argument (agenda.rs
  // `count_agenda_batch_inner`); no clock is involved, and the real blocker is
  // the shape they answer with.
  count_agenda_batch:
    'returns `HashMap<date, count>` — a keyed count map with no row identity the ' +
    'query projection can bind (NOT wall-clock: the `dates` arg is explicit)',
  count_agenda_batch_by_source:
    'returns nested `HashMap<date, HashMap<source, count>>` — a keyed count map with ' +
    'no row identity the query projection can bind (NOT wall-clock: `dates` is explicit)',
  list_projected_agenda:
    'wall-clock dependent: `list_projected_agenda_inner` anchors the `.+` / `++` ' +
    'recurrence projection (and the cache-freshness horizon) to `chrono::Local::now()`',

  // ── Trash ──
  count_trash: 'returns a bare `i64`; the query projection has no row identity to bind it to',
  list_trash: 'fixture candidate: tombstone listing over rows the #763 snapshot already diffs',
  trash_descendant_counts:
    'returns `HashMap<root_id, count>` — a keyed count map, not the canonical ' +
    'block-id rows the query projection binds',

  // ── Op log / history / time travel ──
  // The Rust runner replays raw `OpPayload`s and normalises the op log to a
  // digest, so no recorded expectation can bind a history command's per-entry
  // shape (ids, timestamps, device). Same structural blocker as the mutating
  // undo/redo waivers above.
  get_block_history: 'op-log entries are digested (not compared per entry) by the #763 snapshot',
  list_page_history: 'op-log entries are digested (not compared per entry) by the #763 snapshot',
  find_undo_group: 'op-log entries are digested (not compared per entry) by the #763 snapshot',
  get_compaction_status: 'op-log maintenance counters, not projected block state',
  // Not "pure text diffs": both SELECT their input by an op-log coordinate the
  // two stacks generate independently, so a fixture cannot name the same op on
  // both sides. The text they diff is indeed snapshot-pinned; the ARG that
  // picks it is not.
  compute_edit_diff:
    'selected by an `op_log` `(device_id, seq)` point (history.rs) — an op identity ' +
    'each stack generates independently, so no fixture can spell the same input twice',
  compute_block_vs_current_diff:
    'selected by an `op_log` `(historical_created_at, historical_seq)` point — an op ' +
    'coordinate each stack generates independently, not fixture-expressible',
  export_page_markdown:
    'returns a rendered markdown `String`; the query projection binds canonical ' +
    'block-id rows, so it has nothing to compare',

  // ── Registries outside the conformance snapshot scope ──
  get_page_aliases: 'page-alias table outside the conformance snapshot scope',
  list_page_aliases_by_prefix: 'page-alias table outside the conformance snapshot scope',
  resolve_page_by_alias: 'page-alias table outside the conformance snapshot scope',
  list_spaces: 'space registry outside the single-space conformance snapshot scope',
  get_property_def: 'property_definitions registry (app-layer), not projected block state',
  list_property_defs: 'property_definitions registry (app-layer), not projected block state',
  get_link_metadata: 'link_metadata cache outside the conformance snapshot scope',
  list_attachments: 'attachments blob store outside the conformance snapshot scope',
  list_attachments_batch: 'attachments blob store outside the conformance snapshot scope',
  read_attachment_meta: 'attachments blob store outside the conformance snapshot scope',
  list_drafts: 'draft staging table outside the conformance snapshot scope',
  get_peer_ref: 'peer registry (device metadata) outside the conformance snapshot scope',
  list_peer_refs: 'peer registry (device metadata) outside the conformance snapshot scope',

  // ── Process / environment / telemetry status (no domain state) ──
  collect_bug_report_metadata: 'no domain state — host + build metadata',
  read_logs_for_report: 'no domain state — reads the on-disk log files',
  get_device_id: 'no domain state — this install’s device identity',
  get_status: 'no domain state — sync transport status',
  get_recovery_status: 'no domain state — boot recovery status',
  get_mdns_status: 'no domain state — mDNS discovery status',
  get_bind_exposure_status: 'no domain state — sync endpoint bind exposure',
  is_flatpak: 'no domain state — packaging/environment probe',
  get_mcp_status: 'no domain state — MCP server runtime status',
  get_mcp_rw_status: 'no domain state — MCP server runtime status',
  get_mcp_socket_path: 'no domain state — MCP transport path',
  get_mcp_rw_socket_path: 'no domain state — MCP transport path',
  get_mcp_recent_activity: 'no domain state — in-memory MCP activity ring buffer',
}

// ---------------------------------------------------------------------------
// Allowlist — BRANCHES of a read-only command NOT (yet) driven by a query step
// ---------------------------------------------------------------------------

/**
 * #3878 — the branch-grained sibling of `READ_NO_QUERY_ALLOWLIST`. A command
 * can be READ_NO_QUERY_ALLOWLIST-waived wholesale (no query step of any kind),
 * or — for a command in `QUERY_STEP_BRANCH_DISCRIMINATORS` — have SOME
 * branches covered and others not. This is the narrower waiver `#3878`'s
 * options list called out as reusing the existing mechanism at finer
 * granularity: an uncovered arm must be NAMED with a reason, the way an
 * uncovered command already is.
 *
 * Keys are `${command}::${branch}` units from `branchUnitsOf`. A command-level
 * `READ_NO_QUERY_ALLOWLIST` waiver still exempts ALL of that command's
 * branches (checked below) — this list is only for a command that is
 * PARTIALLY covered.
 */
const READ_QUERY_BRANCH_ALLOWLIST: Readonly<Record<string, string>> = {
  // `list_blocks`'s two agenda arms (#3878, found while fixing #3877's review
  // notes). Not a structural blocker on the query SIDE — `list_blocks_inner`
  // takes explicit `agenda_date` / `agenda_date_start`+`agenda_date_end`
  // arguments, so those are trivially seedable as ARGS. The blocker is the
  // DATA those arms read: both go through `pagination::list_agenda[_range]`,
  // which reads the `agenda_cache` table, not `blocks` directly. A fixture
  // `seed` only inserts into `blocks`/`properties`/`tags` — populating
  // `agenda_cache` needs `set_due_date` / `set_scheduled_date` OPS run first,
  // i.e. an ops-then-query fixture shape no existing `query_*` fixture uses
  // yet. Tracked as a follow-up; see the PR/issue this waiver shipped with.
  'list_blocks::agenda-range':
    'agenda_cache rows require set_due_date/set_scheduled_date OPS before the ' +
    'query step, not just a seed — no query_*.json fixture does that yet (#3878)',
  'list_blocks::agenda-date':
    'agenda_cache rows require set_due_date/set_scheduled_date OPS before the ' +
    'query step, not just a seed — no query_*.json fixture does that yet (#3878)',
}

// ---------------------------------------------------------------------------
// Commands whose query steps run on the BACKEND leg only (#3826)
// ---------------------------------------------------------------------------

/**
 * A fixture whose query leg is skipped in `conformance.test.ts` (either whole-
 * fixture via `DRIFT_SKIP` or query-leg-only via `QUERY_DRIFT_SKIP`) still runs
 * against the real backend (the Rust runner has no skip list) but is NOT
 * asserted against the mock. So a read command whose ONLY query steps live in
 * skipped fixtures is pinned on one stack, not diffed across two — which is
 * exactly the shape the #3331 lesson warns about: a waiver that reads like
 * coverage.
 *
 * Each entry names the DIVERGENCE issue that makes the mock leg red, so the
 * exemption cannot quietly become the resting state. The guard below fails both
 * ways: an undeclared backend-only command, and a declared one that has since
 * gained a live (non-skipped) fixture — delete the entry when its issue lands.
 */
const QUERY_STEPS_BACKEND_ONLY: Readonly<Record<string, string>> = {
  // Empty, and worth keeping empty. `list_blocks` (#3870) and
  // `list_inherited_tags_for_block` (#3871) were the only two entries: both
  // fixtures were `QUERY_DRIFT_SKIP`ped for a real mock divergence, and both
  // divergences are now FIXED IN THE MOCK rather than waived, so every read
  // command with a query step is diffed across both stacks again.
}

// ---------------------------------------------------------------------------
// Branch-level coverage keys (#3878)
// ---------------------------------------------------------------------------

/**
 * #3878 — a command-level coverage key answers "has this command been
 * exercised at all?", not "is each of its BEHAVIOURS exercised?". Those
 * diverge exactly when a command's `_inner` dispatches on which of several
 * MUTUALLY EXCLUSIVE optional request fields is set: `list_blocks_inner`
 * rejects more than one of `parent_id` / `block_type` / `tag_id` /
 * `agenda_date` / `agenda_date_start`+`agenda_date_end` being set (its
 * `filter_count` guard), then runs exactly one of five arms. Before this
 * manifest existed, `list_blocks` read as fully covered off the `tagId` /
 * `blockType` / `parentId` arms alone — the two `agenda_date*` arms had (and
 * still have, see `READ_QUERY_BRANCH_ALLOWLIST`) ZERO query steps anywhere in
 * `conformance/fixtures/*.json`, and nothing said so.
 *
 * Each entry names the discriminator FIELD as it appears in a query step's
 * `args.request` (the frontend's request DTO mirrors the backend's optional
 * dispatch params 1:1 — this is not a proxy for the Rust identifiers, it is
 * the same information under IPC's naming convention), in the same order as
 * the Rust `else if` chain. `stepBranchKey` below classifies a step by the
 * FIRST discriminator present and non-null in its args — exactly mirroring
 * the chain — falling through to `defaultBranch` when none match.
 *
 * A command absent from this manifest gets exactly one implicit branch (its
 * own name) from `stepBranchKey`, so THIS MANIFEST IS ADDITIVE: every
 * existing command-level coverage entry for the other read-only commands
 * stays valid unchanged. Only `list_blocks` decomposes into branches here.
 *
 * It is NOT the only command with an analogous shape, though — a broader
 * sweep than the `else if let Some` chain above found a second one:
 * `filtered_blocks_query_inner` (`src-tauri/src/commands/queries.rs`) has its
 * own "at most one of value_text, value_text_in, value_date, value_date_range
 * may be supplied per filter" exclusivity guard, and only the `value_text`
 * arm has a conformance query step today
 * (`filtered_blocks_status_open` in `query_reads_links_search_pages.json`).
 * `grep -rl 'else if let Some' src-tauri/src/commands` itself turns up THREE
 * files, not one (the other two — `pages/markdown.rs`'s property-value
 * markdown serialization and its tag-lookup helper — are write-path
 * formatting code, not a read command's query dispatch, so they are not
 * this shape). `filtered_blocks_query` is left out of this manifest
 * deliberately: closing it needs its own investigation (its branches don't
 * diverge in `ORDER BY` the way `list_blocks_inner`'s do, so the coverage
 * risk is lower-severity but still real) rather than a copy-paste of this
 * one. Tracked as a follow-up, not fixed here.
 *
 * This list is NOT free-standing the way a hand-maintained arm list would
 * be: `it('list_blocks branch discriminators match the Rust dispatch's
 * exclusive filter set', …)` below parses the `filter_count` array literal
 * out of `queries.rs` itself and fails if the two sets of identifiers
 * diverge, so a new or removed exclusive filter parameter cannot rot this
 * manifest silently — it makes the *coverage check* fail loud instead of the
 * manifest quietly going stale.
 */
interface BranchDiscriminator {
  /** Field name in the query step's `args.request` that selects this branch
   *  when present and non-null. */
  field: string
  /** Human-readable branch name, used in coverage keys (`${command}::${branch}`)
   *  and failure messages. */
  branch: string
}

interface BranchSpec {
  discriminators: readonly BranchDiscriminator[]
  /** Branch name when none of `discriminators` matches (the terminal `else`). */
  defaultBranch: string
}

const QUERY_STEP_BRANCH_DISCRIMINATORS: Readonly<Record<string, BranchSpec>> = {
  list_blocks: {
    discriminators: [
      { field: 'dateRange', branch: 'agenda-range' },
      { field: 'date', branch: 'agenda-date' },
      { field: 'tagId', branch: 'by-tag' },
      { field: 'blockType', branch: 'by-type' },
    ],
    defaultBranch: 'children',
  },
}

/** All coverage UNITS a command decomposes into: `${command}::${branch}` for
 *  every declared branch (discriminators + the default), or just `command`
 *  itself when it carries no branch manifest entry. */
function branchUnitsOf(command: string): string[] {
  const spec = QUERY_STEP_BRANCH_DISCRIMINATORS[command]
  if (!spec) return [command]
  return [
    ...spec.discriminators.map((d) => `${command}::${d.branch}`),
    `${command}::${spec.defaultBranch}`,
  ]
}

/** Classify a query step into its coverage unit, mirroring the Rust `else if`
 *  chain: the FIRST declared discriminator present and non-null in
 *  `step.args.request` wins; none matching falls to `defaultBranch`. Commands
 *  with no manifest entry classify to their own bare name (unchanged from
 *  pre-#3878 behavior). */
function stepBranchKey(command: string, step: QueryStepShape): string {
  const spec = QUERY_STEP_BRANCH_DISCRIMINATORS[command]
  if (!spec) return command
  const request = (step.args?.['request'] ?? {}) as Record<string, unknown>
  for (const d of spec.discriminators) {
    const v = request[d.field]
    if (v !== undefined && v !== null) return `${command}::${d.branch}`
  }
  return `${command}::${spec.defaultBranch}`
}

const RUST_QUERIES_PATH = path.resolve(RUST_COMMANDS_DIR, 'commands', 'blocks', 'queries.rs')

/** Parse the identifier list out of `list_blocks_inner`'s `filter_count`
 *  array literal (`[parent_id.is_some(), block_type.is_some(), …]`) — the
 *  Rust source's own statement of which params are mutually exclusive. Used
 *  only to cross-check `QUERY_STEP_BRANCH_DISCRIMINATORS` against it, not to
 *  derive the manifest (the field NAMES differ between the two — Rust
 *  `snake_case` params vs the IPC `camelCase` request DTO — so a name
 *  mapping is still declared by hand; what this guards is the *count and
 *  set*, so an added/removed exclusive filter cannot rot the manifest
 *  unnoticed). */
function extractFilterCountIdentifiers(): string[] {
  const source = readFileSync(RUST_QUERIES_PATH, 'utf8')
  const start = source.indexOf('let filter_count = [')
  if (start < 0) {
    throw new Error(
      `could not find "let filter_count = [" in ${RUST_QUERIES_PATH} — this guard ` +
        `parses list_blocks_inner's exclusive-filter array; update the parser if the ` +
        `source moved, don't shrink the expectation.`,
    )
  }
  const end = source.indexOf(']', start)
  if (end < 0) {
    throw new Error(`unterminated filter_count array in ${RUST_QUERIES_PATH}`)
  }
  return [...source.slice(start, end).matchAll(/(\w+)(?:\.is_some\(\))?/g)]
    .map((m) => m[1] as string)
    .filter((id) => id !== 'let' && id !== 'filter_count')
}

const CONFORMANCE_TEST_PATH = path.resolve(import.meta.dirname, 'conformance.test.ts')

/** Parse one `new Set([...])` declaration out of `conformance.test.ts` — reading
 *  the real set rather than a second copy that could drift from it. Comment
 *  lines are dropped first: the reasons contain apostrophes.
 *
 *  The needle includes the ` = ` deliberately. On a bare `const ${name}` prefix,
 *  one set name that PREFIXES another (`DRIFT_SKIP` vs a hypothetical
 *  `DRIFT_SKIP_STEPS`) resolves to whichever is declared FIRST in the file, so
 *  the parser silently reads the wrong set when someone reorders declarations.
 *  Anchoring on the assignment makes each name match only its own declaration. */
function loadSkipSet(name: string): Set<string> {
  const source = readFileSync(CONFORMANCE_TEST_PATH, 'utf8')
  const start = source.indexOf(`const ${name} =`)
  const end = source.indexOf('])', start)
  if (start < 0 || end < 0) {
    throw new Error(
      `could not find the ${name} set in ${CONFORMANCE_TEST_PATH} — this guard ` +
        `parses it; update the parser if the declaration moved.`,
    )
  }
  return new Set(
    source
      .slice(start, end)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .flatMap((line) => [...line.matchAll(/'([^']+)'/g)].map((m) => m[1] as string)),
  )
}

/** Every fixture whose QUERY leg is unasserted on the mock — the union of the
 *  whole-fixture and query-leg-only skip sets, matching the `run` predicate the
 *  query leg of `conformance.test.ts` actually uses. */
function loadDriftSkip(): Set<string> {
  return new Set([...loadSkipSet('DRIFT_SKIP'), ...loadSkipSet('QUERY_DRIFT_SKIP')])
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'fixtures',
)

interface FixtureShape {
  name: string
  ops: Array<{ command: string }>
  /** #3347 — post-op READ steps (see `conformance-query.ts`). */
  queries?: Array<QueryStepShape>
  /** #3347 — the backend-authored projection of each `queries` step. */
  expected_queries?: Array<{ name: string; rows: string[] }>
  /** Additive, replay-inert string tags declaring which scenarios this fixture
   *  pins (see `REQUIRED_SCENARIOS`). Absent on fixtures that predate the tag. */
  scenarios?: string[]
}

interface QueryStepShape {
  name: string
  command: string
  /** Opt-in declaration that this step's recorded `rows` is legitimately empty
   *  (see the vacuity guard below). Ignored by both query runners. */
  expect_empty?: boolean
  /** #3878 — the step's IPC args, read (not replayed) to classify which
   *  dispatch BRANCH of `command` this step exercises. See
   *  `QUERY_STEP_BRANCH_DISCRIMINATORS`. */
  args?: Record<string, unknown>
}

interface LoadedFixture {
  name: string
  opCommands: Set<string>
  queryCommands: Set<string>
  querySteps: QueryStepShape[]
  expectedQueries: Array<{ name: string; rows: string[] }>
  scenarios: Set<string>
}

function loadFixtures(): LoadedFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .toSorted()
    .map((f) => {
      const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as FixtureShape
      return {
        name: raw.name,
        opCommands: new Set(raw.ops.map((o) => o.command)),
        queryCommands: new Set((raw.queries ?? []).map((q) => q.command)),
        querySteps: raw.queries ?? [],
        expectedQueries: raw.expected_queries ?? [],
        scenarios: new Set(raw.scenarios ?? []),
      }
    })
}

// ---------------------------------------------------------------------------
// Required-scenario manifest
// ---------------------------------------------------------------------------

/**
 * Each `[op, scenario]` tuple MUST be pinned by at least one fixture that (a)
 * declares the `scenario` string in its top-level `scenarios` array AND (b)
 * drives `op` in its `ops`. This is the single place to enforce that the
 * behaviors we care about stay covered — including the recent escape classes.
 *
 * The COMMENTED-OUT tuples are scenarios not yet pinned on this tree. Uncomment
 * one line each when its fixture lands (and tag that fixture's `scenarios`),
 * turning the manifest red until the coverage is real — WITHOUT reddening CI
 * today. Do not delete them; they are the enforcement backlog.
 */
const REQUIRED_SCENARIOS: ReadonlyArray<readonly [op: string, scenario: string]> = [
  ['create_block', 'dense-1based-position'],
  ['delete_block', 'soft-delete-tombstone'],
  ['delete_block', 'cascade-active-subtree'],
  ['restore_block', 'same-cohort-restore'],
  ['purge_block', 'hard-delete-removes-row'],
  ['add_tag', 'tag-dedupe-lww'],
  ['remove_tag', 'tag-remove-single-edge'],
  ['add_tag', 'tag-readd-after-remove'],
  ['set_property', 'property-typed-value-columns'],
  ['delete_property', 'delete-one-of-many-properties'],
  ['move_block', 'move-cross-page-retains-property'],
  ['set_todo_state', 'agenda-reserved-columns'],

  ['purge_block', 'subtree-with-satellites'],
  ['purge_block', 'used-as-tag-cleanup'],
  ['set_property', 'reserved-key-routes-to-column'],
  ['delete_property', 'reserved-key-clears-column'],

  // purge_block/soft-delete-guard (#3091) is deliberately NOT a tuple: the
  // conformance op-runner cannot express it. The soft-delete guard + depth cap
  // live only in the `purge_block_inner` COMMAND path, while the runner applies
  // the PurgeBlock OP via append_local_op + dispatch_op (the materializer's
  // guard-free `purge_block_sql_cascade`), so backend and mock would diverge on
  // a live-block purge fixture. Its coverage is the mock unit tests
  // (tauri-mock.test.ts) + the backend's own command-layer tests.

  // create_block/tag-space-scope (#3081, shipped in #3092) is deliberately NOT a
  // tuple: the harness cannot express it (assign_all_to_test_space masks space-less
  // orphans; the snapshot omits space_id). Its coverage is the Rust integration test
  // (tag_integration.rs *_3081) + the mock round-trip tests.
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#3083 conformance-coverage ratchet', () => {
  const bindingsCommands = extractBindingsCommandNames()
  const mutatingCommands = bindingsCommands.filter((c) => !isReadOnly(c))
  const readOnlyCommands = bindingsCommands.filter((c) => isReadOnly(c))
  const fixtures = loadFixtures()

  // Commands actually driven by ≥1 fixture. A conformance op IS the IPC command
  // name (the Rust runner's `apply_op` matches on `op.command`), so this is the
  // set of behaviorally-covered mutating commands.
  const fixtureOpCommands = new Set<string>()
  for (const fx of fixtures) for (const c of fx.opCommands) fixtureOpCommands.add(c)

  // #3347 — the same idea for reads: a query step's `command` IS the IPC
  // command name (the Rust runner's `run_step` matches on it).
  const fixtureQueryCommands = new Set<string>()
  for (const fx of fixtures) for (const c of fx.queryCommands) fixtureQueryCommands.add(c)

  // #3878 — the BRANCH-grained twin of `fixtureQueryCommands`. Any query step
  // ANYWHERE (regardless of skip/liveness — that finer distinction is the
  // backend-only check further down) contributes its `stepBranchKey` unit.
  // For a command with no `QUERY_STEP_BRANCH_DISCRIMINATORS` entry this is
  // exactly `fixtureQueryCommands`'s membership under a different name (the
  // key equals the bare command); for `list_blocks` it decomposes into up to
  // five distinct units.
  const fixtureQueryBranches = new Set<string>()
  for (const fx of fixtures) {
    for (const step of fx.querySteps) fixtureQueryBranches.add(stepBranchKey(step.command, step))
  }

  it('extracts a non-trivial command + fixture surface (guards vacuous pass)', () => {
    expect(bindingsCommands.length).toBeGreaterThan(50)
    expect(mutatingCommands.length).toBeGreaterThan(30)
    expect(readOnlyCommands.length).toBeGreaterThan(30)
    expect(fixtures.length).toBeGreaterThan(15)
    expect(fixtureOpCommands.size).toBeGreaterThanOrEqual(10)
    // #3347 — a floor on QUERY coverage too. Without it the read-only ratchet
    // below could be satisfied entirely by waivers and still read as a gate.
    expect(fixtureQueryCommands.size).toBeGreaterThanOrEqual(5)
  })

  // #3332 — classify by EVIDENCE, not by verb. `READ_ONLY_PREFIXES` is a
  // name heuristic; the backend signature is the fact. `fetch_link_metadata`
  // (upserts the link-metadata cache) and `list_page_links` (lazily rebuilds
  // `page_link_cache`) both took a write handle while the verb heuristic
  // exempted them from the fixture requirement AND from the honesty audit.
  it('the read-only classifier agrees with the Rust command signatures', () => {
    const rustSignatures = extractRustCommandSignatures()

    // Guard the guard: if the extraction regex ever stops matching, the check
    // below would pass vacuously. Every command in `bindings.ts` is generated
    // from a `#[tauri::command]` fn, so the two sets must line up exactly.
    const unlocated = bindingsCommands.filter((c) => !rustSignatures.has(c))
    expect(
      unlocated,
      `extractRustCommandSignatures() could not locate these bindings.ts commands ` +
        `in src-tauri/src: ${JSON.stringify(unlocated)}. The extraction is broken — ` +
        `fix it rather than shrinking the expectation, or this check passes vacuously.`,
    ).toEqual([])

    const writeTakingButReadOnly = bindingsCommands.filter(
      (c) =>
        isReadOnly(c) &&
        takesWriteHandle(rustSignatures.get(c) ?? '') &&
        !(c in READ_ONLY_CACHE_WRITERS),
    )
    expect(
      writeTakingButReadOnly,
      `These commands are classified READ-ONLY by their name prefix but take a ` +
        `Rust write handle (WritePool / WriteCtx): ` +
        `${JSON.stringify(writeTakingButReadOnly)}. A read-only classification ` +
        `exempts a command from BOTH the fixture requirement and the honesty ` +
        `audit, so the verb must not outrank the signature. FIX by EITHER ` +
        `renaming/reclassifying the command as mutating (then give it a fixture ` +
        `or a NO_FIXTURE_ALLOWLIST waiver), OR — if the only thing it writes is a ` +
        `derived cache outside the conformance snapshot scope — adding it to ` +
        `READ_ONLY_CACHE_WRITERS with that reason.`,
    ).toEqual([])

    // Shrink-only: an entry whose command stopped taking a write handle is a
    // stale exemption.
    const staleCacheWriters = Object.keys(READ_ONLY_CACHE_WRITERS).filter(
      (c) => !takesWriteHandle(rustSignatures.get(c) ?? ''),
    )
    expect(
      staleCacheWriters,
      `READ_ONLY_CACHE_WRITERS exempts commands that no longer take a write ` +
        `handle: ${JSON.stringify(staleCacheWriters)}. Delete the stale entries.`,
    ).toEqual([])
  })

  it('every mutating command has a conformance fixture or a justified allowlist waiver', () => {
    const uncovered = mutatingCommands.filter(
      (c) => !fixtureOpCommands.has(c) && !(c in NO_FIXTURE_ALLOWLIST),
    )
    expect(
      uncovered,
      `These state-MUTATING Tauri commands have NO conformance fixture and NO ` +
        `allowlist waiver: ${JSON.stringify(uncovered)}. A name-only mock handler ` +
        `can silently diverge from the backend. FIX by EITHER (a) adding a ` +
        `conformance/fixtures/*.json fixture that drives the command (author its ` +
        `expected with CONFORMANCE_UPDATE=1 cargo nextest run -E ` +
        `'test(conformance_fixtures_match_backend)'), OR (b) adding an entry to ` +
        `NO_FIXTURE_ALLOWLIST in this file with a reason. If the command is ` +
        `read-only, give it a query-verb prefix or add it to READ_ONLY_EXACT.`,
    ).toEqual([])
  })

  it('allowlist stays honest (no stale, read-only, or now-covered entries)', () => {
    const allowKeys = Object.keys(NO_FIXTURE_ALLOWLIST)

    const notInBindings = allowKeys.filter((c) => !bindingsCommands.includes(c))
    expect(
      notInBindings,
      `NO_FIXTURE_ALLOWLIST references commands absent from bindings.ts ` +
        `${JSON.stringify(notInBindings)}. Remove the stale entries.`,
    ).toEqual([])

    const misclassifiedReadOnly = allowKeys.filter((c) => isReadOnly(c))
    expect(
      misclassifiedReadOnly,
      `NO_FIXTURE_ALLOWLIST lists read-only commands ${JSON.stringify(misclassifiedReadOnly)}; ` +
        `read-only commands are not mutating candidates — remove them.`,
    ).toEqual([])

    const nowCovered = allowKeys.filter((c) => fixtureOpCommands.has(c))
    expect(
      nowCovered,
      `NO_FIXTURE_ALLOWLIST waives commands now driven by a fixture ` +
        `${JSON.stringify(nowCovered)}. Delete the redundant waiver — the fixture ` +
        `is the coverage.`,
    ).toEqual([])

    expect(
      allowKeys.every((c) => NO_FIXTURE_ALLOWLIST[c]?.trim()),
      'Every NO_FIXTURE_ALLOWLIST entry needs a non-empty reason string.',
    ).toBe(true)
  })

  // #3347 — the READ half of the ratchet. `isReadOnly` used to be a blanket
  // exemption: a `get_` / `list_` / `search_` command needed neither a fixture
  // nor a waiver, so the query surface the UI renders from had no differential
  // coverage at all. It now needs a query step or a reasoned waiver.
  //
  // #3878 — command-level was one granularity too coarse: it answers "has
  // THIS COMMAND been exercised at all?" when the question that matters is
  // "is each of its BEHAVIOURS exercised?". Those diverge exactly when a
  // command dispatches on which of several mutually exclusive request fields
  // is set (`list_blocks_inner`'s `filter_count` chain) — a command with
  // three of five arms covered read as fully green here. The requirement is
  // now expressed per coverage UNIT (`branchUnitsOf`: `${command}::${branch}`
  // for a manifested command, or just `command` — unchanged — for the other
  // ~63 that carry no branch manifest), waived either at the branch level
  // (`READ_QUERY_BRANCH_ALLOWLIST`) or, still, at the whole-command level
  // (`READ_NO_QUERY_ALLOWLIST` continues to exempt every branch of a command
  // that has no query coverage whatsoever).
  it('every read-only command BRANCH has a conformance query step or a justified allowlist waiver', () => {
    const requiredUnits = readOnlyCommands.flatMap((c) => branchUnitsOf(c))
    const uncovered = requiredUnits.filter((unit) => {
      const command = unit.split('::')[0] as string
      return (
        !fixtureQueryBranches.has(unit) &&
        !(unit in READ_QUERY_BRANCH_ALLOWLIST) &&
        !(command in READ_NO_QUERY_ALLOWLIST)
      )
    })
    expect(
      uncovered,
      `These READ-ONLY Tauri command BRANCHES have NO conformance query step and ` +
        `NO allowlist waiver: ${JSON.stringify(uncovered)}. The mock's answer to a ` +
        `read command is what almost every vitest/Playwright spec asserts against, ` +
        `so an unchecked branch is an unchecked arm of a second implementation of ` +
        `the query. FIX by EITHER (a) adding a "queries" step to a ` +
        `conformance/fixtures/*.json fixture that drives this branch's discriminator ` +
        `arg — wire it in src-tauri/src/command_integration_tests/conformance_query.rs ` +
        `and in the WIRE table of ./conformance-query.ts, then author the expectation ` +
        `with CONFORMANCE_UPDATE=1 cargo nextest run -E ` +
        `'test(conformance_fixtures_match_backend)' — OR (b) adding an entry to ` +
        `READ_QUERY_BRANCH_ALLOWLIST in this file with a reason.`,
    ).toEqual([])
  })

  it('read branch allowlist stays honest (no stale, unknown, or now-covered entries)', () => {
    const allowKeys = Object.keys(READ_QUERY_BRANCH_ALLOWLIST)
    const allKnownUnits = new Set(readOnlyCommands.flatMap((c) => branchUnitsOf(c)))

    const unknownUnit = allowKeys.filter((k) => !allKnownUnits.has(k))
    expect(
      unknownUnit,
      `READ_QUERY_BRANCH_ALLOWLIST references units that are not a real read-only ` +
        `command branch ${JSON.stringify(unknownUnit)}. Either the command left ` +
        `bindings.ts, is not read-only, or the branch name no longer matches ` +
        `QUERY_STEP_BRANCH_DISCRIMINATORS (a rename on one side without the other). ` +
        `Fix the typo or remove the stale entry.`,
    ).toEqual([])

    const wholeCommandAlsoWaived = allowKeys.filter(
      (k) => (k.split('::')[0] as string) in READ_NO_QUERY_ALLOWLIST,
    )
    expect(
      wholeCommandAlsoWaived,
      `These branch waivers are redundant — the whole command is ALREADY waived by ` +
        `READ_NO_QUERY_ALLOWLIST ${JSON.stringify(wholeCommandAlsoWaived)}. Delete the ` +
        `branch-level entry; the command-level one already covers every branch.`,
    ).toEqual([])

    const nowCovered = allowKeys.filter((k) => fixtureQueryBranches.has(k))
    expect(
      nowCovered,
      `READ_QUERY_BRANCH_ALLOWLIST waives branches now driven by a conformance query ` +
        `step ${JSON.stringify(nowCovered)}. Delete the redundant waiver — the query ` +
        `step is the coverage.`,
    ).toEqual([])

    expect(
      allowKeys.every((k) => READ_QUERY_BRANCH_ALLOWLIST[k]?.trim()),
      'Every READ_QUERY_BRANCH_ALLOWLIST entry needs a non-empty reason string.',
    ).toBe(true)
  })

  // #3878 — guards `QUERY_STEP_BRANCH_DISCRIMINATORS` against silently rotting
  // the way the issue warned a hand-maintained arm list would: if
  // `list_blocks_inner`'s exclusive-filter set gains or loses a parameter,
  // this fails LOUD instead of the manifest quietly under- or over-claiming
  // branches. It does not derive the manifest (the Rust `snake_case` params
  // and the IPC `camelCase` request fields are named independently, and the
  // mapping between them is still declared by hand above) — it cross-checks
  // that the two sides agree on the SET.
  it("list_blocks branch discriminators match the Rust dispatch's exclusive filter set", () => {
    const rustParams = extractFilterCountIdentifiers().toSorted()
    // `parent_id` has no `else if` arm of its own — it is `filter_count`'s
    // fifth member but dispatches through the terminal `else`, i.e. this
    // manifest's `defaultBranch`. Every OTHER rust param must have exactly one
    // declared discriminator.
    const expected = ['agenda_date', 'block_type', 'has_agenda_range', 'parent_id', 'tag_id']
    expect(
      rustParams,
      `list_blocks_inner's filter_count array changed to ${JSON.stringify(rustParams)} ` +
        `(expected ${JSON.stringify(expected)}). QUERY_STEP_BRANCH_DISCRIMINATORS.list_blocks ` +
        `declares exactly 4 discriminators + 1 default branch mapped from these 5 Rust ` +
        `params by hand — update BOTH the manifest and this expected list together so ` +
        `the two stay in sync, don't just widen the assertion.`,
    ).toEqual(expected)

    const spec = QUERY_STEP_BRANCH_DISCRIMINATORS['list_blocks']
    expect(spec, 'list_blocks must stay declared in QUERY_STEP_BRANCH_DISCRIMINATORS').toBeDefined()
    // discriminators.length + 1 (the default/parent_id fallthrough) must equal
    // the Rust exclusive-filter set size, so a new arm can't be added on one
    // side without the other.
    expect((spec?.discriminators.length ?? 0) + 1).toBe(rustParams.length)
  })

  it('read allowlist stays honest (no stale, mutating, or now-covered entries)', () => {
    const allowKeys = Object.keys(READ_NO_QUERY_ALLOWLIST)

    const notInBindings = allowKeys.filter((c) => !bindingsCommands.includes(c))
    expect(
      notInBindings,
      `READ_NO_QUERY_ALLOWLIST references commands absent from bindings.ts ` +
        `${JSON.stringify(notInBindings)}. Remove the stale entries.`,
    ).toEqual([])

    // A command cannot be waived twice. Overlap would let a rename between the
    // two classifications silently keep a command exempt under the other list.
    //
    // ORDER MATTERS: this runs BEFORE `misclassifiedMutating`. A double-waived
    // MUTATING command trips both filters, and the first failing `expect`
    // aborts the `it` — so with the two swapped, the only overlap direction
    // this check could ever report on its own was the read-only one (and there
    // `misclassifiedReadOnly`, in the sibling `it` above, is already red). It
    // was a guard that could not fire.
    const doubleWaived = allowKeys.filter((c) => c in NO_FIXTURE_ALLOWLIST)
    expect(
      doubleWaived,
      `These commands are waived by BOTH allowlists ${JSON.stringify(doubleWaived)}. ` +
        `Each command has exactly one classification — keep exactly one waiver.`,
    ).toEqual([])

    const misclassifiedMutating = allowKeys.filter((c) => !isReadOnly(c))
    expect(
      misclassifiedMutating,
      `READ_NO_QUERY_ALLOWLIST lists commands that are NOT read-only ` +
        `${JSON.stringify(misclassifiedMutating)}; a mutating command belongs in ` +
        `NO_FIXTURE_ALLOWLIST (or needs an op fixture) instead.`,
    ).toEqual([])

    const nowCovered = allowKeys.filter((c) => fixtureQueryCommands.has(c))
    expect(
      nowCovered,
      `READ_NO_QUERY_ALLOWLIST waives commands now driven by a conformance query ` +
        `step ${JSON.stringify(nowCovered)}. Delete the redundant waiver — the ` +
        `query step is the coverage.`,
    ).toEqual([])

    expect(
      allowKeys.every((c) => READ_NO_QUERY_ALLOWLIST[c]?.trim()),
      'Every READ_NO_QUERY_ALLOWLIST entry needs a non-empty reason string.',
    ).toBe(true)
  })

  // #3347 vacuity guard. `expected_queries` is authored by the backend and
  // asserted by both runners — but an EMPTY projection is authored and asserted
  // exactly like a populated one. A step whose args select nothing (a scope
  // pointing at a space with no blocks, a filter no seed row satisfies, a
  // search term nothing matches) records `"rows": []`, the mock reproduces `[]`,
  // and the differential passes having compared nothing. That is the harness's
  // catastrophic failure mode — two stacks agreeing because neither reached any
  // data — and it looks identical to coverage.
  //
  // So an empty step must SAY it is empty. `"expect_empty": true` on the step is
  // the declaration; both runners ignore the key, and it cannot rot because a
  // step that declares it and then returns rows fails here too.
  it('every conformance query step records a non-empty result (or declares itself empty)', () => {
    const vacuous: string[] = []
    const staleEmptyClaim: string[] = []
    const misaligned: string[] = []
    for (const fx of fixtures) {
      if (fx.querySteps.length === 0) continue
      for (const [i, step] of fx.querySteps.entries()) {
        const recorded = fx.expectedQueries[i]
        if (!recorded || recorded.name !== step.name) {
          misaligned.push(`${fx.name}/${step.name}`)
          continue
        }
        const isEmpty = recorded.rows.length === 0
        if (isEmpty && step.expect_empty !== true) vacuous.push(`${fx.name}/${step.name}`)
        if (!isEmpty && step.expect_empty === true) staleEmptyClaim.push(`${fx.name}/${step.name}`)
      }
    }

    expect(
      misaligned,
      `These query steps have no positionally-matching \`expected_queries\` entry ` +
        `${JSON.stringify(misaligned)}. The two arrays are index-aligned — re-author ` +
        `with CONFORMANCE_UPDATE=1 cargo nextest run -E ` +
        `'test(conformance_fixtures_match_backend)'.`,
    ).toEqual([])

    expect(
      vacuous,
      `These conformance query steps recorded ZERO rows ${JSON.stringify(vacuous)}. ` +
        `An empty step proves nothing: the mock reproduces \`[]\` whatever it does, ` +
        `so the step reads as coverage while comparing nothing. FIX by EITHER ` +
        `(a) giving the step args that actually select seeded rows, OR (b) adding ` +
        `"expect_empty": true to the step plus a "comment" saying which negative ` +
        `the empty result pins (both query runners ignore the key).`,
    ).toEqual([])

    expect(
      staleEmptyClaim,
      `These query steps declare "expect_empty": true but recorded rows ` +
        `${JSON.stringify(staleEmptyClaim)}. Drop the stale declaration.`,
    ).toEqual([])
  })

  // #3826 — a query step in a DRIFT_SKIPped fixture is backend-only, not a
  // differential. Say so explicitly, per command, with the issue that will make
  // it one.
  it('every read command whose query steps are all DRIFT_SKIPped is declared backend-only', () => {
    const skipped = loadDriftSkip()
    const staleSkip = [...skipped].filter((name) => !fixtures.some((fx) => fx.name === name))
    expect(
      staleSkip,
      `DRIFT_SKIP / QUERY_DRIFT_SKIP name fixtures that no longer exist ${JSON.stringify(staleSkip)}. ` +
        `Remove the stale entries from conformance.test.ts.`,
    ).toEqual([])

    // Live == the step actually asserts mock-vs-backend over DATA. Two ways to
    // fail that, and counting only the first is this guard's own bug repeated
    // one level down:
    //
    //   1. the step's fixture is query-skipped, so the mock leg never runs it;
    //   2. the step runs but recorded ZERO rows, so the comparison is `[] == []`
    //      and a constant-`[]` handler satisfies it.
    //
    // (2) is why `rows.length` is consulted here rather than mere step
    // PRESENCE. An `expect_empty` step is a legitimate assertion next to a
    // populated sibling — the vacuity guard above enforces the declaration —
    // but it is not, on its own, evidence that the command was differentially
    // exercised. A command whose only unskipped step is empty is exactly as
    // undiffed as one with no unskipped step at all, and must be declared.
    // #3878 — keyed on `stepBranchKey`, not `step.command`: a command with a
    // branch manifest (`list_blocks`) is live per-BRANCH, so a DRIFT_SKIP that
    // only takes out one arm's steps cannot hide behind a sibling arm's live
    // step the way command-level keying let it.
    const liveCommands = new Set<string>()
    for (const fx of fixtures) {
      if (skipped.has(fx.name)) continue
      for (const [i, step] of fx.querySteps.entries()) {
        // Index-aligned with `querySteps`; the vacuity guard above fails first
        // if that alignment ever breaks, so a missing entry here is treated as
        // no evidence rather than silently counted.
        if ((fx.expectedQueries[i]?.rows.length ?? 0) === 0) continue
        liveCommands.add(stepBranchKey(step.command, step))
      }
    }
    // `fixtureQueryBranches` (any liveness) is the branch-grained twin of
    // `fixtureQueryCommands` used everywhere else in this file — see its
    // declaration above.
    const backendOnly = [...fixtureQueryBranches].filter((c) => !liveCommands.has(c)).toSorted()
    const undeclared = backendOnly.filter((c) => !(c in QUERY_STEPS_BACKEND_ONLY))
    expect(
      undeclared,
      `These command branches have NO query step that is both unskipped on the mock ` +
        `leg and non-empty ${JSON.stringify(undeclared)} — either every step lives in ` +
        `a query-skipped fixture, or the ones that run recorded zero rows. Both mean ` +
        `the branch is pinned on one stack, not diffed across two. FIX by EITHER ` +
        `adding a live fixture step that SELECTS ROWS, OR declaring the branch in ` +
        `QUERY_STEPS_BACKEND_ONLY with the divergence issue that keeps it skipped.`,
    ).toEqual([])

    const stale = Object.keys(QUERY_STEPS_BACKEND_ONLY).filter((c) => liveCommands.has(c))
    expect(
      stale,
      `QUERY_STEPS_BACKEND_ONLY declares branches that now have a LIVE, non-empty ` +
        `query step ${JSON.stringify(stale)}. The divergence is fixed — delete the entry.`,
    ).toEqual([])

    // The sibling allowlists both audit for entries that no longer name
    // anything real; without the same check here, deleting the last fixture
    // that drives a declared command leaves its waiver behind, still reading
    // as a live exemption for a command nothing exercises. Entries may name
    // either a bare command (no branch manifest) or a `command::branch` unit.
    const orphaned = Object.keys(QUERY_STEPS_BACKEND_ONLY)
      .filter((c) => !fixtureQueryCommands.has(c) && !fixtureQueryBranches.has(c))
      .toSorted()
    expect(
      orphaned,
      `QUERY_STEPS_BACKEND_ONLY declares commands/branches that NO fixture drives a ` +
        `query step for ${JSON.stringify(orphaned)}. The waiver describes a ` +
        `backend-only step that no longer exists — remove the entry (or restore the ` +
        `fixture).`,
    ).toEqual([])

    expect(
      Object.keys(QUERY_STEPS_BACKEND_ONLY).every((c) => QUERY_STEPS_BACKEND_ONLY[c]?.trim()),
      'Every QUERY_STEPS_BACKEND_ONLY entry needs a non-empty reason naming the issue.',
    ).toBe(true)
  })

  // Every command wired into the query runner must be reachable as a read: a
  // query step naming a MUTATING command would drive state inside the read
  // phase, after the snapshot has been taken, and no assertion would see it.
  it('every conformance query step drives a read-only command', () => {
    const mutatingQuerySteps = [...fixtureQueryCommands].filter((c) => !isReadOnly(c))
    expect(
      mutatingQuerySteps,
      `These conformance query steps drive MUTATING commands ` +
        `${JSON.stringify(mutatingQuerySteps)}. Query steps run AFTER the state ` +
        `snapshot is taken, so their writes are unasserted — drive the command ` +
        `from "ops" instead.`,
    ).toEqual([])
  })

  it('every required (op, scenario) is pinned by a fixture that declares it and drives the op', () => {
    const unmet = REQUIRED_SCENARIOS.filter(
      ([op, scenario]) =>
        !fixtures.some((fx) => fx.scenarios.has(scenario) && fx.opCommands.has(op)),
    )
    expect(
      unmet,
      `These required (op, scenario) tuples are not pinned by any fixture: ` +
        `${JSON.stringify(unmet)}. FIX by adding/extending a ` +
        `conformance/fixtures/*.json fixture so it drives <op> AND declares ` +
        `<scenario> in its top-level "scenarios" array (the tag is additive and ` +
        `inert to the replay). If a tuple is not yet ready, keep it commented out ` +
        `in REQUIRED_SCENARIOS.`,
    ).toEqual([])
  })
})
