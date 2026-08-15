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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  // #3964 — the four corrections the citation guard below forced. Each of
  // these reasons used to name a file that does not mention the command it
  // waives; nothing checked, so the waiver read as coverage it did not have.
  undo_op: 'NOT cross-checked; regression-guarded by revert-cohort.test.ts / undo-op-refs.test.ts',
  undo_ops:
    'NOT cross-checked; regression-guarded by undo-op-refs.test.ts and, for the reversal ' +
    'core it delegates to, revert.test.ts (via applyRevertForOp)',
  undo_page_op:
    'NOT cross-checked; regression-guarded by revert-cohort.test.ts / undo-move.test.ts',
  // Was "regression-guarded by undo-op-refs.test.ts" — that file's own doc
  // scopes it to `undo_op` / `undo_ops` and it never mentions this command.
  // The only test that names `undo_page_group` drives the FE store against a
  // MOCKED `invoke`, so it never reaches this handler: the mock's
  // `undo_page_group` has no mock-level regression test at all.
  undo_page_group:
    'NOT cross-checked, and not mock-level guarded either: the only test naming ' +
    'undo_page_group is components/pages/__tests__/PageHeader.test.tsx, which asserts ' +
    'the FE issues the IPC against a MOCKED invoke and never reaches this handler (#3964)',
  redo_page_op: 'NOT cross-checked; regression-guarded by undo-move.test.ts',
  revert_ops:
    'NOT cross-checked; regression-guarded by revert-cohort.test.ts and, for the ' +
    'per-op reversal it loops, revert.test.ts (via applyRevertForOp)',
  // Was "regression-guarded by revert.test.ts". revert.test.ts pins
  // `applyRevertForOp`, which this handler never calls — the mock's
  // `restore_page_to_op` is a CONSTANT STUB returning `{ops_reverted: 0,
  // non_reversible_skipped: 0, results: []}` (handlers/history.ts). There is
  // no behaviour to regression-guard, and the old citation implied there was.
  restore_page_to_op:
    'NOT cross-checked; the mock handler is a CONSTANT STUB returning zeroed counters ' +
    '(handlers/history.ts), so no mock-level test guards a behaviour it does not have (#3964)',
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
  // `list_blocks`'s single-date agenda arm (#3878, found while fixing #3877's
  // review notes). Not a structural blocker on the query SIDE —
  // `list_blocks_inner` takes an explicit `agenda_date` argument, so that is
  // trivially seedable as an ARG. The blocker is the DATA the arm reads: it
  // goes through `pagination::list_agenda`, which reads the `agenda_cache`
  // table, not `blocks` directly. A fixture `seed` only inserts into
  // `blocks`/`properties`/`tags` — populating `agenda_cache` needs
  // `set_due_date` / `set_scheduled_date` OPS run first, i.e. an ops-then-
  // query fixture shape. Its sibling `agenda-range` arm got exactly that
  // shape in `query_list_blocks_pagination_id_keyset.json`'s
  // `agenda_range_page_1`/`_2` steps (#3942 review note 7); this waiver is
  // what remains once that one lifted.
  'list_blocks::agenda-date':
    'agenda_cache rows require set_due_date/set_scheduled_date OPS before the ' +
    'query step, not just a seed — no query_*.json fixture does that yet (#3878)',

  // #3927 — the two arms of the three commands added by that issue that a
  // query step cannot express. Both blockers are in the HARNESS, not in the
  // fixture seed, which is why neither reads "fixture candidate".
  'search_blocks::blank-unfiltered':
    'the arm returns the EMPTY page by construction (blank query + no structural ' +
    'filter never reads a row), so its step would record zero rows: the vacuity ' +
    'guard rejects that without "expect_empty", and the backend-only guard counts ' +
    'an empty step as no differential evidence at all. Both are right in general ' +
    'and wrong here — the empty answer IS the behaviour, and a mock returning the ' +
    'whole DB would fail such a step. Lifting this needs the liveness guard to ' +
    'admit an `expect_empty` step whose branch is empty BY DESIGN (as opposed to ' +
    'one that merely selected nothing), which is a change to the guard, not a ' +
    'fixture. Its sibling `blank-filtered` is covered and shares the blank-query ' +
    'test, so the discriminator between them is exercised from one side (#3927)',
  'run_advanced_query::grouped':
    'the grouped path answers under `groups[].members` with `rows` left EMPTY, and ' +
    'the query projection binds exactly one `rows` list plus one has_more/total_count ' +
    'pair — the same shape blocker `search_blocks_partitioned` is waived for, so a ' +
    'step needs a group-qualified row token in BOTH runners, not just a fixture. ' +
    'The mock compounds it: its grouped path SYNTHESISES a single bucket from the ' +
    'request shape rather than computing one (handlers/search.ts), so the step would ' +
    'need that implemented too (#3927)',
}
// NOTE for whoever lifts the remaining agenda-date waiver above (and for
// `agenda-range`'s own steps, added by #3942 review note 7): `list_blocks_inner`'s
// `agenda-range` and `agenda-date` arms both sub-dispatch a SECOND time on
// `agenda_source` (`pagination::list_agenda[_range](…, agenda_source.as_deref(), …)`
// in `queries.rs`, keyed on `due_date` / `scheduled_date` / no source) once
// inside `pagination::list_agenda[_range]`. This manifest only models the
// top-level `filter_count` chain, so a single query step with ANY
// `agenda_source` value will credit the WHOLE arm the moment it gets a query
// step — exactly the branch-invisible-coverage shape #3878 exists to catch,
// one level down. `agenda_range_page_1`/`_2` pass no `source` (the "no
// source" case), so `agenda-range`'s `due_date`/`scheduled_date`-source
// sub-arms are credited but not actually exercised — the SAME residual gap
// this note already named, now realised on the arm that lifted first.
// Closing it needs `agenda_source` modelled as its own sub-branch (e.g.
// `list_blocks::agenda-date::due_date`), not just a step with a non-null
// `date`/`dateRange`.

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
 * Each entry declares one or more DIMENSIONS (`BranchDimension`), each a chain
 * of discriminators in the same order as the Rust's own `else if` /
 * `match`. `stepBranchKeys` below classifies a step by the FIRST discriminator
 * that matches — exactly mirroring the chain — falling through to
 * `defaultBranch` when none do. A discriminator matches on a field's PRESENCE
 * (`Option::is_some()` / `!Vec::is_empty()`), on a field's VALUE (`equals`, for
 * an enum-shaped `match`), or on a hand-written predicate (`when`, for a
 * dispatch that is neither).
 *
 * A command absent from this manifest gets exactly one implicit branch (its
 * own name) from `stepBranchKeys`, so THIS MANIFEST IS ADDITIVE: every
 * existing command-level coverage entry for the other read-only commands
 * stays valid unchanged.
 *
 * #3892 — `list_blocks` was NOT the only command with an analogous shape, and
 * the sweep that concluded it was (a `grep -rl 'else if let Some'`) was wrong
 * on both halves. The first half is `filtered_blocks_query`, manifested
 * below. The second half is a correction to a claim this note used to make
 * (#3878): the same grep's third hit was `pages/markdown.rs`'s property-value
 * markdown serialization and its tag-lookup helper, dismissed at the time as
 * "write-path formatting code, not a read command's query dispatch". True of
 * the tag-lookup helper — but not of `export_page_markdown`, which lives in
 * the same file and matched the same grep, yet is in fact a READ-ONLY IPC
 * command. It is waived instead via `READ_NO_QUERY_ALLOWLIST` (see that
 * entry) because it returns a rendered markdown `String`, not canonical
 * block-id rows the query projection can bind — not because it is a write
 * path. Recorded here so a later sweep does not repeat the misclassification.
 *
 * `filtered_blocks_query_inner`
 * (`src-tauri/src/commands/queries.rs`) carries its own "at most one of
 * value_text, value_text_in, value_date, value_date_range may be supplied per
 * filter" exclusivity guard, and before #3892 only the `value_text` arm had a
 * conformance query step (`filtered_blocks_status_open` in
 * `query_reads_links_search_pages.json`) while the command read as fully
 * covered. It is manifested below — but NOT as a copy of `list_blocks`,
 * because the two differ in three ways that the shared machinery has to model:
 *
 *   1. WHERE the discriminators live. `list_blocks` takes ONE request DTO, so
 *      its discriminators are top-level `args.request` fields and a step maps
 *      to exactly ONE branch. `filtered_blocks_query` takes a flat arg list
 *      whose value shapes live PER ELEMENT of `args.propertyFilters` — so a
 *      step maps to a SET of branches (one per filter element), and a step
 *      with no property filters at all (tag-only / blockType-only) maps to
 *      NONE. Modelled by `BranchDimension.source`.
 *   2. What "present" means. `value_text_in` is a `Vec<String>`, dispatched on
 *      `!is_empty()`, not `Option::is_some()` — an empty array is ABSENT to
 *      the backend, so it must be absent to the classifier too
 *      (`discriminatorPresent`).
 *   3. The arithmetic of the default branch. Every one of `list_blocks`'s five
 *      exclusive filters is a dispatch arm, and `parent_id`'s arm IS the
 *      terminal `else` — so `discriminators.length + 1 === rustParams.length`.
 *      For `filtered_blocks_query` all FOUR value fields have their own arm
 *      AND there is a real fifth arm for "none supplied" (the EXISTS degrades
 *      to a bare key-presence check / a bare `IS NOT NULL` on the reserved
 *      column) — so here `discriminators.length === rustFields.length` and the
 *      default branch is genuinely extra.
 *
 * Neither list is free-standing the way a hand-maintained arm list would be.
 * Two cross-check tests below parse the dispatch out of the Rust itself and
 * fail LOUD when the two sides diverge:
 *
 *   - `list_blocks …` parses `list_blocks_inner`'s `filter_count` array
 *     literal out of `blocks/queries.rs` (guards the SET, order-insensitively).
 *   - `filtered_blocks_query …` parses BOTH of that command's value-shape
 *     dispatch SITES out of `commands/queries.rs` — the exclusivity guard and
 *     the `if/else if` chain, at each of the reserved-column and
 *     non-reserved-property paths — and guards the ORDER, not just the set,
 *     because `stepBranchKeys` mirrors first-match order. It also pins that
 *     the two sites agree with EACH OTHER, which is what makes one manifest
 *     entry legitimate for a command that dispatches on the same four shapes
 *     in two different places.
 *
 * #3927 — the sweep #3892 left behind found three more commands whose coverage
 * was branch-invisible for the same reason, and each needed the shared
 * machinery to grow rather than just gaining rows:
 *
 *   - `list_pages_with_metadata` dispatches on a field's VALUE, not its
 *     presence (`match sort { PageSort::MostLinked => … }`), so
 *     `BranchDiscriminator` gained `equals`. Its default arm is the
 *     `#[serde(default)]` variant, so an OMITTED `sort` is a real arm rather
 *     than a missing one — the inverse of `list_blocks`, where the terminal
 *     `else` is a filter nobody set.
 *   - `search_blocks` dispatches on a blank-STRING test crossed with a
 *     six-way disjunction, then on three `bool` toggles. None of that is
 *     presence-shaped — `discriminatorPresent` answers TRUE for `false` — so
 *     `BranchDiscriminator` gained `when`, and with it the obligation that
 *     every `when`-using command carry a cross-check parsing the real Rust.
 *     Its five arms include one nobody would enumerate by naming what IS
 *     there: `has_filters` splits the blank-query early return into an empty
 *     page and a filtered recency page. That is the third time this manifest
 *     has been extended by an arm defined by an ABSENCE (#3892's
 *     `key-presence` was the second).
 *   - `run_advanced_query` makes two INDEPENDENT routing choices that compose
 *     rather than exclude, which a single first-match chain cannot express at
 *     all, so `BranchSpec` became a list of dimensions. See `BranchDimension`
 *     for what that model claims (each arm of each switch ran) and what it
 *     does not (each COMBINATION ran).
 */
interface BranchDiscriminator {
  /** Human-readable branch name, used in coverage keys (`${command}::${branch}`)
   *  and failure messages. Must be unique across ALL of a command's dimensions. */
  branch: string
  /** Field name in the dimension's source object that selects this branch when
   *  present and non-empty (see `discriminatorPresent`) — the shape used when
   *  the Rust dispatches on `Option::is_some()` / `!Vec::is_empty()`. */
  field?: string
  /** With `field`: select this branch when that field's VALUE equals this
   *  literal — the shape used when the Rust dispatches on an ENUM
   *  (`match sort { PageSort::MostLinked => … }`), where every arm reads the
   *  same field and the arms differ by value, not by presence. */
  equals?: string
  /** Predicate over the whole source object, for a dispatch that is neither
   *  presence- nor value-shaped: a blank-STRING test, a disjunction over many
   *  fields, or a bare `bool`. `discriminatorPresent` reports a `false` bool as
   *  PRESENT (it is not null), so a toggle-driven arm cannot be expressed with
   *  `field` and must not be faked with one. Exactly one of `field` / `when`
   *  is declared; the guard below fails on both or neither.
   *
   *  A `when` predicate is hand-written TypeScript mirroring Rust, so it is the
   *  weakest link in the manifest — which is why every command using one also
   *  carries a cross-check below that parses the actual Rust dispatch. */
  when?: (bag: Record<string, unknown>) => boolean
}

/**
 * Where in a query step's `args` a dimension's discriminators live (#3892,
 * generalised to a PATH in #3927 so a nested DTO can be reached).
 *
 *  - `object` — the node at `path` is one discriminator-bearing object, and the
 *    step classifies to exactly ONE branch of this dimension. `path: []` is the
 *    args root (`search_blocks`, whose dispatch reads `query` AND `filter`);
 *    `['request']` is `list_blocks`; `['filter']` is
 *    `list_pages_with_metadata`.
 *  - `perElement` — the node at `path` is an ARRAY; EVERY element is classified
 *    and the step covers the UNION of their branches, because the composed SQL
 *    contains one predicate per element. That is WEAKER evidence than "all of
 *    them must be right for the recorded rows to be right": with several
 *    filters combined with AND, an over-broad predicate in one element can be fully
 *    MASKED by a stricter sibling element (the sibling alone would already
 *    narrow the result to the same rows), so per-element credit does not
 *    prove that specific element's predicate is correct in isolation — only
 *    that the union of branches it belongs to was exercised by SOME step. No
 *    live impact today: every recorded step carries exactly one filter, so
 *    there is no sibling to do the masking. A step that adds a SECOND filter
 *    to the same query needs to pin at least one row whose presence (or
 *    absence) depends on BOTH predicates being individually correct, not
 *    just their conjunction, or the credit is theater for that element. Zero
 *    elements ⇒ zero branches, NOT the default branch: the dispatch never ran
 *    (`filtered_blocks_query`).
 */
type BranchSource =
  | { readonly kind: 'object'; readonly path: readonly string[] }
  | { readonly kind: 'perElement'; readonly path: readonly string[] }

/**
 * ONE dispatch chain of a command (#3927). A command whose `_inner` makes a
 * single routing choice has one dimension; `run_advanced_query` makes several
 * INDEPENDENT ones (`group_by` and `has_fulltext` compose rather than exclude),
 * and a first-match chain cannot express that — it would credit `grouped` for a
 * grouped+full-text step and leave `fulltext` looking uncovered, or worse,
 * credit both arms of one switch from a step that exercised one.
 *
 * A step credits ONE branch per `object` dimension (or a set per `perElement`
 * one), so the units are the SUM of the dimensions' arms, not their PRODUCT.
 * That is the honest claim and it is weaker than it looks: "each arm of each
 * switch ran in some step" is not "each COMBINATION ran". Where a combination
 * is its own code path (`run_grouped` with `has_fulltext` reaches a different
 * bucket query than without), that path is not a unit here and must be tracked
 * as its own dimension or step — see the note under the manifest.
 */
interface BranchDimension {
  /** Which dispatch this models. Documentation only — the coverage key is
   *  `${command}::${branch}`, so branch names carry the identity. */
  name: string
  source: BranchSource
  discriminators: readonly BranchDiscriminator[]
  /** Branch name when none of `discriminators` matches (the terminal `else`). */
  defaultBranch: string
  /** Arg keys a step MUST spell for this dimension's classification to mean
   *  anything. Enforced by the shape guard below: without it, a step that
   *  simply forgot an arg falls through to `defaultBranch` and silently credits
   *  a branch it never drove. `list_blocks`'s `['request']` used to be
   *  hardcoded in that guard; it is declared per dimension now because
   *  `search_blocks` needs TWO keys (`query` decides the blank arms, `filter`
   *  the toggle ones) and a root-path source has no single node to null-check. */
  requiredArgs?: readonly string[]
}

interface BranchSpec {
  dimensions: readonly BranchDimension[]
}

/** Follow a `BranchSource` path into a step's args. An empty path is the args
 *  object itself. */
function resolvePath(args: Record<string, unknown>, keys: readonly string[]): unknown {
  let node: unknown = args
  for (const key of keys) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

// ── `search_blocks` dispatch predicates (#3927) ──────────────────────────────
//
// `fts::search_with_toggles` does NOT dispatch on field presence: its first two
// arms turn on `query.trim().is_empty()` crossed with a six-way disjunction,
// and the last three on three `bool` toggles. `discriminatorPresent` answers
// TRUE for `false`, so a `field`-shaped discriminator would credit the regex
// arm for `"isRegex": false` — the exact over-credit this manifest exists to
// stop. Hence `when` predicates, cross-checked against the Rust below.

/** Every `SearchFilter` field that makes `search_with_toggles`'s `has_filters`
 *  true. The first five are the disjuncts spelled out in `toggle_filter.rs`;
 *  the rest are the `SearchFilter` fields `prepare_metadata` folds into the
 *  `MetadataPredicates` whose `is_empty()` is the sixth disjunct. `scope` is
 *  deliberately absent — the backend always supplies a space, so it is not a
 *  USER filter and `has_filters` excludes it. So is every toggle: they select
 *  the MODE, not the candidate set. Cross-checked against BOTH Rust sites. */
const SEARCH_HAS_FILTERS_FIELDS: readonly string[] = [
  'parentId',
  'tagIds',
  'includePageGlobs',
  'excludePageGlobs',
  'blockTypeFilter',
  'stateFilter',
  'priorityFilter',
  'excludedStateFilter',
  'excludedPriorityFilter',
  'dueFilter',
  'scheduledFilter',
  'propertyFilters',
  'excludedPropertyFilters',
  'lastEdited',
]

function searchFilterOf(args: Record<string, unknown>): Record<string, unknown> {
  const f = args['filter']
  return typeof f === 'object' && f !== null && !Array.isArray(f)
    ? (f as Record<string, unknown>)
    : {}
}

/** `query.trim().is_empty()` — the FIRST thing the backend tests, before the
 *  mode branch, because neither FTS5 MATCH nor an empty regex can act on it. */
function searchQueryIsBlank(args: Record<string, unknown>): boolean {
  const q = args['query']
  return typeof q !== 'string' || q.trim() === ''
}

/** The `has_filters` disjunction. "Present" is `!is_empty()` for the `Vec`
 *  fields, so `tagIds: []` is no filter at all — the same distinction
 *  `discriminatorPresent` draws for `value_text_in` (#3892). */
function searchHasFilters(args: Record<string, unknown>): boolean {
  const filter = searchFilterOf(args)
  return SEARCH_HAS_FILTERS_FIELDS.some((f) => discriminatorPresent(filter[f]))
}

/** `SearchToggles::any()`. */
function searchAnyToggle(args: Record<string, unknown>): boolean {
  const filter = searchFilterOf(args)
  return (
    filter['caseSensitive'] === true || filter['wholeWord'] === true || filter['isRegex'] === true
  )
}

const QUERY_STEP_BRANCH_DISCRIMINATORS: Readonly<Record<string, BranchSpec>> = {
  list_blocks: {
    dimensions: [
      {
        name: 'filter_count exclusive chain',
        source: { kind: 'object', path: ['request'] },
        requiredArgs: ['request'],
        discriminators: [
          { field: 'dateRange', branch: 'agenda-range' },
          { field: 'date', branch: 'agenda-date' },
          { field: 'tagId', branch: 'by-tag' },
          { field: 'blockType', branch: 'by-type' },
        ],
        defaultBranch: 'children',
      },
    ],
  },
  // #3892 — the four mutually-exclusive VALUE SHAPES of one `PropertyFilter`,
  // in `filtered_blocks_query_inner`'s dispatch order. Each arm emits a
  // different WHERE predicate (`= ?` / `IN (SELECT value FROM json_each(?))` /
  // `= ?` on the date column / `>= ? AND < ?`), so a wrong arm returns the
  // wrong SET. All four arms funnel into the same `ORDER BY b.id ASC`, which
  // is why this is a predicate-correctness risk rather than the ordering risk
  // `list_blocks`'s arms carry — lower severity, same invisibility.
  filtered_blocks_query: {
    dimensions: [
      {
        name: 'PropertyFilter value shape',
        source: { kind: 'perElement', path: ['propertyFilters'] },
        discriminators: [
          { field: 'valueText', branch: 'value-text' },
          { field: 'valueTextIn', branch: 'value-text-in' },
          { field: 'valueDate', branch: 'value-date' },
          { field: 'valueDateRange', branch: 'value-date-range' },
        ],
        // The real fifth arm, not a synthetic catch-all: a filter carrying only
        // a `key` emits no value predicate at all, so the EXISTS is satisfied
        // by mere key presence (`Ok(String::new())`) — a distinct SQL shape
        // with its own way of being wrong.
        defaultBranch: 'key-presence',
      },
    ],
  },
  // #3927 — `keyset_for`'s five-arm `match PageSort`
  // (`src-tauri/src/commands/pages/metadata.rs`). Each arm picks a different
  // `SortKeyset`: the sort-key EXPRESSION, the keyset WHERE that resumes a
  // cursor page, and the cursor slot the anchor is stashed in. Unlike
  // `filtered_blocks_query`'s arms (which differ in WHICH rows come back),
  // these differ in WHAT ORDER — so a step that credits one of them without
  // `"ordered": true` is credit for nothing, and all five steps in
  // `query_pages_metadata_sorts.json` are ordered.
  //
  // The default branch is `sort-alphabetical` because `sort` is
  // `#[serde(default)]` over a `#[default] Alphabetical` enum: an OMITTED sort
  // key IS the alphabetical arm, not a sixth one. A step spelling
  // `"alphabetical"` explicitly falls through to the same branch.
  list_pages_with_metadata: {
    dimensions: [
      {
        name: 'PageSort keyset',
        source: { kind: 'object', path: ['filter'] },
        requiredArgs: ['filter'],
        discriminators: [
          { field: 'sort', equals: 'recently-modified', branch: 'sort-recently-modified' },
          { field: 'sort', equals: 'most-linked', branch: 'sort-most-linked' },
          { field: 'sort', equals: 'most-content', branch: 'sort-most-content' },
          { field: 'sort', equals: 'default', branch: 'sort-default' },
        ],
        defaultBranch: 'sort-alphabetical',
      },
    ],
  },
  // #3927 — `fts::search_with_toggles`'s arms, in ITS dispatch order (the
  // blank-query test runs BEFORE the mode branch). Five arms, not the four the
  // issue predicted: the blank-query early return is really two, because
  // `has_filters` splits it into "the empty page" and "the filtered recency
  // page" — the same shape of miss as #3892's fifth arm, an arm defined by
  // what is NOT present. The arms differ in FROM clause, ORDER BY and
  // pagination: `blank-filtered` and `regex` never touch FTS5 and order
  // `b.id DESC`, `regex` cannot paginate at all (`next_cursor: None`), and
  // `literal-post-filter` walks candidate WINDOWS so its `has_more` is
  // computed from survivors rather than from a `limit + 1` probe.
  search_blocks: {
    dimensions: [
      {
        name: 'search_with_toggles arm',
        source: { kind: 'object', path: [] },
        requiredArgs: ['query', 'filter'],
        discriminators: [
          {
            branch: 'blank-unfiltered',
            when: (a) => searchQueryIsBlank(a) && !searchHasFilters(a),
          },
          { branch: 'blank-filtered', when: (a) => searchQueryIsBlank(a) },
          { branch: 'regex', when: (a) => searchFilterOf(a)['isRegex'] === true },
          // COVERED-BUT-NOT-FALSIFIABLE, recorded rather than left to be
          // rediscovered. Deleting this arm from the Rust (so an
          // all-toggles-off query falls through to `literal-post-filter`
          // instead of short-circuiting to `search_fts`) leaves EVERY
          // conformance fixture green — verified by mutation, not assumed.
          // The arms really do differ, but every way they differ is invisible
          // to this harness:
          //
          //   - with no toggle on, `compose_literal_pattern` composes
          //     `(?i)<escaped query>`, which every FTS candidate already
          //     satisfies — EXCEPT where `fts_blocks.stripped` differs from
          //     raw `blocks.content` (markup stripped, `[[ULID]]` references
          //     resolved to names, NFC applied). That is the one falsifier,
          //     and the mock's FTS stand-in folds over raw `content`, so a
          //     fixture block shaped to exercise it would redden the MOCK leg
          //     for an unrelated reason. Lifting this needs the mock to model
          //     `strip_for_fts`, not another step;
          //   - the arms' other differences (`snippet` cleared vs kept,
          //     `match_offsets` populated, survivor-derived `has_more` vs a
          //     `limit + 1` probe) are not fields the query runner records.
          //
          // This is strictly weaker than `list_pages_with_metadata`'s
          // `sort-default`, which is often described the same way: THAT arm's
          // `b.id ASC` is byte-identical to the tiebreaker, so it cannot be
          // deleted — but MISROUTING it to a sibling keyset does redden
          // `pages_sorted_default`, so its routing is pinned. This arm's
          // deletion IS its misrouting (the fallthrough is the sibling), and
          // that is green. A branch whose deletion changes nothing OBSERVABLE
          // is not the same as a branch that does nothing, and the difference
          // has to be written down or the green ratchet claims evidence it
          // does not have.
          { branch: 'fts-match', when: (a) => !searchAnyToggle(a) },
        ],
        defaultBranch: 'literal-post-filter',
      },
    ],
  },
  // #3927 — the engine's two STRUCTURAL switches
  // (`agaric-store/src/query/engine.rs`), which are INDEPENDENT rather than
  // exclusive: `group_by` swaps the whole result shape (bucket rows +
  // `ROW_NUMBER() OVER (PARTITION BY …)` member preview + a different cursor
  // codec, with `rows` left empty), and `has_fulltext` swaps the FROM
  // (`blocks b` → `fts_blocks fts JOIN blocks b`), prefixes the MATCH, shifts
  // EVERY bind by one, populates `score` and flips the default sort. Two
  // dimensions, four units, credited independently — see `BranchDimension` for
  // why that is a sum and not a product.
  run_advanced_query: {
    dimensions: [
      {
        name: 'group_by dispatch',
        source: { kind: 'object', path: ['request'] },
        requiredArgs: ['request'],
        discriminators: [{ field: 'groupBy', branch: 'grouped' }],
        defaultBranch: 'flat',
      },
      {
        name: 'has_fulltext composition',
        source: { kind: 'object', path: ['request'] },
        requiredArgs: ['request'],
        // Presence, not blank-ness: `Some("")` sanitises to empty and the
        // engine REJECTS it (`AppError::Validation`) before either arm runs, so
        // a step spelling `"fulltext": ""` cannot record a green expectation to
        // mis-credit this branch with.
        discriminators: [{ field: 'fulltext', branch: 'fulltext' }],
        defaultBranch: 'no-fulltext',
      },
    ],
  },
}
// NOTE — `run_advanced_query`'s entry models its two STRUCTURAL switches and
// NOT the rest of its dispatch surface, which is large enough to need its own
// change and is listed here so the omission is a stated remainder rather than a
// silent cap (#3927):
//
//   - `resolve_sort` (`engine.rs:208`) — 6 arms (5 `SortColumn` variants, one
//     of which adds the `pages_cache` LEFT JOIN, plus `Relevance`), THEN a
//     conditional tail: an empty `sort` defaults to relevance-first WITH
//     full-text and to the `b.id DESC` recency keyset without, and the terminal
//     `b.id` tiebreaker is appended only when no `Created` key was supplied
//     (`has_id`). Every conformance step today supplies NO sort, so exactly one
//     of those arms has ever run — and the empty-sort default splits on
//     `has_fulltext`, i.e. it is a combination this sum-of-dimensions model
//     cannot express as a unit.
//   - `group_key_expr` (`engine.rs:1166`) — SEVEN arms behind the (waived)
//     `grouped` branch (`Tag` / `Page` / `State` / `BlockType` / `Priority` /
//     `Property` / `DateBucket`), the last of which sub-dispatches again on
//     `DateField`'s 4 variants crossed with `DateBucketUnit`. Counted off the
//     `GroupKey` enum (`query/mod.rs:159`), not estimated — an understated
//     remainder overstates coverage exactly as an inflated numerator does.
//   - the 5 aggregate ops (`AggOp` — `count` / `sum` / `avg` / `min` / `max`)
//     and the 15-leaf `FilterExpr` vocabulary this command accepts
//     (`QUERY_ALLOWED_KEYS`, `query/projection.rs`; `FilterPrimitive` itself
//     has 23 variants, but only 15 are reachable here), of which the four
//     `run_advanced_query` steps drive TWO (`State`, `DueDate`).
//
// Modelling `resolve_sort` needs a per-element dimension over `request.sort`
// whose DEFAULT arm is itself conditional, which the `defaultBranch: string`
// shape above cannot carry. Do that in the change that adds the sort steps.
// NOTE for whoever extends `filtered_blocks_query`'s entry: the four value
// shapes are ONE of two dispatch dimensions. The other is whether `pf.key` is
// a RESERVED key (`todo_state` / `priority` / `due_date` / `scheduled_date`),
// which routes to a direct `b.<col>` predicate instead of an `EXISTS` over
// `block_properties` — `queries.rs`'s `reserved_col` match. This manifest
// models only the value-shape dimension, so a step using a non-reserved key
// credits the arm for BOTH routings. That second dimension is not
// field-presence-shaped (it is a predicate over the `key` VALUE), so it does
// not fit `BranchDiscriminator` without a wider change; the cross-check below
// at least pins that the two routings dispatch on the same four shapes in the
// same order. Same class of one-level-down gap as the `agenda_source` note
// above.

/** All coverage UNITS a command decomposes into: `${command}::${branch}` for
 *  every declared branch of every dimension (discriminators + that dimension's
 *  default), or just `command` itself when it carries no branch manifest
 *  entry. */
function branchUnitsOf(command: string): string[] {
  const spec = QUERY_STEP_BRANCH_DISCRIMINATORS[command]
  if (!spec) return [command]
  const units: string[] = []
  for (const dim of spec.dimensions) {
    for (const d of dim.discriminators) units.push(`${command}::${d.branch}`)
    units.push(`${command}::${dim.defaultBranch}`)
  }
  return units
}

/** Does an args value SELECT its branch? Mirrors the Rust dispatch conditions:
 *  `Option::is_some()` for the scalar fields, `!Vec::is_empty()` for the list
 *  ones (`value_text_in`). An empty array is ABSENT to the backend — treating
 *  it as present would credit an arm the composed SQL never emitted. */
function discriminatorPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/** The one dimension of a single-dispatch command, for the cross-checks below.
 *  Throws rather than returning a default: a command that lost its manifest
 *  entry, or grew a second dimension, must fail LOUD in its own guard instead
 *  of letting the guard pass over nothing. */
function soleDimensionOf(command: string): BranchDimension {
  const spec = QUERY_STEP_BRANCH_DISCRIMINATORS[command]
  if (!spec) {
    throw new Error(`${command} must stay declared in QUERY_STEP_BRANCH_DISCRIMINATORS`)
  }
  if (spec.dimensions.length !== 1) {
    throw new Error(
      `${command} now declares ${spec.dimensions.length} dimensions; this guard cross-checks ` +
        `ONE dispatch chain against the Rust. Extend it to the new dimension rather than ` +
        `letting it read only the first.`,
    )
  }
  return spec.dimensions[0] as BranchDimension
}

/** Does one discriminator select `bag`? Mirrors the three Rust dispatch shapes
 *  a `BranchDiscriminator` can carry — see its field docs. */
function discriminatorMatches(d: BranchDiscriminator, bag: Record<string, unknown>): boolean {
  if (d.when) return d.when(bag)
  const v = bag[d.field as string]
  return d.equals === undefined ? discriminatorPresent(v) : v === d.equals
}

/** Classify one discriminator-bearing object (a request DTO, one element of a
 *  per-element array, or the args root) into its branch name for ONE
 *  dimension, mirroring the Rust `else if` chain: FIRST declared discriminator
 *  matching wins, none matching falls to `defaultBranch`. */
function classify(dim: BranchDimension, bag: Record<string, unknown>): string {
  for (const d of dim.discriminators) {
    if (discriminatorMatches(d, bag)) return d.branch
  }
  return dim.defaultBranch
}

/** Every coverage unit a query step exercises. Commands with no manifest entry
 *  classify to their own bare name (unchanged from pre-#3878 behavior). Each
 *  `object` dimension yields exactly one unit; each `perElement` dimension
 *  yields the union over the array (possibly EMPTY — see `BranchSource`). */
function stepBranchKeys(command: string, step: QueryStepShape): string[] {
  const spec = QUERY_STEP_BRANCH_DISCRIMINATORS[command]
  if (!spec) return [command]
  const args = step.args ?? {}
  const units = new Set<string>()
  for (const dim of spec.dimensions) {
    const node = resolvePath(args, dim.source.path)
    if (dim.source.kind === 'object') {
      const bag =
        typeof node === 'object' && node !== null && !Array.isArray(node)
          ? (node as Record<string, unknown>)
          : {}
      units.add(`${command}::${classify(dim, bag)}`)
      continue
    }
    if (!Array.isArray(node)) continue
    for (const el of node) {
      if (typeof el !== 'object' || el === null || Array.isArray(el)) continue
      units.add(`${command}::${classify(dim, el as Record<string, unknown>)}`)
    }
  }
  return [...units]
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
  const needle = 'let filter_count = ['
  const start = source.indexOf(needle)
  if (start < 0) {
    throw new Error(
      `could not find "let filter_count = [" in ${RUST_QUERIES_PATH} — this guard ` +
        `parses list_blocks_inner's exclusive-filter array; update the parser if the ` +
        `source moved, don't shrink the expectation.`,
    )
  }
  // Balance-scan the brackets from the opening `[`, mirroring
  // `extractRustCommandSignatures`'s paren-balancing above — a plain
  // `indexOf(']', start)` would stop at the FIRST `]`, which truncates (and
  // silently under-reports) the moment any element is itself an index
  // expression or a nested array literal.
  let depth = 0
  let end = -1
  for (let i = start + needle.length - 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) {
    throw new Error(`unterminated filter_count array in ${RUST_QUERIES_PATH}`)
  }
  return [...source.slice(start, end).matchAll(/(\w+)(?:\.is_some\(\))?/g)]
    .map((m) => m[1] as string)
    .filter((id) => id !== 'let' && id !== 'filter_count')
}

const RUST_COMMANDS_QUERIES_PATH = path.resolve(RUST_COMMANDS_DIR, 'commands', 'queries.rs')

/**
 * #3892 — the two places `filtered_blocks_query_inner` dispatches on which of
 * a `PropertyFilter`'s four value shapes is supplied. They are separate code,
 * not one helper called twice: a RESERVED key collapses to a direct
 * `b.<col>` predicate inline in the command, everything else goes through the
 * `EXISTS (… block_properties bp …)` helper. Both are parsed, because a
 * divergence BETWEEN them is itself a bug the single manifest entry would hide.
 *
 * Each site is read twice over:
 *
 *   - `guard` — the `n_text + n_text_in + n_date + n_range > 1` exclusivity
 *     check, i.e. the Rust source's own statement of which value fields are
 *     mutually exclusive (the analogue of `list_blocks_inner`'s `filter_count`);
 *   - `chain` — the `if let Some(…) = &pf.X { … } else if …` chain that
 *     actually selects the emitted SQL.
 *
 * Reading only the guard would miss a REORDERED chain, which is exactly the
 * drift that breaks `stepBranchKeys`'s first-match classification while leaving
 * the exclusive SET intact.
 */
const FBQ_VALUE_DISPATCH_SITES = [
  {
    label: 'property_value_predicate_sql (non-reserved key: EXISTS over bp.value_*)',
    fnNeedle: 'fn property_value_predicate_sql(',
    guardEnd: 'let sql_op = match pf.operator',
    chainEnd: 'Ok(String::new())',
  },
  {
    label: 'filtered_blocks_query_inner (reserved key: direct b.<col> predicate)',
    fnNeedle: 'pub async fn filtered_blocks_query_inner(',
    guardEnd: 'let sql_op = match pf.operator',
    chainEnd: 'continue;',
  },
] as const

interface FbqDispatchSite {
  label: string
  fnNeedle: string
  guardEnd: string
  chainEnd: string
}

/** Locate `[from, to)` in `source` by two needles, failing loud (never silently
 *  returning a short/empty slice — an under-read here would UNDER-report the
 *  dispatch arms, which is the exact failure mode this guard exists to catch). */
function rustSlice(source: string, from: number, endNeedle: string, what: string): string {
  const end = source.indexOf(endNeedle, from)
  if (end < 0) {
    throw new Error(
      `could not find ${JSON.stringify(endNeedle)} after offset ${from} in ` +
        `${RUST_COMMANDS_QUERIES_PATH} while reading ${what} — this guard parses the ` +
        `Rust dispatch; update the parser if the source moved, don't shrink the ` +
        `expectation.`,
    )
  }
  return source.slice(from, end)
}

/** `pf.value_*` identifiers in source order, first occurrence wins. */
function valueFieldsInOrder(slice: string): string[] {
  const seen: string[] = []
  for (const m of slice.matchAll(/pf\.(value_\w+)/g)) {
    const id = m[1] as string
    if (!seen.includes(id)) seen.push(id)
  }
  return seen
}

// #3930 review note 4 — `queries.rs` is ~1600 lines and every dispatch site
// re-reads it from disk; cache the one read across all sites/calls instead.
let rustCommandsQueriesSource: string | undefined

/** `commands/queries.rs`'s full source, read from disk once and cached for
 *  every caller in this file (currently just `extractFbqValueDispatch`, once
 *  per entry in `FBQ_VALUE_DISPATCH_SITES`). */
function readRustCommandsQueriesSource(): string {
  rustCommandsQueriesSource ??= readFileSync(RUST_COMMANDS_QUERIES_PATH, 'utf8')
  return rustCommandsQueriesSource
}

/** Parse one dispatch site's exclusivity guard and its `else if` chain out of
 *  `commands/queries.rs`. See `FBQ_VALUE_DISPATCH_SITES`. */
function extractFbqValueDispatch(site: FbqDispatchSite): { guard: string[]; chain: string[] } {
  const source = readRustCommandsQueriesSource()
  const fnAt = source.indexOf(site.fnNeedle)
  if (fnAt < 0) {
    throw new Error(
      `could not find ${JSON.stringify(site.fnNeedle)} in ${RUST_COMMANDS_QUERIES_PATH} — ` +
        `this guard parses ${site.label}; update the parser if the source moved.`,
    )
  }
  const guardSlice = rustSlice(source, fnAt, site.guardEnd, `${site.label}'s exclusivity guard`)
  // The guard is the run of `i32::from(… pf.value_* …)` initialisers feeding
  // the `> 1` sum, so read only those — a bare `pf.value_*` scan over the same
  // slice would also pick up doc-comment or signature mentions.
  const guard: string[] = []
  for (const m of guardSlice.matchAll(/i32::from\([^)]*pf\.(value_\w+)/g)) {
    guard.push(m[1] as string)
  }
  const chainStart = fnAt + guardSlice.length
  const chain = valueFieldsInOrder(
    rustSlice(source, chainStart, site.chainEnd, `${site.label}'s value-shape dispatch chain`),
  )
  return { guard, chain }
}

// ---------------------------------------------------------------------------
// #3927 — Rust dispatch parsers for the three commands added by this change
// ---------------------------------------------------------------------------

const RUST_PAGES_METADATA_PATH = path.resolve(RUST_COMMANDS_DIR, 'commands', 'pages', 'metadata.rs')
// `RUST_COMMANDS_DIR` is `src-tauri/src`, so one `..` reaches the crate root.
const AGARIC_STORE_SRC = path.resolve(RUST_COMMANDS_DIR, '..', 'agaric-store', 'src')
const RUST_TOGGLE_FILTER_PATH = path.resolve(AGARIC_STORE_SRC, 'fts', 'toggle_filter.rs')
const RUST_METADATA_FILTER_PATH = path.resolve(AGARIC_STORE_SRC, 'fts', 'metadata_filter.rs')
const RUST_QUERY_ENGINE_PATH = path.resolve(AGARIC_STORE_SRC, 'query', 'engine.rs')

const rustSourceCache = new Map<string, string>()

/** One cached read per Rust file — several guards below parse the same source. */
function readRustSource(file: string): string {
  let source = rustSourceCache.get(file)
  if (source === undefined) {
    source = readFileSync(file, 'utf8')
    rustSourceCache.set(file, source)
  }
  return source
}

/**
 * The `{ … }` body of a Rust item, located by a needle and brace-balanced from
 * the first `{` after it. Balanced rather than terminated by a marker so a
 * guard can never silently read a SHORT slice and under-report the arms it is
 * there to count — the failure mode `extractFilterCountIdentifiers`'s
 * bracket-balance comment names.
 *
 * Brace-balancing is naive about braces inside string literals; that is safe
 * for every site parsed here because each such literal (`?{S}` in the
 * `RecentlyModified` key template, the `format!`s) is itself balanced. A site
 * with an UNBALANCED brace in a string would throw or over-read, loudly.
 */
function rustItemBody(file: string, needle: string): string {
  const source = readRustSource(file)
  const at = source.indexOf(needle)
  if (at < 0) {
    throw new Error(
      `could not find ${JSON.stringify(needle)} in ${file} — this guard parses the Rust ` +
        `dispatch; update the parser if the source moved, don't shrink the expectation.`,
    )
  }
  const open = source.indexOf('{', at)
  if (open < 0) throw new Error(`no block opens after ${JSON.stringify(needle)} in ${file}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unterminated block after ${JSON.stringify(needle)} in ${file}`)
}

/** Distinct `Enum::Variant` names in source order, first occurrence wins. */
function variantsInOrder(slice: string, enumName: string): string[] {
  const seen: string[] = []
  for (const m of slice.matchAll(new RegExp(`${enumName}::(\\w+)`, 'g'))) {
    const id = m[1] as string
    if (!seen.includes(id)) seen.push(id)
  }
  return seen
}

/**
 * The THREE places `list_pages_with_metadata_inner` matches on `PageSort`. A
 * single manifest entry is honest only while they agree: `keyset_for` picks the
 * ORDER BY + keyset WHERE, `sort_discriminator` stamps the cursor's sort tag
 * (the `RequiresRefresh` rejection keys on it), and `build_metadata_response`
 * picks which cursor SLOT the anchor value is written to. A variant added to
 * one and missed in another is a live bug — a cursor that round-trips into the
 * wrong keyset — so the guard compares all three to each other, not just to
 * the manifest.
 */
const PAGE_SORT_MATCH_SITES = [
  { label: 'keyset_for (ORDER BY + keyset WHERE)', needle: 'fn keyset_for(sort: PageSort)' },
  {
    label: 'sort_discriminator (cursor sort tag)',
    needle: 'fn sort_discriminator(sort: PageSort)',
  },
  { label: 'build_metadata_response (cursor slot)', needle: 'fn build_metadata_response(' },
] as const

/**
 * `fts::search_with_toggles`'s arm dispatch, read out of the Rust three ways:
 *
 *  - `hasFilterDisjuncts` — the base identifier of every `||`-separated TERM of
 *    the `let has_filters = …;` expression, i.e. the source's own statement of
 *    what turns the blank-query early return into the filtered recency page.
 *    Read term-by-term rather than by scanning for identifier shapes, so a
 *    disjunct this parser does not recognise fails the comparison instead of
 *    vanishing from it (see the note at the split);
 *  - `metadataFields` — the `SearchFilter` fields `prepare_metadata_with_today`
 *    reads, which is what `metadata.is_empty()` (the sixth disjunct) expands
 *    to. Parsed from `metadata_filter.rs` because `toggle_filter.rs` only sees
 *    the collapsed `MetadataPredicates`;
 *  - `armOrder` — the offsets of the three dispatch conditions, so a reordered
 *    chain fails loud. `stepBranchKeys` classifies by FIRST match, and this
 *    command's order is load-bearing in a way the others' is not: the
 *    blank-query test runs BEFORE the mode branch, so moving `is_regex` above
 *    it would re-label every blank-query step.
 */
function extractSearchTogglesDispatch(): {
  hasFilterDisjuncts: string[]
  metadataFields: string[]
  armOrder: string[]
} {
  const body = rustItemBody(RUST_TOGGLE_FILTER_PATH, 'pub async fn search_with_toggles(')
  const letAt = body.indexOf('let has_filters =')
  const semi = body.indexOf(';', letAt)
  if (letAt < 0 || semi < 0) {
    throw new Error(
      `could not find the \`let has_filters = …;\` disjunction in ${RUST_TOGGLE_FILTER_PATH} — ` +
        `this guard parses it; update the parser if the source moved.`,
    )
  }
  // Split on `||` FIRST, then read the base identifier of each term — rather
  // than regex-scanning the whole expression for `<ident>.` / `<ident>)`
  // shapes. The scanning form matched only identifiers followed by a `.` or a
  // `)`, so a disjunct that is a BARE bool (`|| some_flag;`) contributed
  // nothing and this guard stayed green while `has_filters` had grown an arm
  // — the precise failure this cross-check exists to stop, one level down.
  // Term-splitting cannot miss a disjunct: every `||` yields a term, and a
  // term that yields no identifier (or an unexpected one) fails the
  // comparison below LOUD.
  //
  // Splitting on `||` is safe for the closures in this expression (`|t|` is
  // two single pipes, not a `||`); a zero-argument closure would split into
  // garbage terms, which also fails loud rather than silently under-reporting.
  const hasFilterDisjuncts = body
    .slice(letAt + 'let has_filters ='.length, semi)
    .split('||')
    .map((term) => term.replaceAll(/[\s!(]/g, ''))
    .filter((term) => term !== '')
    // The BASE identifier of the term: `parent_id.is_some()` → `parent_id`,
    // `!metadata.is_empty()` → `metadata`, a bare `some_flag` → `some_flag`.
    .map((term) => /^\w+/.exec(term)?.[0] ?? term)

  const prepared = rustItemBody(RUST_METADATA_FILTER_PATH, 'pub fn prepare_metadata_with_today(')
  const metadataFields = [
    ...new Set([...prepared.matchAll(/filter\.(\w+)/g)].map((m) => m[1] as string)),
  ]

  const markers = [
    ['blank-query', 'if query.trim().is_empty()'],
    ['regex', 'if toggles.is_regex'],
    ['no-toggle', 'if !toggles.any()'],
  ] as const
  const located = markers.map(([label, needle]) => {
    const at = body.indexOf(needle)
    if (at < 0) {
      throw new Error(
        `could not find ${JSON.stringify(needle)} inside search_with_toggles — this guard ` +
          `parses the arm dispatch; update the parser if the source moved.`,
      )
    }
    return { label, at }
  })
  // Sorted by OFFSET, so the returned sequence IS the Rust chain's order: a
  // reordered chain yields a different list rather than the declared one.
  const armOrder = located.toSorted((x, y) => x.at - y.at).map((m) => m.label)
  return { hasFilterDisjuncts, metadataFields, armOrder }
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
  ops: Array<{ command: string; args?: Record<string, unknown> }>
  /** #3347 — post-op READ steps (see `conformance-query.ts`). */
  queries?: Array<QueryStepShape>
  /** #3347 — the backend-authored projection of each `queries` step. */
  expected_queries?: Array<{ name: string; rows: string[]; error?: string | null }>
  /** Additive, replay-inert string tags declaring which scenarios this fixture
   *  pins (see `REQUIRED_SCENARIOS`). Absent on fixtures that predate the tag. */
  scenarios?: string[]
  /** #3965 — the seed and the backend-authored snapshot, read (not replayed)
   *  so a required scenario can be checked STRUCTURALLY rather than by its
   *  label. */
  seed?: { blocks?: Array<Record<string, unknown>> }
  expected?: ExpectedSnapshot | null
}

/** The sections of a fixture's `expected` the scenario predicates consult. */
interface ExpectedSnapshot {
  blocks: Array<Record<string, unknown>>
  properties: Array<Record<string, unknown>>
  block_tags: Array<Record<string, unknown>>
}

interface QueryStepShape {
  name: string
  command: string
  /** Opt-in declaration that this step's recorded `rows` is legitimately empty
   *  (see the vacuity guard below). Ignored by both query runners. */
  expect_empty?: boolean
  /** #3833 item 3 — required alongside `expect_empty: true` (enforced below):
   *  which NEGATIVE the empty result pins. `expect_empty` is an escape hatch
   *  from the vacuity guard, and a bare `true` with no justification lets a
   *  fixture author wave off a step that is empty by MISTAKE as easily as one
   *  that is empty on purpose. Every current `expect_empty` step already
   *  carries one by convention; this makes the convention a gate. Ignored by
   *  both query runners, like `expect_empty` itself. */
  comment?: string
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
  expectedQueries: Array<{ name: string; rows: string[]; error?: string | null }>
  scenarios: Set<string>
  /** #3965 — ops WITH their args, the seed block table, the recorded snapshot,
   *  and the seed-label → canonical-label map, which together are what a
   *  scenario predicate needs to check a behaviour instead of a tag. */
  ops: Array<{ command: string; args: Record<string, unknown> }>
  seedBlocks: Array<Record<string, unknown>>
  expected: ExpectedSnapshot | null
  /** `'S2'` → `'B2'`. Canonical labels are assigned in SEED ORDER by both
   *  runners (`canonicalOrder` / `build_snapshot_with_order`), so the map is
   *  positional — NOT a numeric coincidence between the two naming schemes,
   *  which a fixture is free to break. */
  label: (seedId: string) => string | null
}

// ---------------------------------------------------------------------------
// Row-token sentinels (#3833 items 9/10)
// ---------------------------------------------------------------------------

/**
 * The fallback strings BOTH `conformance_query.rs`'s `run_step` (`ids_in`'s
 * `<missing-id>`, `property_token`'s `<missing-key>`, `scalar_tokens`'s
 * `<not-a-string>`, the `list_page_links` edge projection's `?`) and the TS
 * twin's `WIRE`-driven equivalents (`idToken`, `propertyToken`, `rowToken`'s
 * scalar branch, the same edge fallback) mint when a row is missing the key a
 * projector expects. A row token that carries one of these is not fixture
 * data — it is a projector reading the wrong key, on BOTH stacks identically,
 * so the differential compares two copies of the same placeholder instead of
 * real rows.
 */
const ROW_SENTINELS = new Set(['<missing-id>', '<missing-key>', '<not-a-string>', '?'])

/**
 * A raw, UNRELABELLED block id — 26 Crockford-base32 characters, the shape
 * both stacks' ids take before `relabel_token` / `relabelToken` swap them for
 * a canonical `B<n>` label.
 *
 * `relabel_head` falls back to the raw string when an id is absent from the
 * label map ("An id with no canonical label passes through unchanged so a leak
 * is visible rather than silently dropped" — `conformance_query.rs`'s module
 * doc). #3833 item 10's point is that "visible" meant visible to a HUMAN
 * reading the fixture; nothing failed on it. This is the gate.
 */
const RAW_ID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Split a relabeled row token into its comparable atoms, the same way
 * `relabel_token` / `relabelToken` do: the HEAD (or its two `->` sides, for a
 * pair token) and every attribute VALUE. Attribute NAMES are not atoms —
 * neither relabeller touches them.
 */
function tokenAtoms(token: string): { heads: string[]; values: string[] } {
  const [head, ...attrs] = token.split('#')
  return {
    heads: (head ?? token).split('->'),
    values: attrs.map((a) => {
      const eq = a.indexOf('=')
      return eq < 0 ? a : a.slice(eq + 1)
    }),
  }
}

/**
 * The [`ROW_SENTINELS`] carried by a token, matched by exact segment equality
 * against its HEAD atoms only.
 *
 * Heads only, deliberately. All four sentinels are minted at a head position
 * and nowhere else — `idToken`'s id, `propertyToken`'s key, `rowToken`'s
 * scalar (which IS the whole token), and the `pair` branch's two arrow sides.
 * `attrValue` / `attr_value` mint none of them. Scanning attribute VALUES too
 * therefore adds no coverage and does add a false positive: `attr_value`
 * forbids only `#` and `->` in a rendered value, so a property whose
 * `value_text` is the single character `?` is legal fixture content that the
 * wider check would report as a projector fault. An earlier revision of this
 * comment asserted the opposite — that none of the four "is producible by any
 * content the row-token guards allow through" — which is exactly the kind of
 * overclaim about a guard's reach that #3712 was filed for.
 */
function rowSentinelHits(token: string): string[] {
  return tokenAtoms(token).heads.filter((seg) => ROW_SENTINELS.has(seg))
}

/**
 * Atoms of a token that are still a raw 26-char id — heads AND attribute
 * values, since `relabel_head` is applied to both and an id-valued attribute
 * (`page_id`, `parent_id`, a `Ref` property) leaks the same way a head does.
 *
 * Deliberately WIDER than [`rowSentinelHits`], which went heads-only for the
 * opposite reason (#3980 note 4). The asymmetry is not an oversight: the four
 * sentinels are minted at head positions and nowhere else, so scanning values
 * for them buys nothing, whereas a raw id genuinely does reach an attribute
 * value and is stack-local there too. The cost is the same class of false
 * positive the sentinel check just shed — a `value_text` that happens to be
 * 26 Crockford characters is legal fixture content and is reported here. That
 * is judged worth paying, because an unrelabelled id in an attribute makes the
 * differential compare noise exactly as one in a head does; but the two cases
 * have DIFFERENT fixes, so the failure message must distinguish them.
 */
function rawIdHits(token: string): string[] {
  const { heads, values } = tokenAtoms(token)
  return [...heads, ...values].filter((seg) => RAW_ID_SEGMENT.test(seg))
}

function loadFixtures(): LoadedFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .toSorted()
    .map((f) => {
      const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as FixtureShape
      const seedBlocks = raw.seed?.blocks ?? []
      const labels = new Map<string, string>(
        seedBlocks.map((b, i) => [b['id'] as string, `B${i + 1}`]),
      )
      return {
        name: raw.name,
        opCommands: new Set(raw.ops.map((o) => o.command)),
        queryCommands: new Set((raw.queries ?? []).map((q) => q.command)),
        querySteps: raw.queries ?? [],
        expectedQueries: raw.expected_queries ?? [],
        scenarios: new Set(raw.scenarios ?? []),
        ops: raw.ops.map((o) => ({ command: o.command, args: o.args ?? {} })),
        seedBlocks,
        expected: raw.expected ?? null,
        label: (seedId: string) => labels.get(seedId) ?? null,
      }
    })
}

// ---------------------------------------------------------------------------
// #3964 — checkable waiver citations
// ---------------------------------------------------------------------------

/** Every reason-carrying manifest in this file, by the name the failure prints. */
const WAIVER_LISTS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
  ['NO_FIXTURE_ALLOWLIST', NO_FIXTURE_ALLOWLIST],
  ['READ_NO_QUERY_ALLOWLIST', READ_NO_QUERY_ALLOWLIST],
  ['READ_QUERY_BRANCH_ALLOWLIST', READ_QUERY_BRANCH_ALLOWLIST],
  ['QUERY_STEPS_BACKEND_ONLY', QUERY_STEPS_BACKEND_ONLY],
]

/**
 * An artifact a waiver reason points at: a sibling (or `src/`-relative) test
 * file, or a `conformance/fixtures` JSON.
 *
 * `via` is the explicit indirect form — `revert.test.ts (via applyRevertForOp)`
 * — for the case a cited test reaches the waived command through a shared
 * primitive and so never spells the command's name. It is an escape hatch from
 * the RELEVANCE check only: the file must still exist, and it must still
 * mention the symbol the reason redirects to, so the redirect is itself
 * checked rather than merely asserted.
 */
interface Citation {
  file: string
  via: string | null
}

/**
 * `<path>.test.ts[x]` or `<name>.json`, each optionally followed by
 * `(via <symbol>)`. Both shapes are already the conventions in use — this
 * makes them load-bearing rather than decorative.
 */
const CITATION_RE = /([\w./-]*[\w-]+\.(?:test\.tsx?|json))(?:\s*\(via\s+([\w.]+)\))?/g

function citationsIn(reason: string): Citation[] {
  return [...reason.matchAll(CITATION_RE)].map((m) => ({
    file: m[1] as string,
    via: (m[2] as string | undefined) ?? null,
  }))
}

const CONFORMANCE_FIXTURES_DIR = FIXTURES_DIR
const MOCK_TESTS_DIR = import.meta.dirname
const SRC_DIR = path.resolve(import.meta.dirname, '..', '..', '..')

/** Absolute path of a cited artifact, or `null` when nothing resolves. */
function resolveCitation(cite: Citation): string | null {
  const candidates = cite.file.endsWith('.json')
    ? [path.resolve(CONFORMANCE_FIXTURES_DIR, cite.file)]
    : [path.resolve(MOCK_TESTS_DIR, cite.file), path.resolve(SRC_DIR, cite.file)]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * What the cited artifact must MENTION for the citation to be relevant.
 *
 * For a test file: the waived command's own name — a test that covers
 * `set_property_batch` calls it.
 *
 * For a fixture JSON the rule cannot be the same, and getting this wrong would
 * make the whole check decorative. A fixture is never cited for the command it
 * waives — that is precisely why the command needs a waiver. It is cited for
 * the SINGLE-OP command the waived one is a batch of, or composes:
 * `add_tags_by_ids: 'batch of add_tag (tag_add_remove.json)'`. So the needles
 * are the OTHER bindings commands the reason names, and the fixture must drive
 * at least one of them. A reason that cites a fixture without naming any
 * command the fixture drives is claiming a relationship it has not stated.
 *
 * The reason is scanned with its CITATIONS REMOVED, which is not a detail. A
 * fixture is conventionally named after the op it drives, so
 * `restore_block.json` contains the substring `restore_block` — and scanning
 * the raw reason let EVERY fixture citation satisfy itself off its own
 * filename, making this half of the guard unfalsifiable. Found only by running
 * the relevance falsification (repointing `add_tags_by_ids` at an unrelated
 * fixture) and getting a green, which is the whole argument for demonstrating
 * a guard red rather than observing that it passes.
 */
function relevanceNeedles(cite: Citation, command: string, reason: string): string[] {
  if (!cite.file.endsWith('.json')) return [command]
  const prose = reason.replaceAll(CITATION_RE, ' ')
  const named = extractBindingsCommandNames().filter(
    (c) => c !== command && new RegExp(`\\b${c}\\b`).test(prose),
  )
  // `"command": "<name>"` is how a fixture's ops spell the command, so a bare
  // `includes` on the quoted form cannot be satisfied by a description that
  // merely talks about it.
  return named.map((c) => `"command": "${c}"`)
}

// ---------------------------------------------------------------------------
// Required-scenario manifest
// ---------------------------------------------------------------------------

/** The four block columns a reserved property key routes to. */
const RESERVED_COLUMNS = ['todo_state', 'priority', 'due_date', 'scheduled_date'] as const

function opsOf(fx: LoadedFixture, command: string): Array<{ args: Record<string, unknown> }> {
  return fx.ops.filter((o) => o.command === command)
}

function argStr(args: Record<string, unknown>, key: string): string | null {
  return typeof args[key] === 'string' ? (args[key] as string) : null
}

/** The canonical label of the seed block an op arg names, or `null`. */
function argLabel(fx: LoadedFixture, args: Record<string, unknown>, key: string): string | null {
  const seedId = argStr(args, key)
  return seedId === null ? null : fx.label(seedId)
}

function blockRow(fx: LoadedFixture, label: string): Record<string, unknown> | undefined {
  return fx.expected?.blocks.find((b) => b['id'] === label)
}

/** Every seed block reachable downward from `seedId`, itself excluded. Cycle-guarded. */
function seedDescendants(fx: LoadedFixture, seedId: string): string[] {
  const out: string[] = []
  const frontier = [seedId]
  const seen = new Set<string>([seedId])
  while (frontier.length > 0) {
    const cursor = frontier.pop() as string
    for (const b of fx.seedBlocks) {
      const id = b['id'] as string
      if (b['parent_id'] !== cursor || seen.has(id)) continue
      seen.add(id)
      out.push(id)
      frontier.push(id)
    }
  }
  return out
}

/** The canonical label of the root PAGE above a seed block, or `null`. */
function seedPageLabel(fx: LoadedFixture, seedId: string): string | null {
  let cursor: string | null = seedId
  const seen = new Set<string>()
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor)
    const row = fx.seedBlocks.find((b) => b['id'] === cursor)
    if (!row) return null
    if (row['block_type'] === 'page') return fx.label(cursor)
    cursor = (row['parent_id'] as string | null) ?? null
  }
  return null
}

