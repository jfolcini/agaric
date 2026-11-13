/**
 * The live pages of one space that carry a property key, each with its title
 * and that property's row: how bookmarks (`starred-pages.ts`) and saved views
 * (`saved-views.ts`) read their page property back (#6544). In the backend's
 * id order.
 */

import { unwrap } from '@/lib/app-error'
import { type BlockRow, commands, type PageResponse, type PropertyRow } from '@/lib/bindings'
import { PAGINATION_MAX, paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'

export interface PageWithProperty {
  id: string
  title: string
  row: PropertyRow
}

export async function loadPagesWithProperty(
  spaceId: string,
  key: string,
): Promise<PageWithProperty[]> {
  const pages: PageWithProperty[] = []
  let cursor: string | null = null
  do {
    const page: PageResponse<BlockRow> = unwrap(
      await commands.queryByProperty(
        {
          key,
          valueText: null,
          valueDate: null,
          operator: null,
          cursor,
          limit: paginationLimit(PAGINATION_MAX),
          excludeParentId: null,
          contentNonEmpty: null,
          blockType: 'page',
          valueTextIn: null,
          valueDateRange: null,
          excludeTodoStates: null,
        },
        requireActiveScope(spaceId),
      ),
    )
    const ids = page.items.map((block) => block.id)
    const props = ids.length > 0 ? unwrap(await commands.getBatchProperties(ids)) : {}
    for (const block of page.items) {
      const row = props[block.id]?.find((p) => p.key === key)
      if (row === undefined) continue
      pages.push({ id: block.id, title: block.content ?? '', row })
    }
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor !== null)
  return pages
}
