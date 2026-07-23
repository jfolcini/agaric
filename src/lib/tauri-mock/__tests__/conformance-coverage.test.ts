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
 *      cannot land without a fixture or an explicit, reasoned exemption; and
 *   2. a required (op, scenario) tuple from the manifest below is not pinned by
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

// ---------------------------------------------------------------------------
// Read-only classifier
// ---------------------------------------------------------------------------

/**
 * A command is READ-ONLY (has no backend-observable persistent effect) when its
 * name begins with one of these query verbs. Everything NOT matched here is a
 * MUTATING candidate and must be covered by a fixture or allowlisted below —
 * so a new command with a mutating-shaped name is caught automatically.
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
  'fetch_',
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
  undo_op: 'covered by revert.test.ts / undo-op-refs.test.ts',
  undo_ops: 'covered by revert.test.ts',
  undo_page_op: 'covered by undo-move.test.ts / undo-op-refs.test.ts',
  undo_page_group: 'covered by undo-op-refs.test.ts',
  redo_page_op: 'covered by undo-move.test.ts',
  revert_ops: 'covered by revert.test.ts',
  restore_page_to_op: 'covered by revert.test.ts (op-log time-travel)',
  compact_op_log_cmd: 'op-log maintenance; rewrites history, not blocks/props/tags',

  // ── Draft staging (drafts table, outside the conformance snapshot scope) ──
  save_draft: 'draft staging table outside the conformance snapshot scope',
  delete_draft: 'draft staging table outside the conformance snapshot scope',
  flush_draft: 'draft staging table outside the conformance snapshot scope',
  flush_all_drafts: 'draft staging table outside the conformance snapshot scope',

  // ── Attachments (blob store, outside the conformance snapshot scope) ──
  add_attachment: 'attachments blob store outside the conformance snapshot scope',
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
  cancel_pairing: 'pairing transport session; no durable domain state to snapshot',
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
  /** Additive, replay-inert string tags declaring which scenarios this fixture
   *  pins (see `REQUIRED_SCENARIOS`). Absent on fixtures that predate the tag. */
  scenarios?: string[]
}

interface LoadedFixture {
  name: string
  opCommands: Set<string>
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
  ['set_property', 'reserved-key-routes-to-column'],
  ['delete_property', 'reserved-key-clears-column'],

  // ── Not yet covered ──
  // ['create_block', 'tag-space-scope'],               // TODO(#3081): do NOT uncomment — #3081/#3092 ships no conformance fixture (the harness's `assign_all_to_test_space` masks the space-less orphan and the snapshot omits `space_id`, so create→space-scope can't be pinned via a fixture). Coverage lives in the Rust integration test + the mock round-trip; REMOVE this tuple when #3081 lands.
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#3083 conformance-coverage ratchet', () => {
  const bindingsCommands = extractBindingsCommandNames()
  const mutatingCommands = bindingsCommands.filter((c) => !isReadOnly(c))
  const fixtures = loadFixtures()

  // Commands actually driven by ≥1 fixture. A conformance op IS the IPC command
  // name (the Rust runner's `apply_op` matches on `op.command`), so this is the
  // set of behaviorally-covered mutating commands.
  const fixtureOpCommands = new Set<string>()
  for (const fx of fixtures) for (const c of fx.opCommands) fixtureOpCommands.add(c)

  it('extracts a non-trivial command + fixture surface (guards vacuous pass)', () => {
    expect(bindingsCommands.length).toBeGreaterThan(50)
    expect(mutatingCommands.length).toBeGreaterThan(30)
    expect(fixtures.length).toBeGreaterThan(15)
    expect(fixtureOpCommands.size).toBeGreaterThanOrEqual(10)
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