/** `blockId→tagId` identity of a tag op, in SEED labels. */
function tagPair(args: Record<string, unknown>): string | null {
  const b = argStr(args, 'blockId')
  const t = argStr(args, 'tagId')
  return b === null || t === null ? null : `${b}→${t}`
}

interface ScenarioRequirement {
  op: string
  scenario: string
  /** What `holds` demands, in one clause, printed verbatim in the failure. */
  demands: string
  /** Does this fixture's SEED + OPS + recorded snapshot actually exhibit the
   *  scenario? Non-optional by design — see the note above. */
  holds: (fx: LoadedFixture) => boolean
}

/**
 * Each entry MUST be pinned by at least one fixture that (a) declares the
 * `scenario` string in its top-level `scenarios` array, (b) drives `op` in its
 * `ops`, and (c) satisfies `holds`.
 *
 * ## Why (c) exists (#3965)
 *
 * (a) and (b) were the whole check, and between them they compare a LABEL to a
 * LABEL: a fixture was credited for `tag-dedupe-lww` because its own
 * `scenarios` array contained the string `tag-dedupe-lww` and because it
 * happened to drive `add_tag`. Nothing consulted the behaviour. A fixture
 * tagged `tag-dedupe-lww` that adds one tag once satisfied it completely, and
 * so did one whose `expected` was recorded by `CONFORMANCE_UPDATE=1` after the
 * dedupe logic broke — the snapshot then encodes the break and the scenario
 * reports as covered. That is an assertion that cannot fail, sitting on the
 * sixteen behaviours chosen precisely because they must not regress.
 *
 * ## What (c) does and does not prove
 *
 * `holds` is a STRUCTURAL predicate over the fixture's seed, its op args, and
 * the recorded snapshot. It proves the fixture is SHAPED like the scenario —
 * that two identical adds are present for a dedupe claim, that a purge names a
 * block with descendants for a subtree claim, that the block a reserved-key
 * delete named ends with a null column while a sibling keeps its own. It does
 * NOT prove the recorded `expected` is CORRECT; the backend authors that, and
 * only a mutation on the production line would settle it (option 2 in #3965,
 * left for #3963's mechanism). Saying which of the two this is matters more
 * than the check itself: this closes "the label is the evidence", not "the
 * recording is right".
 *
 * ## The rule that keeps it from decaying
 *
 * `holds` is not optional, so a new tuple cannot be added label-only. And every
 * predicate must DISCRIMINATE — its own test below fails any predicate that
 * returns true for every fixture in the corpus, which is what a `() => true`
 * written to get past the type looks like from the outside.
 *
 * Each predicate must also say something the (a)+(b) pair does not. "Drives
 * `purge_block`" is already checked by (b); a `holds` that re-states it is an
 * assertion restating its own precondition, and is worse than no predicate
 * because it reads as one.
 */
