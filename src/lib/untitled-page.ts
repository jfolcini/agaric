/**
 * The shared "New page" create, used by the three entry points that offer a
 * page with no name yet: the sidebar button (`App.tsx`), the `createNewPage`
 * chord (`useAppKeyboardShortcuts.ts`) and the palette command
 * (`palette-commands.ts`).
 *
 * #4723 — `create_page_in_space` RESOLVES an existing title to that page
 * instead of creating a second one, so passing the literal 'Untitled' twice
 * reopens the first Untitled page the user left un-renamed. Picking the first
 * free `Untitled N` before the create keeps every "New page" a new page.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { notifyPageAdded } from '@/lib/name-change-bus'

const BASE_TITLE = 'Untitled'

/**
 * The first of `Untitled`, `Untitled 2`, `Untitled 3`, … that `titles` does
 * not already contain. Exact string compare, matching the backend's
 * exact-content resolve rule.
 */
export function untitledTitle(titles: Iterable<string | null>): string {
  const taken = new Set(titles)
  let candidate = BASE_TITLE
  let suffix = 1
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `${BASE_TITLE} ${suffix}`
  }
  return candidate
}

/**
 * Creates an untitled page in `spaceId` and publishes it on the name-change
 * bus (#4338 — a warm `pagesListRef` learns about the page without waiting
 * for a space switch). Returns the id and the title it settled on; callers
 * seed their resolve cache and navigate with that title, never the literal.
 */
export async function createUntitledPage(spaceId: string): Promise<{ id: string; title: string }> {
  const pages = unwrap(
    await commands.listAllPagesInSpace({ kind: 'active', space_id: spaceId }, null),
  )
  const title = untitledTitle(pages.map((page) => page.content))
  const id = unwrap(await commands.createPageInSpace(null, title, spaceId))
  notifyPageAdded(id, title, spaceId)
  return { id, title }
}
