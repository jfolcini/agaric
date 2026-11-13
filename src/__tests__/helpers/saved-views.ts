/**
 * Saved views for component suites (#6544): `held` (view page id → its name,
 * payload and Trash stamp) stands in for the view pages the backend holds.
 *
 * `savedViewInvokeHandlers` answers the saved-view query and the delete and
 * restore from `held`, so a test asserts on `held` after a click, the state a
 * restart would read. The read path itself is covered in
 * `src/lib/__tests__/saved-views.test.ts`, against the tauri mock.
 */

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import type { CommandReturns, TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { encodeSavedView, type SavedViewPayload } from '@/lib/saved-views'

export interface HeldView {
  name: string
  payload: SavedViewPayload
  deletedAt: number | null
}

const DELETED_AT = 1_767_225_600_000

export function savedViewInvokeHandlers(held: Map<string, HeldView>): TypedInvokeHandlers {
  const live = () => [...held].filter(([, view]) => view.deletedAt === null)
  return {
    query_by_property: (args) => {
      const request = args['request'] as { key?: string } | undefined
      if (request?.key === 'bookmark') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      if (request?.key !== 'saved_view') throw new Error(`unexpected query ${JSON.stringify(args)}`)
      return {
        items: live().map(([id, view]) =>
          makeBlockRow({ id, block_type: 'page', content: view.name }),
        ),
        next_cursor: null,
        has_more: false,
        total_count: null,
      }
    },
    get_batch_properties: (args) => {
      const rows: CommandReturns['get_batch_properties'] = {}
      for (const id of args['blockIds'] as string[]) {
        const view = held.get(id)
        if (view === undefined) continue
        rows[id] = [
          {
            key: 'saved_view',
            value_text: encodeSavedView(view.payload),
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ]
      }
      return rows
    },
    delete_block: (args) => {
      const id = args['blockId'] as string
      const view = held.get(id)
      if (view !== undefined) view.deletedAt = DELETED_AT
      return withOps({
        block_id: id,
        deleted_at: DELETED_AT,
        descendants_affected: 1,
        affected_page_ids: [id],
      })
    },
    restore_block: (args) => {
      const id = args['blockId'] as string
      const view = held.get(id)
      if (view === undefined || view.deletedAt !== args['deletedAtRef']) {
        throw new Error(`no such tombstone ${id}`)
      }
      view.deletedAt = null
      return withOps({ block_id: id, restored_count: 1 })
    },
  }
}
