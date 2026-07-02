/**
 * Import wiki-link resolution (#1484) — paste/markdown-import ref internalizer.
 *
 * Extracted from `page-blocks.ts` (#2254): building the page/tag name→ULID
 * resolvers is really a lib concern (it fetches ALL pages and ALL tags in the
 * active space and can CREATE targets), so it lives beside the clipboard
 * parse/internalize primitives it feeds (`internalizeRefTokens`). Consumed by
 * the `pasteBlocks` reducer.
 */

import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import type { RefInternalizers } from './block-clipboard'
import { logger } from './logger'
import { createBlock, createPageInSpace, listAllPagesInSpace, listAllTagsInSpace } from './tauri'

// ── Import wiki-link resolution (#1484) ──────────────────────────────────────

/**
 * Build the page/tag name→ULID resolvers used to rewrite human-readable
 * wiki-links (`[[Page Name]]`, `#tag`) back to internal refs on paste/import
 * (#1484). Each resolver looks the name up in the active space and CREATES the
 * target when it does not exist, reusing the same creation IPC the editor's
 * link/tag pickers use (`createPageInSpace` / `createBlock({ blockType: 'tag' })`).
 *
 * The authoritative active-space page/tag lists are fetched ONCE and shared
 * across every block in a multi-block paste (closures over the two lazily-built
 * maps), so a paste of N blocks does not issue N list IPCs. Newly created
 * pages/tags are folded back into the maps so two references to the same new
 * name in one paste create it exactly once.
 *
 * Duplicate-title rule (#1484): a `[[Name]]` whose title matches exactly ONE
 * active page links to it; a title matching MULTIPLE active pages is ambiguous
 * and left as plain text (we never guess which page was meant); a title
 * matching NONE is created. Tag names are unique per space, so tags have no
 * ambiguity branch.
 *
 * Returns `null` (→ caller skips resolution, content stays verbatim) when no
 * space is active, so a pre-bootstrap paste never creates cross-space data.
 */
export function buildImportRefInternalizers(): RefInternalizers | null {
  const currentSpaceId = useSpaceStore.getState().currentSpaceId
  if (currentSpaceId == null) return null
  // Capture as a non-null const so the async closures below keep the narrowing.
  const spaceId: string = currentSpaceId

  // Lazily-fetched, paste-scoped caches. `title → [ulid, …]` keeps every page
  // sharing a title so the duplicate rule can count them; `name → ulid` is a
  // 1:1 tag map (tag names are unique). Built on first reference of each kind.
  let pagesByTitle: Map<string, string[]> | null = null
  let tagsByName: Map<string, string> | null = null

  async function ensurePages(): Promise<Map<string, string[]>> {
    if (pagesByTitle) return pagesByTitle
    const map = new Map<string, string[]>()
    try {
      for (const p of await listAllPagesInSpace(spaceId)) {
        const title = p.content ?? ''
        if (title.length === 0) continue
        const ids = map.get(title)
        if (ids) ids.push(p.id)
        else map.set(title, [p.id])
      }
    } catch (err) {
      logger.warn('page-blocks', 'import: page list fetch failed', {}, err)
    }
    pagesByTitle = map
    return map
  }

  async function ensureTags(): Promise<Map<string, string>> {
    if (tagsByName) return tagsByName
    const map = new Map<string, string>()
    try {
      for (const t of await listAllTagsInSpace(spaceId)) map.set(t.name, t.tag_id)
    } catch (err) {
      logger.warn('page-blocks', 'import: tag list fetch failed', {}, err)
    }
    tagsByName = map
    return map
  }

  return {
    page: async (name) => {
      const map = await ensurePages()
      const existing = map.get(name)
      // Ambiguous duplicate title → leave plain text (never guess).
      if (existing && existing.length > 1) return null
      if (existing && existing.length === 1) return existing[0] ?? null
      try {
        const newId = await createPageInSpace({ content: name, spaceId })
        map.set(name, [newId])
        // Seed the resolve cache so the new link chip renders its title at once.
        useResolveStore.getState().set(newId, name, false)
        return newId
      } catch (err) {
        logger.warn('page-blocks', 'import: page create failed', { name }, err)
        return null
      }
    },
    tag: async (name) => {
      const map = await ensureTags()
      const existing = map.get(name)
      if (existing != null) return existing
      try {
        const block = await createBlock({ blockType: 'tag', content: name })
        map.set(name, block.id)
        useResolveStore.getState().set(block.id, name, false)
        return block.id
      } catch (err) {
        logger.warn('page-blocks', 'import: tag create failed', { name }, err)
        return null
      }
    },
  }
}
