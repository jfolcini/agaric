/**
 * Tauri mock handlers -- Backlinks, unlinked references, and the page-link graph.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { matchesSearchFolded } from '@/lib/fold-for-search'
import { type TypedHandlers } from '@/lib/tauri-mock/handlers/shared'
import { blockTags, blocks, properties } from '@/lib/tauri-mock/seed'

export const linksHandlers = {
  get_backlinks: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // Honour `scope: SpaceScope` the same way the backend's
    // `get_backlinks_inner` does. Active scope drops source blocks whose
    // owning page (`page_id`, or own id if itself a page) lives in a
    // different space. Global is unfiltered (legacy cross-space view).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // Scan all blocks for [[ULID]] tokens matching the target
    const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
    const backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE)) {
        if (m[1] === targetId) return true
      }
      return false
    })
    return { items: backlinkItems, next_cursor: null, has_more: false, total_count: null }
  },

  query_backlinks_filtered: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    const filterList = (a['filters'] as Array<Record<string, unknown>> | null) ?? []
    // Honour `scope: SpaceScope` (mirrors
    // `query_backlinks_filtered_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    // Scan all blocks for [[ULID]] tokens matching the target
    const LINK_RE_F = /\[\[([0-9A-Z]{26})\]\]/g
    let backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE_F)) {
        if (m[1] === targetId) return true
      }
      return false
    })

    // Apply simple filter support
    for (const filter of filterList) {
      const type = filter['type'] as string
      if (type === 'BlockType') {
        const bt = filter['block_type'] as string
        backlinkItems = backlinkItems.filter((b) => b['block_type'] === bt)
      } else if (type === 'Contains') {
        const query = (filter['query'] as string) ?? ''
        // Unicode-aware fold (mock / backend parity).
        backlinkItems = backlinkItems.filter((b) =>
          matchesSearchFolded((b['content'] as string) ?? '', query),
        )
      } else if (type === 'PropertyText') {
        const key = filter['key'] as string
        const value = filter['value'] as string
        backlinkItems = backlinkItems.filter((b) => {
          const blockProps = properties.get(b['id'] as string)
          if (!blockProps) return false
          const prop = blockProps.get(key)
          if (!prop) return false
          return (prop['value_text'] as string | null) === value
        })
      }
      // Unsupported filter types are ignored (graceful degradation)
    }

    const totalCount = backlinkItems.length
    return {
      items: backlinkItems,
      next_cursor: null,
      has_more: false,
      total_count: totalCount,
      filtered_count: totalCount,
      truncated: false,
    }
  },

  count_backlinks_batch: (args) => {
    const a = args as Record<string, unknown>
    const pageIds = a['pageIds'] as string[]
    // Honour `scope` so mock-mode FE tests can
    // observe space-scoped badge counts the same way the real backend
    // produces them. The shape mirrors `list_page_aliases_by_prefix`
    // above: pull the active spaceId out of `{ kind, space_id }`,
    // fall back to `null` (cross-space, legacy) for `Global`.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const LINK_RE_BATCH = /\[\[([0-9A-Z]{26})\]\]/g
    const result: Record<string, number> = {}
    for (const pid of pageIds) {
      const count = [...blocks.values()].filter((b) => {
        if (b['deleted_at']) return false
        // Active-space scoping: drop source blocks whose owning page
        // (resolved via `page_id`, falling back to the block's own id
        // if it IS a page) doesn't carry `space = <spaceId>`. Matches
        // the SQL `COALESCE(b.page_id, b.id) IN (... space ...)` used
        // by `count_backlinks_batch_inner`.
        if (spaceId !== null) {
          const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
          const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
          if (ownerSpace !== spaceId) return false
        }
        const content = (b['content'] as string) ?? ''
        for (const m of content.matchAll(LINK_RE_BATCH)) {
          if (m[1] === pid) return true
        }
        return false
      }).length
      result[pid] = count
    }
    return result
  },

  list_backlinks_grouped: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // Honour `scope: SpaceScope` (mirrors
    // `list_backlinks_grouped_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const LINK_RE_G = /\[\[([0-9A-Z]{26})\]\]/g
    const backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE_G)) {
        if (m[1] === targetId) return true
      }
      return false
    })
    // Group by parent_id (source page)
    const groupMap = new Map<string, Record<string, unknown>[]>()
    for (const item of backlinkItems) {
      const pid = (item['parent_id'] as string) ?? '__orphan__'
      if (!groupMap.has(pid)) groupMap.set(pid, [])
      groupMap.get(pid)?.push(item)
    }
    const groups = [...groupMap.entries()].map(([pageId, items]) => {
      const page = blocks.get(pageId)
      return {
        page_id: pageId,
        page_title: page ? ((page['content'] as string) ?? null) : null,
        blocks: items,
      }
    })
    return {
      groups,
      next_cursor: null,
      has_more: false,
      total_count: backlinkItems.length,
      filtered_count: backlinkItems.length,
      truncated: false,
    }
  },

  list_unlinked_references: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    // Honour `scope: SpaceScope` (mirrors
    // `list_unlinked_references_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const page = blocks.get(pageId)
    if (!page)
      return {
        groups: [],
        next_cursor: null,
        has_more: false,
        total_count: 0,
        filtered_count: 0,
        truncated: false,
      }
    const pageTitle = (page['content'] as string) ?? ''
    if (!pageTitle)
      return {
        groups: [],
        next_cursor: null,
        has_more: false,
        total_count: 0,
        filtered_count: 0,
        truncated: false,
      }
    // Find blocks that mention the page title as text but don't have a [[link]].
    // Unicode-aware fold (mock / backend parity).
    const LINK_RE_UL = /\[\[([0-9A-Z]{26})\]\]/g
    const unlinked = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['id'] === pageId) return false
      if (b['parent_id'] === pageId) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      const content = (b['content'] as string) ?? ''
      if (!matchesSearchFolded(content, pageTitle)) return false
      // Exclude if it already has a [[link]] to this page
      for (const m of content.matchAll(LINK_RE_UL)) {
        if (m[1] === pageId) return false
      }
      return true
    })
    const groupMap = new Map<string, Record<string, unknown>[]>()
    for (const item of unlinked) {
      const pid = (item['parent_id'] as string) ?? '__orphan__'
      if (!groupMap.has(pid)) groupMap.set(pid, [])
      groupMap.get(pid)?.push(item)
    }
    const groups = [...groupMap.entries()].map(([pid, items]) => {
      const p = blocks.get(pid)
      return {
        page_id: pid,
        page_title: p ? ((p['content'] as string) ?? null) : null,
        blocks: items,
      }
    })
    return {
      groups,
      next_cursor: null,
      has_more: false,
      total_count: unlinked.length,
      filtered_count: unlinked.length,
      truncated: false,
    }
  },

  // ---------------------------------------------------------------------------
  // Word-level diff for history display
  // ---------------------------------------------------------------------------

  // oxlint-disable-next-line eslint/complexity -- pre-existing
  list_page_links: (args) => {
    // Scan all non-deleted blocks for [[ULID]] page link tokens and
    // return page-to-page edges (source = parent page, target = linked page).
    const a = (args as Record<string, unknown> | null | undefined) ?? {}
    // When `tagIds` is non-empty, restrict edges to
    // those whose target page carries at least one of the listed tags.
    // Mirrors the backend semantics (`block_tags`-only resolution in the
    // mock world; the real backend additionally unions
    // `block_tag_inherited` / `block_tag_refs`, which the mock does not
    // model — see seed.ts).
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    // Honour `scope: SpaceScope` (mirrors `list_page_links_inner`).
    // Both endpoints of an edge must live in the active space; global is
    // unfiltered. Matches the backend's `b1.space = ?` AND `b2.space = ?`
    // join predicate.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const pageSpace = (pid: string): string | null =>
      (properties.get(pid)?.get('space')?.['value_ref'] as string | null) ?? null
    const LINK_RE_PL = /\[\[([0-9A-Z]{26})\]\]/g
    const linkSet = new Set<string>()
    const pageLinks: Array<{ source_id: string; target_id: string; ref_count: number }> = []
    for (const b of blocks.values()) {
      if (b['deleted_at']) continue
      const parentId = b['parent_id'] as string | null
      if (!parentId) continue
      // Only consider blocks whose parent is a page
      const parentBlock = blocks.get(parentId)
      if (!parentBlock || parentBlock['block_type'] !== 'page') continue
      // Active-scope filter on source page.
      if (spaceId !== null && pageSpace(parentId) !== spaceId) continue
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE_PL)) {
        const targetPageId = m[1] as string
        // Ensure target is an existing non-deleted page
        const targetBlock = blocks.get(targetPageId)
        if (!targetBlock || targetBlock['block_type'] !== 'page' || targetBlock['deleted_at'])
          continue
        // Active-scope filter on target page (mirrors the
        // backend's `b2.space = ?` predicate).
        if (spaceId !== null && pageSpace(targetPageId) !== spaceId) continue
        // Apply target-side tag filter.
        if (tagFilter) {
          const targetTags = blockTags.get(targetPageId)
          let hit = false
          if (targetTags) {
            for (const tid of tagFilter) {
              if (targetTags.has(tid)) {
                hit = true
                break
              }
            }
          }
          if (!hit) continue
        }
        // Deduplicate edges
        const key = `${parentId}→${targetPageId}`
        if (!linkSet.has(key)) {
          linkSet.add(key)
          pageLinks.push({ source_id: parentId, target_id: targetPageId, ref_count: 1 })
        }
      }
    }
    // #2298 count-then-cap — the real backend ships a `PageLinksResponse`
    // envelope. The mock world never caps, so `total` is always the full
    // edge count and `truncated` is always false.
    return { edges: pageLinks, total: pageLinks.length, truncated: false }
  },

  // ---------------------------------------------------------------------------
  // Logging commands (fire-and-forget)
  // ---------------------------------------------------------------------------

  fetch_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return {
      url: a['url'],
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: Date.now(),
      auth_required: false,
      not_found: false,
    }
  },

  get_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return {
      url: a['url'],
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: Date.now(),
      auth_required: false,
      not_found: false,
    }
  },

  // ---------------------------------------------------------------------------
  // MCP read-only / read-write servers
  //
  // The real backend manages a Unix-domain-socket lifecycle that can't run
  // inside Playwright. The mock returns disabled status snapshots so
  // AgentAccessSettingsTab renders its toggles + socket-path readouts
  // without per-call stubbing. Toggle commands echo the requested value;
  // disconnect commands return `null` since they have no observable
  // effect on the mock state.
  // ---------------------------------------------------------------------------
} satisfies Pick<
  TypedHandlers,
  | 'get_backlinks'
  | 'query_backlinks_filtered'
  | 'count_backlinks_batch'
  | 'list_backlinks_grouped'
  | 'list_unlinked_references'
  | 'list_page_links'
  | 'fetch_link_metadata'
  | 'get_link_metadata'
>
