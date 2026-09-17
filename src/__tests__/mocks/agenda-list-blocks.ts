/**
 * Route a `listBlocks` spy through the tauri-mock's own `list_blocks`
 * handler, seeded with the given rows.
 *
 * Testing invariant 1: `expect(invoke).toHaveBeenCalledWith(…)` proves the
 * frontend ASKED and nothing about what came back. #5074 moved the agenda's
 * DONE exclusion out of a client-side pass and into SQL (`excludeTodoStates`
 * on `ListBlocksRequest`), so the only honest pin is a stack that HONOURS the
 * filter: seed rows, let the mock answer — it is invariant 3's second
 * implementation of the backend, `src/lib/tauri-mock/handlers/blocks.ts` —
 * and assert the rendered result.
 *
 * A canned `mockResolvedValue({ items })` cannot express this: it answers the
 * same rows whatever the request, so a hook that dropped the filter entirely
 * would still look correct.
 */

import type { Mock } from 'vitest'

import type { BlockRow } from '@/lib/bindings'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, seedBlocks } from '@/lib/tauri-mock/seed'

export function seedAgendaListBlocks(listBlocksSpy: Mock, rows: readonly BlockRow[]): void {
  // `seedBlocks` resets every store (block tags, properties, links) to the
  // canonical fixture; clearing `blocks` afterwards leaves exactly the rows
  // this test seeds, the shape the mock's own suites use.
  seedBlocks()
  blocks.clear()
  for (const row of rows) {
    blocks.set(row.id, { ...row, space_id: null })
  }
  listBlocksSpy.mockImplementation(async (request: unknown, scope: unknown) =>
    dispatch('list_blocks', { request, scope }),
  )
}
