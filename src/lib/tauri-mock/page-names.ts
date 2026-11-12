/**
 * #6278 — the names the live pages of a space hold: titles and aliases, one
 * name under `nameKey`. Mock twin of `SpacePageNames`
 * (`src-tauri/src/commands/spaces.rs`).
 */

import type { AppError } from '@/lib/bindings'
import { nameKey } from '@/lib/name-tokens'
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { ownerSpaceOf } from '@/lib/tauri-mock/link-index'
import { blocks, pageAliases, properties } from '@/lib/tauri-mock/seed'

/**
 * #6544 — a saved view is a page carrying `saved_view`. The backend's
 * `NOT EXISTS (SELECT 1 FROM block_properties sv WHERE sv.block_id = b.id AND
 * sv.key = 'saved_view')` leaves it out of the page listings, search, the
 * query surfaces and the names a space's pages hold; this is that predicate.
 */
export function isSavedViewPage(b: Record<string, unknown>): boolean {
  return properties.get(b['id'] as string)?.has('saved_view') ?? false
}

export interface PageNameHolder {
  id: string
  by: 'title' | 'alias'
}

/**
 * The live page of `spaceId` other than `excludeId` that holds `name`, as its
 * title before as an alias, the smallest id first (`SpacePageNames::holder`).
 */
export function pageNameHolder(
  name: string,
  spaceId: string,
  excludeId?: string,
): PageNameHolder | null {
  const key = nameKey(name)
  const pages = [...blocks.values()].filter(
    (b) =>
      b['block_type'] === 'page' &&
      !b['deleted_at'] &&
      b['id'] !== excludeId &&
      ownerSpaceOf(b) === spaceId &&
      !isSavedViewPage(b),
  )
  const smallest = (held: (b: Record<string, unknown>) => boolean) =>
    pages
      .filter(held)
      .map((b) => b['id'] as string)
      .toSorted(compareUtf8Bytes)[0]
  const title = smallest((b) => typeof b['content'] === 'string' && nameKey(b['content']) === key)
  if (title !== undefined) return { id: title, by: 'title' }
  const alias = smallest((b) =>
    (pageAliases.get(b['id'] as string) ?? []).some((held) => nameKey(held) === key),
  )
  return alias === undefined ? null : { id: alias, by: 'alias' }
}

/** `PageNameHolder::refusal`: titling a page `title` while `holder` holds it. */
export function pageNameRefusal(holder: PageNameHolder, title: string): Error & AppError {
  const message =
    holder.by === 'title'
      ? `a page titled '${title}' already exists in this space`
      : `a page in this space has the alias '${title}'`
  return Object.assign(new Error(message), {
    kind: 'validation' as const,
    code: 'DuplicatePageTitle' as const,
    message,
  })
}

/**
 * `reject_taken_names` for one page a restore or a move brings into `spaceId`:
 * its title and each alias it holds, against every other page there.
 */
export function rejectTakenPageNames(page: Record<string, unknown>, spaceId: string): void {
  // A saved view holds no name, so it clashes with none.
  if (isSavedViewPage(page)) return
  const id = page['id'] as string
  const names = [page['content'], ...(pageAliases.get(id) ?? [])]
  for (const name of names) {
    if (typeof name !== 'string') continue
    const holder = pageNameHolder(name, spaceId, id)
    if (holder) throw pageNameRefusal(holder, name)
  }
}
