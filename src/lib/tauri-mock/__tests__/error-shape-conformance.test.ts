/**
 * #2463 — mock error-SHAPE conformance.
 *
 * `check-tauri-mock-parity.mjs` (the `tauri-mock-parity` prek hook) only
 * enforces handler PRESENCE — every command in `bindings.ts` has a key in
 * `HANDLERS`. It says nothing about whether a handler's REJECTION matches
 * the `{ kind, message, code? }` `AppError` wire shape the real backend
 * sends (`src-tauri/src/error.rs`). A mock handler that throws a bare
 * `Error('not found')` instead of an `AppError`-shaped rejection passes the
 * presence check, but any component test that exercises the failure path
 * through the mock and asserts `isNotFound(err)` / `isValidation(err)` /
 * `validationCode(err)` pins a contract the real backend never honours —
 * exactly the `sql_only.rs` drift class documented in
 * `docs/architecture/sql-only-convergence.md`, in miniature.
 *
 * This suite drives representative mock handlers through their failure
 * modes and asserts the rejected value round-trips through the SAME
 * `isAppError` / `isNotFound` / `isValidation` / `validationCode` narrowing
 * helpers production code uses (`src/lib/app-error.ts`). See the
 * semantic-parity contract documented above `appErrorRejection` in
 * `../handlers.ts` for the rule new handlers must follow.
 *
 * Each case's expected `kind` was cross-checked against the corresponding
 * backend command in `src-tauri/src/commands/**` (see the `#2463` comments
 * at each fixed call site in `../handlers.ts`) — this is not a guess, it is
 * a pin of a verified backend contract.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { isAppError, isNotFound, isValidation, validationCode } from '../../app-error'
import { dispatch } from '../handlers'
import { blocks, blockTags, makeBlock, opLog, properties, propertyDefs, seedBlocks } from '../seed'

const PAGE = '00000000000000000000PAGEZZ'
const CHILD = '00000000000000000000CHILDA'
const SPACE = 'SPACE_PERSONAL'
const MISSING_ID = '00000000000000000000MISSING'

/** Reset every mock store and seed one page + one child block in `SPACE`. */
function resetMockState(): void {
  seedBlocks()
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  properties.set(
    PAGE,
    new Map([
      [
        'space',
        {
          block_id: PAGE,
          key: 'space',
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: SPACE,
          value_bool: null,
        },
      ],
    ]),
  )
  blocks.set(CHILD, makeBlock(CHILD, 'content', 'hello', PAGE, 1))
}

/** Run `dispatch(cmd, args)` and return what it throws — fails the test if it resolves instead. */
function captureRejection(cmd: string, args: unknown): unknown {
  try {
    const result = dispatch(cmd, args)
    throw new Error(
      `expected dispatch('${cmd}', ${JSON.stringify(args)}) to throw, but it resolved with ${JSON.stringify(result)}`,
    )
  } catch (err) {
    return err
  }
}

interface Case {
  name: string
  cmd: string
  args: unknown
}