const REQUIRED_SCENARIOS: ReadonlyArray<ScenarioRequirement> = [
  {
    op: 'create_block',
    scenario: 'dense-1based-position',
    demands:
      'two or more create_block ops under the SAME parent, whose children then occupy a ' +
      'contiguous 1-based position run in `expected`',
    holds: (fx) => {
      const parents = opsOf(fx, 'create_block')
        .map((o) => argStr(o.args, 'parentId'))
        .filter((p): p is string => p !== null)
      const shared = parents.find((p) => parents.filter((q) => q === p).length >= 2)
      if (shared === undefined) return false
      const parentLabel = fx.label(shared)
      if (parentLabel === null) return false
      const positions = (fx.expected?.blocks ?? [])
        .filter((b) => b['parent_id'] === parentLabel)
        .map((b) => b['position'] as number)
        .toSorted((a, b) => a - b)
      return positions.length >= 2 && positions.every((p, i) => p === i + 1)
    },
  },
  {
    op: 'delete_block',
    scenario: 'soft-delete-tombstone',
    demands: 'a delete_block whose target is STILL PRESENT in `expected` carrying a tombstone',
    holds: (fx) =>
      opsOf(fx, 'delete_block').some((o) => {
        const label = argLabel(fx, o.args, 'blockId')
        if (label === null) return false
        const row = blockRow(fx, label)
        return row !== undefined && row['deleted_at'] !== null
      }),
  },
  {
    op: 'delete_block',
    scenario: 'cascade-active-subtree',
    demands: 'ONE delete_block op that leaves two or more blocks tombstoned in `expected`',
    holds: (fx) =>
      opsOf(fx, 'delete_block').length === 1 &&
      (fx.expected?.blocks ?? []).filter((b) => b['deleted_at'] !== null).length >= 2,
  },
  {
    op: 'restore_block',
    scenario: 'same-cohort-restore',
    demands:
      'a restore_block whose target is ACTIVE in `expected` while some other block stays ' +
      'tombstoned — the independently-deleted descendant the cohort must not sweep up',
    holds: (fx) => {
      const restored = opsOf(fx, 'restore_block')
        .map((o) => argLabel(fx, o.args, 'blockId'))
        .filter((l): l is string => l !== null)
      if (restored.length === 0) return false
      const allActive = restored.every((l) => blockRow(fx, l)?.['deleted_at'] === null)
      const survivorTombstone = (fx.expected?.blocks ?? []).some(
        (b) => b['deleted_at'] !== null && !restored.includes(b['id'] as string),
      )
      return allActive && survivorTombstone
    },
  },
  {
    op: 'purge_block',
    scenario: 'hard-delete-removes-row',
    demands: 'a purge_block whose target seed block is GONE from `expected.blocks`',
    holds: (fx) =>
      opsOf(fx, 'purge_block').some((o) => {
        const label = argLabel(fx, o.args, 'blockId')
        return label !== null && blockRow(fx, label) === undefined
      }),
  },
  {
    op: 'add_tag',
    scenario: 'tag-dedupe-lww',
    demands:
      'two add_tag ops for the SAME (block, tag) pair — without them there is nothing to dedupe',
    holds: (fx) => {
      const pairs = opsOf(fx, 'add_tag')
        .map((o) => tagPair(o.args))
        .filter((p): p is string => p !== null)
      return pairs.some((p, i) => pairs.indexOf(p) !== i)
    },
  },
  {
    op: 'remove_tag',
    scenario: 'tag-remove-single-edge',
    demands:
      'a remove_tag whose edge is gone from `expected.block_tags` while ANOTHER edge on the ' +
      'same block survives — a remove that dropped every edge would satisfy a weaker check',
    holds: (fx) =>
      opsOf(fx, 'remove_tag').some((o) => {
        const b = argLabel(fx, o.args, 'blockId')
        const t = argLabel(fx, o.args, 'tagId')
        if (b === null || t === null) return false
        const edges = fx.expected?.block_tags ?? []
        const removed = !edges.some((e) => e['block_id'] === b && e['tag_id'] === t)
        const survivor = edges.some((e) => e['block_id'] === b && e['tag_id'] !== t)
        return removed && survivor
      }),
  },
  {
    op: 'add_tag',
    scenario: 'tag-readd-after-remove',
    demands:
      'add → remove → add on one (block, tag) pair IN THAT ORDER, with the edge present in ' +
      '`expected.block_tags` at the end',
    holds: (fx) =>
      fx.ops.some((first, i) => {
        if (first.command !== 'add_tag') return false
        const pair = tagPair(first.args)
        if (pair === null) return false
        const rest = fx.ops.slice(i + 1)
        const removedAt = rest.findIndex(
          (o) => o.command === 'remove_tag' && tagPair(o.args) === pair,
        )
        if (removedAt < 0) return false
        const readded = rest
          .slice(removedAt + 1)
          .some((o) => o.command === 'add_tag' && tagPair(o.args) === pair)
        if (!readded) return false
        const b = argLabel(fx, first.args, 'blockId')
        const t = argLabel(fx, first.args, 'tagId')
        return (fx.expected?.block_tags ?? []).some((e) => e['block_id'] === b && e['tag_id'] === t)
      }),
  },
  {
    op: 'set_property',
    scenario: 'property-typed-value-columns',
    demands:
      'set_property ops writing three or more DISTINCT `value_*` columns, and three or more ' +
      'distinct `value_type`s recorded in `expected.properties`',
    holds: (fx) => {
      const fields = new Set<string>()
      for (const o of opsOf(fx, 'set_property')) {
        const value = (o.args['value'] as Record<string, unknown> | undefined) ?? {}
        for (const [k, v] of Object.entries(value)) {
          if (k.startsWith('value_') && v !== null) fields.add(k)
        }
      }
      const types = new Set((fx.expected?.properties ?? []).map((p) => p['value_type'] as string))
      return fields.size >= 3 && types.size >= 3
    },
  },
  {
    op: 'delete_property',
    scenario: 'delete-one-of-many-properties',
    demands:
      'a delete_property on a block that carried two or more keys, whose key is gone from ' +
      '`expected.properties` while at least one sibling key on the same block survives',
    holds: (fx) =>
      opsOf(fx, 'delete_property').some((o) => {
        const seedId = argStr(o.args, 'blockId')
        const key = argStr(o.args, 'key')
        const label = argLabel(fx, o.args, 'blockId')
        if (seedId === null || key === null || label === null) return false
        const keysOnBlock = new Set(
          opsOf(fx, 'set_property')
            .filter((s) => argStr(s.args, 'blockId') === seedId)
            .map((s) => argStr(s.args, 'key')),
        )
        if (keysOnBlock.size < 2) return false
        const rows = (fx.expected?.properties ?? []).filter((p) => p['block_id'] === label)
        return rows.length > 0 && !rows.some((p) => p['key'] === key)
      }),
  },
  {
    op: 'move_block',
    scenario: 'move-cross-page-retains-property',
    demands:
      'a move_block that lands the target on a DIFFERENT page than its seed page (its ' +
      '`page_id` in `expected` changed) while it still owns a property row',
    holds: (fx) =>
      opsOf(fx, 'move_block').some((o) => {
        const seedId = argStr(o.args, 'blockId')
        const label = argLabel(fx, o.args, 'blockId')
        if (seedId === null || label === null) return false
        const row = blockRow(fx, label)
        const seedPage = seedPageLabel(fx, seedId)
        if (row === undefined || seedPage === null || row['page_id'] === seedPage) return false
        return (fx.expected?.properties ?? []).some((p) => p['block_id'] === label)
      }),
  },
  {
    op: 'set_todo_state',
    scenario: 'agenda-reserved-columns',
    demands: 'a block ending with two or more of the four reserved agenda columns non-null',
    holds: (fx) =>
      (fx.expected?.blocks ?? []).some(
        (b) => RESERVED_COLUMNS.filter((c) => b[c] !== null).length >= 2,
      ),
  },

  {
    op: 'purge_block',
    scenario: 'subtree-with-satellites',
    demands:
      'a purge_block on a block with seed DESCENDANTS that also carried a property and a tag ' +
      'edge, with the whole family and both satellites absent from `expected`',
    holds: (fx) =>
      opsOf(fx, 'purge_block').some((o) => {
        const seedId = argStr(o.args, 'blockId')
        if (seedId === null) return false
        const family = [seedId, ...seedDescendants(fx, seedId)]
        if (family.length < 2) return false
        const labels = family.map((s) => fx.label(s)).filter((l): l is string => l !== null)
        const allGone = labels.every((l) => blockRow(fx, l) === undefined)
        const hadProperty = opsOf(fx, 'set_property').some((s) =>
          family.includes(argStr(s.args, 'blockId') ?? ''),
        )
        const hadTag = opsOf(fx, 'add_tag').some((s) =>
          family.includes(argStr(s.args, 'blockId') ?? ''),
        )
        const propertyResidue = (fx.expected?.properties ?? []).some((p) =>
          labels.includes(p['block_id'] as string),
        )
        const tagResidue = (fx.expected?.block_tags ?? []).some(
          (e) => labels.includes(e['block_id'] as string) || labels.includes(e['tag_id'] as string),
        )
        return allGone && hadProperty && hadTag && !propertyResidue && !tagResidue
      }),
  },
  {
    op: 'purge_block',
    scenario: 'used-as-tag-cleanup',
    demands:
      'a purge_block on a block some add_tag op used AS A TAG, with no edge left pointing at ' +
      'it in `expected.block_tags`',
    holds: (fx) =>
      opsOf(fx, 'purge_block').some((o) => {
        const seedId = argStr(o.args, 'blockId')
        if (seedId === null) return false
        if (!opsOf(fx, 'add_tag').some((a) => argStr(a.args, 'tagId') === seedId)) return false
        const label = fx.label(seedId)
        return label !== null && !(fx.expected?.block_tags ?? []).some((e) => e['tag_id'] === label)
      }),
  },
  {
    op: 'set_property',
    scenario: 'reserved-key-routes-to-column',
    demands:
      'a set_property on a RESERVED key whose value lands in the block COLUMN and produces no ' +
      '`block_properties` row for that key — the routing itself, not just the write',
    holds: (fx) =>
      opsOf(fx, 'set_property').some((o) => {
        const key = argStr(o.args, 'key')
        const label = argLabel(fx, o.args, 'blockId')
        if (key === null || label === null) return false
        if (!(RESERVED_COLUMNS as readonly string[]).includes(key)) return false
        const row = blockRow(fx, label)
        if (row === undefined || row[key] === null) return false
        return !(fx.expected?.properties ?? []).some(
          (p) => p['block_id'] === label && p['key'] === key,
        )
      }),
  },
  {
    op: 'delete_property',
    scenario: 'reserved-key-clears-column',
    demands:
      "a delete_property on a RESERVED key that nulls the target's column while ANOTHER block " +
      'keeps its own — which is also what proves the preceding set actually wrote one',
    holds: (fx) =>
      opsOf(fx, 'delete_property').some((o) => {
        const key = argStr(o.args, 'key')
        const label = argLabel(fx, o.args, 'blockId')
        if (key === null || label === null) return false
        if (!(RESERVED_COLUMNS as readonly string[]).includes(key)) return false
        const row = blockRow(fx, label)
        if (row === undefined || row[key] !== null) return false
        return (fx.expected?.blocks ?? []).some((b) => b['id'] !== label && b[key] !== null)
      }),
  },

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
  // backend-only check further down) contributes its `stepBranchKeys` units.
  // For a command with no `QUERY_STEP_BRANCH_DISCRIMINATORS` entry this is
  // exactly `fixtureQueryCommands`'s membership under a different name (the
  // key equals the bare command); for `list_blocks` it decomposes into up to
  // five distinct units, and for `filtered_blocks_query` (#3892) one step can
  // contribute SEVERAL units (one per property filter) or none.
  const fixtureQueryBranches = new Set<string>()
  for (const fx of fixtures) {
    for (const step of fx.querySteps) {
      for (const unit of stepBranchKeys(step.command, step)) fixtureQueryBranches.add(unit)
    }
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
  // for a manifested command, or just `command` — unchanged — for every
  // command that carries no branch manifest), waived either at the branch level
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

    const dim = soleDimensionOf('list_blocks')
    // discriminators.length + 1 (the default/parent_id fallthrough) must equal
    // the Rust exclusive-filter set size, so a new arm can't be added on one
    // side without the other.
    expect(dim.discriminators.length + 1).toBe(rustParams.length)
  })

  // #3892 — the same anti-rot mechanism for `filtered_blocks_query`, made
  // STRICTER in the two ways that command needs and `list_blocks` does not:
  //
  //   - ORDER, not just the set. `stepBranchKeys` classifies by FIRST match,
  //     so a reordered Rust chain silently re-labels every step even though the
  //     exclusive SET is untouched. The `filter_count` guard above compares
  //     sorted arrays and cannot see that; this one compares in dispatch order.
  //   - BOTH dispatch sites, and their agreement with each other. The reserved
  //     and non-reserved routings are separate code dispatching on the same
  //     four fields; one manifest entry is only honest while they agree.
  //
  // #3930 review note 3 — corrected: the Rust→IPC name mapping below is NOT
  // actually derived from `#[serde(rename_all = "camelCase")]` off
  // `PropertyFilter`; nothing here parses that attribute. `expected` is a
  // hardcoded literal, cross-checked against BOTH Rust dispatch sites (so a
  // reordering/renaming of the Rust IDENTIFIERS fails loud, right below) and
  // against the manifest's `discriminators` via a hand-written `toCamel` that
  // mimics what `rename_all = "camelCase"` does. A per-field
  // `#[serde(rename = "…")]` override on `PropertyFilter` — which changes
  // the WIRE name without touching the Rust identifier — would slip past
  // both of those checks unnoticed, because `extractFbqValueDispatch` reads
  // `pf.value_*` identifiers out of the Rust source, not the attribute. It
  // would not be silent overall, though: a fixture step still spells the
  // OLD (manifest-declared) camelCase field name, so on the real backend
  // that field would deserialize to `None` and the filter would silently
  // degrade to the key-presence arm — surfacing as a query-result mismatch
  // in `conformance_fixtures_match_backend` (the Rust runner) for any
  // fixture exercising that field, or as an uncovered-branch failure in
  // `every read-only command BRANCH has a conformance query step or a
  // justified allowlist waiver` below if no other step covers that arm. So
  // the drift is still loud — it just surfaces elsewhere, not in this test.
  it('filtered_blocks_query branch discriminators match the Rust value-shape dispatch', () => {
    const expected = ['value_text', 'value_text_in', 'value_date', 'value_date_range']

    for (const site of FBQ_VALUE_DISPATCH_SITES) {
      const { guard, chain } = extractFbqValueDispatch(site)
      expect(
        guard,
        `${site.label}: the "at most one of …" exclusivity guard now covers ` +
          `${JSON.stringify(guard)} (expected ${JSON.stringify(expected)}, in that order). ` +
          `QUERY_STEP_BRANCH_DISCRIMINATORS.filtered_blocks_query declares one branch per ` +
          `value field plus a key-presence default — update the manifest AND this expected ` +
          `list together, don't widen the assertion.`,
      ).toEqual(expected)
      expect(
        chain,
        `${site.label}: the value-shape dispatch chain now selects on ` +
          `${JSON.stringify(chain)} (expected ${JSON.stringify(expected)}, in that order). ` +
          `stepBranchKeys classifies a property filter by FIRST match, so this ORDER is ` +
          `load-bearing: reordering the Rust arms re-labels every recorded query step.`,
      ).toEqual(expected)
    }

    const dim = soleDimensionOf('filtered_blocks_query')
    const toCamel = (s: string): string => s.replaceAll(/_(\w)/g, (_, c: string) => c.toUpperCase())
    expect(
      dim.discriminators.map((d) => d.field),
      `The manifest's discriminator fields must be the camelCase of the Rust value ` +
        `fields, in dispatch order (PropertyFilter is #[serde(rename_all = "camelCase")]).`,
    ).toEqual(expected.map(toCamel))
    // Unlike `list_blocks` (whose `parent_id` arm IS the terminal else, so
    // discriminators + 1 === rust params), EVERY value field here has its own
    // arm and the default branch is a genuine fifth one.
    expect(
      dim.discriminators.length,
      `Every Rust value field must have its own declared discriminator — the ` +
        `key-presence default branch is EXTRA here, not one of them.`,
    ).toBe(expected.length)
  })

  // #3927 — `list_pages_with_metadata`'s five-arm `PageSort` dispatch. Two
  // things this guard does that the two above do not need to:
  //
  //   - it compares THREE Rust sites to each other (see `PAGE_SORT_MATCH_SITES`
  //     for why a disagreement between them is itself a bug), not just each to
  //     the manifest;
  //   - it pins the wire spelling of every variant, because this manifest
  //     dispatches on a VALUE (`sort: "most-linked"`) rather than on a field's
  //     presence. A renamed variant would not change the Rust identifier the
  //     parse reads, so the literal below is the only thing standing between a
  //     `#[serde(rename)]` and every step silently re-classifying to the
  //     `alphabetical` default. (Same class of hand-written mapping #3930's
  //     review flagged on `filtered_blocks_query`; stated, not implied.)
  it('list_pages_with_metadata branch discriminators match the Rust PageSort dispatch', () => {
    const expectedVariants = [
      'Alphabetical',
      'RecentlyModified',
      'MostLinked',
      'MostContent',
      'Default',
    ]
    for (const site of PAGE_SORT_MATCH_SITES) {
      const variants = variantsInOrder(
        rustItemBody(RUST_PAGES_METADATA_PATH, site.needle),
        'PageSort',
      ).toSorted()
      expect(
        variants,
        `${site.label}: matches on ${JSON.stringify(variants)} (expected ` +
          `${JSON.stringify(expectedVariants.toSorted())}). The three PageSort match sites must ` +
          `agree with each other AND with QUERY_STEP_BRANCH_DISCRIMINATORS.list_pages_with_metadata ` +
          `— a variant handled by one and missed by another is a cursor that round-trips into ` +
          `the wrong keyset. Update the manifest and this list together.`,
      ).toEqual(expectedVariants.toSorted())
    }

    // Rust variant → the wire value a query step spells. HARDCODED, mimicking
    // `#[serde(rename_all = "kebab-case")]` (plus `Default`'s explicit
    // `rename = "default"`); nothing here parses those attributes.
    const WIRE: Readonly<Record<string, string>> = {
      Alphabetical: 'alphabetical',
      RecentlyModified: 'recently-modified',
      MostLinked: 'most-linked',
      MostContent: 'most-content',
      Default: 'default',
    }
    const dim = soleDimensionOf('list_pages_with_metadata')
    // Four discriminators + the default; `Alphabetical` has no discriminator
    // because it IS the `#[serde(default)]` fallthrough — a step that omits
    // `sort` entirely runs that arm.
    expect(dim.discriminators.length + 1).toBe(expectedVariants.length)
    expect(
      dim.discriminators.map((d) => d.equals).toSorted(),
      `Every non-default PageSort variant must have a discriminator declaring its WIRE value.`,
    ).toEqual(
      expectedVariants
        .filter((v) => v !== 'Alphabetical')
        .map((v) => WIRE[v])
        .toSorted(),
    )
    expect(
      dim.discriminators.every((d) => d.field === 'sort'),
      'Every PageSort discriminator reads the same `sort` field; the arms differ by VALUE.',
    ).toBe(true)
    expect(dim.defaultBranch).toBe('sort-alphabetical')
  })

  // #3927 — `search_blocks`. The one command in this manifest whose dispatch is
  // neither presence- nor value-shaped, so its classifiers are hand-written
  // `when` predicates and this guard is the only thing pinning them to the
  // Rust. It reads the dispatch three ways (see `extractSearchTogglesDispatch`).
  it('search_blocks branch discriminators match the Rust arm dispatch', () => {
    const { hasFilterDisjuncts, metadataFields, armOrder } = extractSearchTogglesDispatch()

    expect(
      armOrder,
      `search_with_toggles' arms are now ordered ${JSON.stringify(armOrder)}. The blank-query ` +
        `test running BEFORE the mode branch is load-bearing: stepBranchKeys classifies by ` +
        `FIRST match, so hoisting \`is_regex\` above it re-labels every blank-query step. ` +
        `Reorder the manifest's discriminators to match, don't widen this.`,
    ).toEqual(['blank-query', 'regex', 'no-toggle'])

    // The `has_filters` disjunction, as the Rust spells it. `metadata` is the
    // collapsed sixth disjunct, expanded by `metadataFields` below.
    expect(
      hasFilterDisjuncts,
      `search_with_toggles' \`has_filters\` now reads ${JSON.stringify(hasFilterDisjuncts)}. ` +
        `SEARCH_HAS_FILTERS_FIELDS mirrors it (camelCased) to decide which BLANK-query arm a ` +
        `step drives — a disjunct added there and missed here makes a filtered blank query ` +
        `credit \`blank-unfiltered\`, the empty arm it never ran.`,
    ).toEqual([
      'parent_id',
      'tag_ids',
      'include_page_globs',
      'exclude_page_globs',
      'block_type_filter',
      'metadata',
    ])

    expect(
      metadataFields,
      `prepare_metadata_with_today now reads ${JSON.stringify(metadataFields)} off the ` +
        `SearchFilter. Those are what \`metadata.is_empty()\` expands to, so they belong in ` +
        `SEARCH_HAS_FILTERS_FIELDS too.`,
    ).toEqual([
      'state_filter',
      'priority_filter',
      'excluded_state_filter',
      'excluded_priority_filter',
      'due_filter',
      'scheduled_filter',
      'excluded_property_filters',
      'property_filters',
      'last_edited',
    ])

    // The manifest's own field list must be exactly the camelCase of the two
    // Rust lists combined, minus the collapsed `metadata` placeholder.
    const toCamel = (s: string): string => s.replaceAll(/_(\w)/g, (_, c: string) => c.toUpperCase())
    expect(
      [...SEARCH_HAS_FILTERS_FIELDS].toSorted(),
      `SEARCH_HAS_FILTERS_FIELDS must be the camelCase union of has_filters' own disjuncts and ` +
        `the SearchFilter fields prepare_metadata reads.`,
    ).toEqual(
      [...hasFilterDisjuncts.filter((f) => f !== 'metadata'), ...metadataFields]
        .map(toCamel)
        .toSorted(),
    )

    const dim = soleDimensionOf('search_blocks')
    expect(
      dim.discriminators.map((d) => d.branch),
      'The declared branches must mirror the Rust chain order.',
    ).toEqual(['blank-unfiltered', 'blank-filtered', 'regex', 'fts-match'])
    expect(
      dim.discriminators.every((d) => typeof d.when === 'function'),
      'Every search_blocks arm is condition-shaped, so every discriminator must carry `when`: ' +
        'a `field` discriminator reports a `false` toggle as PRESENT and would credit the ' +
        'regex arm for `"isRegex": false`.',
    ).toBe(true)
  })

  // #3927 — `run_advanced_query`'s two STRUCTURAL switches. Lighter than the
  // guards above by design: it pins that both switches still exist and still
  // read the fields the manifest names, which is what stops the entry rotting
  // into a pair of branches nothing dispatches on. What it deliberately does
  // NOT claim is completeness — see the NOTE under the manifest for the sort /
  // group-key / aggregate / filter-leaf dispatch this entry does not model.
  it("run_advanced_query branch discriminators match the engine's structural dispatch", () => {
    const engine = readRustSource(RUST_QUERY_ENGINE_PATH)
    for (const [what, needle] of [
      ['the grouped dispatch', 'if let Some(spec) = request.group_by.as_ref()'],
      ['the full-text switch', 'let has_fulltext = match_sanitized.is_some();'],
      ['the full-text request field', 'request.fulltext.as_deref()'],
      ['the full-text FROM swap', 'fts_blocks fts JOIN blocks b ON b.id = fts.block_id'],
      ['the grouped path entry', 'return run_grouped(pool, spec, &request, ctx, limit).await;'],
    ] as const) {
      expect(
        engine.includes(needle),
        `could not find ${what} (${JSON.stringify(needle)}) in ${RUST_QUERY_ENGINE_PATH}. ` +
          `QUERY_STEP_BRANCH_DISCRIMINATORS.run_advanced_query declares one branch per switch; ` +
          `update the manifest and this guard together if the engine moved, don't delete the ` +
          `assertion.`,
      ).toBe(true)
    }

    const spec = QUERY_STEP_BRANCH_DISCRIMINATORS['run_advanced_query']
    expect(spec?.dimensions.map((d) => d.name)).toEqual([
      'group_by dispatch',
      'has_fulltext composition',
    ])
    expect(
      spec?.dimensions.map((d) => d.discriminators.map((x) => x.field)),
      'Each structural switch is field-presence-shaped on the request DTO.',
    ).toEqual([['groupBy'], ['fulltext']])
  })

  // #3927 — the manifest itself, independently of any one command. Each of
  // these is a way to write an entry that COMPILES, passes every guard above,
  // and silently credits a branch nothing drove.
  it('the branch manifest is well-formed (one shape per discriminator, unique branch names)', () => {
    const malformed: string[] = []
    const collisions: string[] = []
    const notReadOnly: string[] = []
    for (const [command, spec] of Object.entries(QUERY_STEP_BRANCH_DISCRIMINATORS)) {
      if (!isReadOnly(command) || !bindingsCommands.includes(command)) notReadOnly.push(command)
      const seen = new Set<string>()
      for (const dim of spec.dimensions) {
        for (const d of [...dim.discriminators, { branch: dim.defaultBranch }]) {
          if (seen.has(d.branch)) collisions.push(`${command}::${d.branch}`)
          seen.add(d.branch)
        }
        for (const d of dim.discriminators) {
          const shapes = [d.field !== undefined, d.when !== undefined].filter(Boolean).length
          if (shapes !== 1) malformed.push(`${command}::${d.branch} (declares ${shapes} shapes)`)
          if (d.equals !== undefined && d.field === undefined) {
            malformed.push(`${command}::${d.branch} (\`equals\` without \`field\`)`)
          }
        }
      }
    }
    expect(
      malformed,
      `Each discriminator declares EXACTLY ONE of \`field\` / \`when\` (and \`equals\` only ` +
        `alongside \`field\`): ${JSON.stringify(malformed)}. Two shapes means one is dead and ` +
        `the branch is classified by a rule nobody reading the entry expects; zero means it ` +
        `never matches, so its branch is permanently uncovered and its arm permanently ` +
        `mis-credited to the default.`,
    ).toEqual([])
    expect(
      collisions,
      `Branch names must be unique across ALL of a command's dimensions ` +
        `${JSON.stringify(collisions)} — the coverage key is \`command::branch\`, with no ` +
        `dimension in it, so a collision silently merges two arms into one unit that either ` +
        `step can satisfy.`,
    ).toEqual([])
    expect(
      notReadOnly,
      `QUERY_STEP_BRANCH_DISCRIMINATORS entries must be read-only commands still present in ` +
        `bindings.ts ${JSON.stringify(notReadOnly)}; nothing consumes a branch manifest for ` +
        `anything else, so the entry (and any branch waiver naming it) is dead.`,
    ).toEqual([])
  })

  // #3878 review note 4 — `stepBranchKeys` falls through to `defaultBranch`
  // when a step's `args.request` carries none of the declared discriminator
  // fields. That is CORRECT for a step that legitimately omits every filter
  // (`list_blocks::children` from `{ parentId: null }` still has a request
  // object; the discriminators just aren't in it) — but the same fallthrough
  // fires identically for a fixture step that simply forgot its
  // `args.request` altogether, which would then silently credit the default
  // branch instead of failing loud. This guard is scoped to MANIFESTED
  // commands only: an unmanifested read-only command's steps carry no
  // discriminator shape requirement, so `args.request`'s presence there is
  // not this guard's business.
  //
  // #3892 — a `perElement` command (`filtered_blocks_query`) cannot hit that
  // fallthrough at all: a step with no array credits NO branch, so a forgotten
  // arg fails the coverage check above instead of quietly crediting a default.
  // The shape requirement there is different, and is checked separately below:
  // every ELEMENT must be an object, because `stepBranchKeys` skips anything
  // else — and a silently-skipped element is the same invisible-coverage bug
  // one level down.
  it('every query step for a manifested command declares its discriminator args', () => {
    const missing: string[] = []
    const malformedElement: string[] = []
    for (const fx of fixtures) {
      for (const step of fx.querySteps) {
        const spec = QUERY_STEP_BRANCH_DISCRIMINATORS[step.command]
        if (!spec) continue
        for (const dim of spec.dimensions) {
          // #3927 — declared per dimension rather than inferred from the
          // source path: `search_blocks` classifies off the args ROOT, which
          // is never absent, so there is no node to null-check and the
          // fallthrough would be silent without this.
          for (const key of dim.requiredArgs ?? []) {
            if (step.args?.[key] === undefined || step.args[key] === null) {
              missing.push(`${fx.name}/${step.name} (missing '${key}')`)
            }
          }
          if (dim.source.kind === 'object') continue
          const raw = resolvePath(step.args ?? {}, dim.source.path)
          // Absent is legitimate: `filtered_blocks_query` accepts a tag-only or
          // blockType-only call, which exercises no value-shape arm.
          if (raw === undefined || raw === null) continue
          if (!Array.isArray(raw)) {
            missing.push(`${fx.name}/${step.name} ('${dim.source.path.join('.')}' is not an array)`)
            continue
          }
          for (const [i, el] of raw.entries()) {
            if (typeof el !== 'object' || el === null || Array.isArray(el)) {
              malformedElement.push(`${fx.name}/${step.name}[${i}]`)
            }
          }
        }
      }
    }
    expect(
      missing,
      `These query steps drive a branch-manifested command ` +
        `(${JSON.stringify(Object.keys(QUERY_STEP_BRANCH_DISCRIMINATORS))}) but carry no ` +
        `discriminator args of the declared shape: ${JSON.stringify(missing)}. ` +
        `stepBranchKeys falls through to defaultBranch when no discriminator field is ` +
        `present, which is correct for a step that legitimately omits every filter — but ` +
        `a step that simply forgot its args would silently credit that same default ` +
        `branch instead of failing. FIX by adding \`args: { request: {...} }\` (an empty ` +
        `\`{}\` is a legitimate default-branch request), or — for a per-element command — ` +
        `by making the declared array field an actual array.`,
    ).toEqual([])
    expect(
      malformedElement,
      `These per-element discriminator entries are not objects: ` +
        `${JSON.stringify(malformedElement)}. stepBranchKeys SKIPS a non-object element, ` +
        `so it would contribute no branch and the step would silently under-claim its ` +
        `coverage. FIX the fixture's args.`,
    ).toEqual([])
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

  // #3964 — the reason strings themselves. Both allowlists already enforce
  // that every entry HAS a reason and that the entry still names a live
  // command. Nothing looked at what the reason SAYS, and many of them
  // discharge the waiver by naming somewhere else the coverage lives:
  // "covered by set-property-batch.test.ts", "batch of add_tag
  // (tag_add_remove.json)". Those citations were unverified in both
  // directions — the named artifact could be deleted, and it could be one that
  // has nothing to do with the waived command. Both were live: three waivers
  // named a test file that never mentions the command they waive (fixed
  // above, in the map), which is the fail-open the issue was filed for.
  //
  // The guard is deliberately two-tier, because existence alone is the weaker
  // half: a `git rm` is not the way a citation usually goes wrong. It goes
  // wrong by being written from memory.
  it('every waiver reason that cites an artifact names one that exists and is relevant (#3964)', () => {
    const missing: string[] = []
    const irrelevant: string[] = []

    for (const [listName, list] of WAIVER_LISTS) {
      for (const [key, reason] of Object.entries(list)) {
        // Branch keys are `command::branch`; the command is what a citation
        // must be relevant to.
        const command = key.split('::')[0] as string
        for (const cite of citationsIn(reason)) {
          const resolved = resolveCitation(cite)
          if (resolved === null) {
            missing.push(`${listName}.${key} → ${cite.file}`)
            continue
          }
          const needles = cite.via !== null ? [cite.via] : relevanceNeedles(cite, command, reason)
          const body = readFileSync(resolved, 'utf8')
          if (!needles.some((n) => body.includes(n))) {
            irrelevant.push(
              `${listName}.${key} → ${cite.file} (mentions none of ${JSON.stringify(needles)})`,
            )
          }
        }
      }
    }

    expect(
      missing,
      `These waiver reasons cite a file that does not exist ${JSON.stringify(missing)}. ` +
        `A waiver granted on the strength of coverage elsewhere is worth exactly what ` +
        `"elsewhere" is worth, and the staleness cross-checks above cannot help: they ` +
        `verify the command's relationship to bindings.ts and to the fixture set, never ` +
        `to the file its reason names. Fix the path, or rewrite the reason to state what ` +
        `is actually true now.`,
    ).toEqual([])

    expect(
      irrelevant,
      `These waiver reasons cite a file that never mentions what the waiver claims it ` +
        `covers ${JSON.stringify(irrelevant)}. The file exists; it is the wrong file, or ` +
        `the right file for a different command. If the cited test reaches the command ` +
        `INDIRECTLY — through a shared primitive rather than by name — say so with the ` +
        `explicit \`file.test.ts (via someSymbol)\` form, which moves this check onto ` +
        `\`someSymbol\` instead of onto the command name. The escape hatch is a redirect, ` +
        `not an exemption.`,
    ).toEqual([])
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
    const misdeclaredRefusal: string[] = []
    const misaligned: string[] = []
    // #3833 item 3 — `expect_empty` is an escape hatch from the `vacuous`
    // check below; a bare `true` costs nothing to add, so nothing stops it
    // from waving off a step that is empty by MISTAKE as readily as one that
    // is empty on purpose. Every current `expect_empty` step already carries
    // a `comment` by convention (the message at the `vacuous` assertion below
    // has said so since #3826); this makes that convention load-bearing.
    const uncommented: string[] = []
    // #3833 items 9/10 — both runners fall back to the SAME sentinel string
    // when a row is missing the shape a projector expects (`ids_in` /
    // `idToken`'s `<missing-id>`, `propertyToken`'s `<missing-key>`,
    // `rowToken`'s `<not-a-string>`, the `list_page_links` edge projection's
    // `?`). If a `WIRE` / `run_step` id key were ever wrong for a command,
    // BOTH runners would independently record N copies of the identical
    // sentinel — non-empty, so it passes every check above, and the
    // "differential" silently degrades to comparing row COUNT only. This is
    // the vacuity guard's own blind spot, in the shape of its own fallback
    // values.
    const sentinelLeak: string[] = []
    // #3833 item 10 — the other half, which the sentinel check above does NOT
    // cover: `relabel_head` falls back to the RAW id when an id is missing
    // from the canonical label map, and `conformance_query.rs`'s module doc
    // sells that fallback as a safety property ("a leak is visible rather
    // than silently dropped"). Visible to a reader, yes; nothing failed on
    // it. The issue's literal suggestion — every row must match `B\d+` —
    // is unsound (property and tag tokens are user-authored keys:
    // `estimate#Num=3`), but its PROPERTY is not: no recorded atom may still
    // be a raw 26-char id.
    const rawIdLeak: string[] = []
    for (const fx of fixtures) {
      if (fx.querySteps.length === 0) continue
      for (const [i, step] of fx.querySteps.entries()) {
        const recorded = fx.expectedQueries[i]
        if (!recorded || recorded.name !== step.name) {
          misaligned.push(`${fx.name}/${step.name}`)
          continue
        }
        // #3928 — a step that recorded an `error` is NOT vacuous, and must not
        // be made to declare `expect_empty`. Its comparison is the
        // `AppErrorKind`, which a constant-`[]` handler does NOT satisfy: the
        // mock has to REFUSE the same call with the same kind. Its rows are
        // empty as a CONSEQUENCE of the refusal, not as the pinned negative,
        // so `expect_empty` on such a step would misdescribe what it proves.
        const isRefusal = (recorded.error ?? null) !== null
        const isEmpty = recorded.rows.length === 0
        if (isEmpty && !isRefusal && step.expect_empty !== true) {
          vacuous.push(`${fx.name}/${step.name}`)
        }
        if (!isEmpty && step.expect_empty === true) staleEmptyClaim.push(`${fx.name}/${step.name}`)
        if (isRefusal && step.expect_empty === true)
          misdeclaredRefusal.push(`${fx.name}/${step.name}`)
        if (step.expect_empty === true && !step.comment?.trim())
          uncommented.push(`${fx.name}/${step.name}`)
        for (const row of recorded.rows) {
          const hits = rowSentinelHits(row)
          if (hits.length > 0) {
            sentinelLeak.push(
              `${fx.name}/${step.name} (row ${JSON.stringify(row)} carries ${JSON.stringify(hits)})`,
            )
          }
          const raw = rawIdHits(row)
          if (raw.length > 0) {
            rawIdLeak.push(
              `${fx.name}/${step.name} (row ${JSON.stringify(row)} carries ${JSON.stringify(raw)})`,
            )
          }
        }
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

    // NOT load-bearing today, said plainly rather than left to read as
    // verified: no step in the suite declares `expect_empty` on a refusal, so
    // deleting this accumulator and its assertion leaves every ratchet green
    // (checked, not assumed). Unlike the `!isRefusal` clause above — which IS
    // load-bearing, since without it `get_block_404s_on_tombstone` is reported
    // vacuous — this one only forbids a combination nobody has written yet. It
    // stays because the two declarations mean different things and a fixture
    // author who conflates them would otherwise be told nothing.
    expect(
      misdeclaredRefusal,
      `These query steps declare "expect_empty": true but recorded an \`error\` ` +
        `${JSON.stringify(misdeclaredRefusal)}. A REFUSAL is not an empty result: ` +
        `what the step pins is the AppErrorKind, and the empty rows follow from it. ` +
        `Drop the declaration — the recorded error is already the non-vacuous claim.`,
    ).toEqual([])

    // #3833 item 3.
    expect(
      uncommented,
      `These query steps declare "expect_empty": true with no (or a blank) "comment" ` +
        `${JSON.stringify(uncommented)}. The escape hatch from the \`vacuous\` check above ` +
        `must cost a sentence: say which NEGATIVE the empty result pins, so a step that is ` +
        `empty by mistake cannot be waved through as cheaply as one that is empty on purpose.`,
    ).toEqual([])

    // #3833 items 9/10.
    expect(
      sentinelLeak,
      `These query steps recorded a row carrying a PROJECTION SENTINEL, not real data ` +
        `${JSON.stringify(sentinelLeak)}. Both runners fall back to the same placeholder ` +
        `(\`<missing-id>\`, \`<missing-key>\`, \`<not-a-string>\`, \`?\`) when a row is missing ` +
        `the key a projector expects — so a wrong id/pair/scalar key in \`run_step\` (Rust) or ` +
        `\`WIRE\` (TS) makes BOTH runners record N copies of the SAME sentinel, which is ` +
        `non-empty and passes every check above while comparing nothing but row COUNT. Fix the ` +
        `projector's key, not the fixture.`,
    ).toEqual([])

    // #3833 item 10.
    expect(
      rawIdLeak,
      `These query steps recorded a RAW, unrelabelled 26-char block id ` +
        `${JSON.stringify(rawIdLeak)}. \`relabel_head\` passes an id through unchanged when it ` +
        `is absent from the canonical label map, which \`conformance_query.rs\` documents as ` +
        `making the leak "visible rather than silently dropped" — visible to a reader, but ` +
        `until now nothing failed on it. A raw id is stack-local: the two runners mint ` +
        `different ones, so the differential can only ever compare them as unequal noise. ` +
        `If the hit is a token HEAD or an id-valued attribute (\`page_id\`, \`parent_id\`, a ` +
        `\`Ref\` property), add the id to the canonical label map (\`canonicalOrder\`). If it ` +
        `is a CONTENT-valued attribute that merely looks like an id — a \`value_text\` of 26 ` +
        `Crockford characters is legal fixture content — the label map is not the fix: this ` +
        `check scans attribute values on purpose (see \`rawIdHits\`) and cannot tell the two ` +
        `apart, so re-author the fixture's content instead. Either way, do not re-record the row.`,
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
    // #3878 — keyed on `stepBranchKeys`, not `step.command`: a command with a
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
        // #3928 — a REFUSAL counts as live. A command that 404s is differentially
        // exercised: the mock must reject the same call with the same kind, and
        // a constant-`[]` handler fails it. Only a step that is empty AND did
        // not refuse is no evidence.
        //
        // NOT load-bearing today, and worth saying so rather than letting it
        // read as verified: the only refusal step in the suite is
        // `get_block_404s_on_tombstone`, and `get_block` is kept live by its
        // populated sibling `get_block_serves_a_live_block` regardless. Deleting
        // the `error` clause here leaves every ratchet green. It is here because
        // the rule this guard states is "differentially exercised", and a
        // refusal is — so a command whose ONLY step is a refusal would otherwise
        // be accused of being backend-only, which is a wrong verdict rather than
        // a missing one.
        const rec = fx.expectedQueries[i]
        if ((rec?.rows.length ?? 0) === 0 && (rec?.error ?? null) === null) continue
        for (const unit of stepBranchKeys(step.command, step)) liveCommands.add(unit)
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
      ({ op, scenario }) =>
        !fixtures.some((fx) => fx.scenarios.has(scenario) && fx.opCommands.has(op)),
    ).map(({ op, scenario }) => `${op}/${scenario}`)
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

  // #3965 — the half the tuple above cannot see. Kept as a separate `it` on
  // purpose: "no fixture claims this scenario" and "a fixture claims it but is
  // not shaped like it" are different repairs, and collapsing them into one
  // accumulator would report the second as the first.
  it('every required scenario is DEMONSTRATED by a declaring fixture, not merely tagged (#3965)', () => {
    const labelOnly: string[] = []
    for (const req of REQUIRED_SCENARIOS) {
      const declaring = fixtures.filter(
        (fx) => fx.scenarios.has(req.scenario) && fx.opCommands.has(req.op),
      )
      // Undeclared tuples are the previous `it`'s finding, not this one's.
      if (declaring.length === 0) continue
      if (declaring.some((fx) => req.holds(fx))) continue
      labelOnly.push(
        `${req.op}/${req.scenario} — declared by ${JSON.stringify(
          declaring.map((fx) => fx.name),
        )}, none of which shows ${req.demands}`,
      )
    }
    expect(
      labelOnly,
      `These required scenarios are pinned by a fixture that NAMES them and does not ` +
        `EXHIBIT them ${JSON.stringify(labelOnly)}. The \`scenarios\` array is a claim ` +
        `the fixture makes about itself; this check is the only thing that reads the ` +
        `fixture instead. FIX by giving the fixture the seed/ops the scenario describes ` +
        `— not by loosening the predicate, which is the one repair that puts the manifest ` +
        `back to comparing a label to a label.`,
    ).toEqual([])
  })

  // The predicates' own guard. `holds` is non-optional, so a tuple cannot be
  // added label-only — but `holds: () => true` satisfies the type while
  // restoring exactly the behaviour #3965 was filed about, and it is the
  // cheapest thing to write under deadline. A predicate that is true of EVERY
  // fixture in the corpus distinguishes nothing, which is what that looks like
  // from the outside; so does one that is true of NONE, which would make the
  // check above unsatisfiable rather than strict.
  it('every required-scenario predicate discriminates between fixtures (#3965)', () => {
    const alwaysTrue: string[] = []
    const neverTrue: string[] = []
    for (const req of REQUIRED_SCENARIOS) {
      const hits = fixtures.filter((fx) => req.holds(fx)).length
      if (hits === fixtures.length) alwaysTrue.push(`${req.op}/${req.scenario}`)
      if (hits === 0) neverTrue.push(`${req.op}/${req.scenario}`)
    }
    expect(
      alwaysTrue,
      `These scenario predicates are true of EVERY fixture in the corpus ` +
        `${JSON.stringify(alwaysTrue)} — they separate nothing, so crediting a fixture ` +
        `for satisfying one is the label-vs-label check under a new name. A predicate ` +
        `must say something the (declares-scenario + drives-op) pair does not.`,
    ).toEqual([])
    expect(
      neverTrue,
      `These scenario predicates are true of NO fixture ${JSON.stringify(neverTrue)}. ` +
        `The demonstration check above cannot pass, and the predicate is describing a ` +
        `fixture shape that does not exist rather than the one that does.`,
    ).toEqual([])
  })
})
