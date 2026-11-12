/**
 * Bookmarks for component suites (#6544): `held` (page id → sidebar number)
 * stands in for the `bookmark` property the backend holds.
 *
 * `seedBookmarks` puts the list straight into the bookmark query, so a
 * suite's first render already shows it; `bookmarkInvokeHandlers` answers the
 * query and the writes from `held`, so a test asserts on `held` after a click,
 * the state a restart would read. The hook's own read path is covered in
 * `src/hooks/__tests__/useStarredPages.test.tsx`.
 */

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import type { CommandReturns, TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { queryClient } from '@/lib/query-client'
import { bookmarksQueryKey } from '@/lib/starred-pages'

/** Show `held` as `spaceId`'s bookmarks, in number order. */
export function seedBookmarks(spaceId: string, held: ReadonlyMap<string, number>): void {
  const list = [...held]
    .map(([id, order]) => ({ id, order }))
    .toSorted((a, b) => a.order - b.order)
  queryClient.setQueryData(bookmarksQueryKey(spaceId), list)
}

/**
 * Answer the bookmark IPC from `held`. With `spaceOf` (page id → space), the
 * query lists only the asked space's pages, as the backend scopes it.
 */
export function bookmarkInvokeHandlers(
  held: Map<string, number>,
  spaceOf?: ReadonlyMap<string, string>,
): TypedInvokeHandlers {
  return {
    query_by_property: (args) => {
      const request = args['request'] as { key?: string } | undefined
      if (request?.key !== 'bookmark') throw new Error(`unexpected query ${JSON.stringify(args)}`)
      const space = (args['scope'] as { space_id?: string } | undefined)?.space_id
      const ids = [...held.keys()].filter((id) => spaceOf === undefined || spaceOf.get(id) === space)
      return {
        items: ids.map((id) => makeBlockRow({ id, block_type: 'page', content: id })),
        next_cursor: null,
        has_more: false,
        total_count: null,
      }
    },
    get_batch_properties: (args) => {
      const rows: CommandReturns['get_batch_properties'] = {}
      for (const id of args['blockIds'] as string[]) {
        const order = held.get(id)
        if (order === undefined) continue
        rows[id] = [
          {
            key: 'bookmark',
            value_text: null,
            value_num: order,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ]
      }
      return rows
    },
    set_property: (args) => {
      const id = args['blockId'] as string
      held.set(id, (args['value'] as { value_num: number }).value_num)
      return withOps(makeBlockRow({ id }))
    },
    delete_property: (args) => {
      const id = args['blockId'] as string
      held.delete(id)
      return withOps({ block_id: id, key: args['key'] as string })
    },
  }
}