describe('tauri-mock error-shape conformance (#2463)', () => {
  beforeEach(() => {
    resetMockState()
  })

  describe("missing-entity rejections pin kind: 'not_found'", () => {
    const cases: Case[] = [
      { name: 'edit_block', cmd: 'edit_block', args: { blockId: MISSING_ID, toText: 'x' } },
      { name: 'get_block', cmd: 'get_block', args: { blockId: MISSING_ID } },
      {
        name: 'move_block',
        cmd: 'move_block',
        args: { blockId: MISSING_ID, newParentId: null, newIndex: 0 },
      },
      {
        name: 'move_blocks_batch (one missing id)',
        cmd: 'move_blocks_batch',
        args: { blockIds: [MISSING_ID], newParentId: null, newIndex: 0 },
      },
      {
        name: 'set_todo_state',
        cmd: 'set_todo_state',
        args: { blockId: MISSING_ID, state: 'TODO' },
      },
      { name: 'set_priority', cmd: 'set_priority', args: { blockId: MISSING_ID, level: 'high' } },
      {
        name: 'set_due_date',
        cmd: 'set_due_date',
        args: { blockId: MISSING_ID, date: '2026-01-01' },
      },
      {
        name: 'set_scheduled_date',
        cmd: 'set_scheduled_date',
        args: { blockId: MISSING_ID, date: '2026-01-01' },
      },
      {
        name: 'update_property_def_options (unknown key)',
        cmd: 'update_property_def_options',
        args: { key: 'no-such-def', options: '["a"]' },
      },
      { name: 'export_page_markdown', cmd: 'export_page_markdown', args: { pageId: MISSING_ID } },
      {
        name: 'compute_block_vs_current_diff (missing block)',
        cmd: 'compute_block_vs_current_diff',
        args: { blockId: MISSING_ID, historicalSeq: 1, historicalCreatedAt: null },
      },
      {
        name: 'undo_page_op (no history to undo)',
        cmd: 'undo_page_op',
        args: { pageId: PAGE, undoDepth: 0 },
      },
      {
        name: 'redo_page_op (unknown undo ref)',
        cmd: 'redo_page_op',
        args: { undoDeviceId: 'dev-1', undoSeq: 999 },
      },
    ]

    for (const { name, cmd, args } of cases) {
      it(`${name} rejects with an AppError kind: 'not_found'`, () => {
        const err = captureRejection(cmd, args)
        expect(isAppError(err), `${cmd} rejection is not AppError-shaped: ${String(err)}`).toBe(
          true,
        )
        expect(
          isNotFound(err),
          `${cmd} rejected but not with kind: 'not_found': ${String(err)}`,
        ).toBe(true)
      })
    }
  })

  describe("empty-batch / cross-domain rejections pin kind: 'validation'", () => {
    const cases: Case[] = [
      {
        name: 'create_blocks_batch (empty specs)',
        cmd: 'create_blocks_batch',
        args: { specs: [] },
      },
      {
        name: 'delete_blocks_by_ids (empty)',
        cmd: 'delete_blocks_by_ids',
        args: { blockIds: [] },
      },
      {
        name: 'move_blocks_batch (empty)',
        cmd: 'move_blocks_batch',
        args: { blockIds: [], newParentId: null, newIndex: 0 },
      },
      {
        name: 'add_tags_by_ids (empty)',
        cmd: 'add_tags_by_ids',
        args: { blockIds: [], tagId: 'T' },
      },
      {
        name: 'move_blocks_to_space (empty)',
        cmd: 'move_blocks_to_space',
        args: { blockIds: [], spaceId: SPACE },
      },
      {
        name: 'set_todo_state_batch (empty)',
        cmd: 'set_todo_state_batch',
        args: { blockIds: [], state: 'TODO' },
      },
      { name: 'get_blocks (empty)', cmd: 'get_blocks', args: { ids: [] } },
      {
        name: 'load_page_subtree (foreign space)',
        cmd: 'load_page_subtree',
        args: { rootBlockId: PAGE, scope: { kind: 'active', space_id: 'SOME_OTHER_SPACE' } },
      },
    ]

    for (const { name, cmd, args } of cases) {
      it(`${name} rejects with an AppError kind: 'validation'`, () => {
        const err = captureRejection(cmd, args)
        expect(isAppError(err), `${cmd} rejection is not AppError-shaped: ${String(err)}`).toBe(
          true,
        )
        expect(
          isValidation(err),
          `${cmd} rejected but not with kind: 'validation': ${String(err)}`,
        ).toBe(true)
      })
    }

    it('redo_page_op rejects a ref to a forward (non-undo) op with validation (#659)', () => {
      // A real forward op exists in the seed op_log (edit_block on CHILD from
      // resetMockState's implicit seeding does not append one, so create one).
      dispatch('edit_block', { blockId: CHILD, toText: 'edited' })
      const forwardOp = opLog.at(-1)
      if (!forwardOp) throw new Error('test setup: expected an op_log entry after edit_block')
      const err = captureRejection('redo_page_op', {
        undoDeviceId: forwardOp.device_id,
        undoSeq: forwardOp.seq,
      })
      expect(isAppError(err)).toBe(true)
      expect(isValidation(err)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Regression pins for the two pre-existing `appErrorRejection` call sites —
  // these already had the right shape; keep them pinned so a future edit
  // can't quietly regress them back to a bare throw.
  // ---------------------------------------------------------------------------

  it('list_pages_with_metadata rejects a cross-sort cursor with validation + RequiresRefresh (#2251)', () => {
    // Position `2` is the `recently-modified` discriminator (see
    // `sortDiscriminator` in `../handlers.ts`); the default sort used below
    // (`alphabetical`) discriminates as `5`, so this cursor is stale.
    const staleCursor = btoa(JSON.stringify({ position: 2, id: CHILD }))
    const err = captureRejection('list_pages_with_metadata', {
      filter: { spaceId: SPACE, filters: [] },
      cursor: staleCursor,
      limit: 50,
    })
    expect(isAppError(err)).toBe(true)
    expect(isValidation(err)).toBe(true)
    expect(validationCode(err)).toBe('RequiresRefresh')
  })

  it('notify_task rejects a blank title with validation (#2251)', () => {
    const err = captureRejection('notify_task', { notification: { title: '   ' } })
    expect(isAppError(err)).toBe(true)
    expect(isValidation(err)).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Happy-path smoke checks — prove the #2463 error-path fixes above didn't
  // regress the success path for the same handlers.
  // ---------------------------------------------------------------------------

  it('edit_block on a real block resolves (does not throw)', () => {
    const result = dispatch('edit_block', { blockId: CHILD, toText: 'updated' }) as Record<
      string,
      unknown
    >
    expect(result['content']).toBe('updated')
  })

  it('delete_blocks_by_ids with a non-empty list resolves (does not throw)', () => {
    const result = dispatch('delete_blocks_by_ids', { blockIds: [CHILD] })
    expect(result).not.toBeNull()
  })
})
