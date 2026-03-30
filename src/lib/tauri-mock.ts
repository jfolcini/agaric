/**
 * Browser mock for Tauri IPC — enables the frontend to render in Chrome
 * without the Tauri backend. Used for visual development/debugging only.
 *
 * Activated automatically when `window.__TAURI_INTERNALS__` is absent
 * (i.e., running in a regular browser instead of the Tauri webview).
 */

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

let counter = 0
function fakeId(): string {
  counter += 1
  return `MOCK${String(counter).padStart(8, '0')}`
}

const blocks: Map<string, Record<string, unknown>> = new Map()

// ---------------------------------------------------------------------------
// Seed data IDs — exported for tests and external reference
// ---------------------------------------------------------------------------

function todayDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Deterministic IDs for seed data so tests and components can reference them. */
export const SEED_IDS = {
  PAGE_GETTING_STARTED: 'SEED_PAGE_001',
  PAGE_QUICK_NOTES: 'SEED_PAGE_002',
  PAGE_DAILY: 'SEED_PAGE_003',
  BLOCK_GS_1: 'SEED_BLOCK_001',
  BLOCK_GS_2: 'SEED_BLOCK_002',
  BLOCK_GS_3: 'SEED_BLOCK_003',
  BLOCK_GS_4: 'SEED_BLOCK_004',
  BLOCK_GS_5: 'SEED_BLOCK_005',
  BLOCK_DAILY_1: 'SEED_BLOCK_006',
  BLOCK_DAILY_2: 'SEED_BLOCK_007',
  TAG_WORK: 'SEED_TAG_001',
  TAG_PERSONAL: 'SEED_TAG_002',
  TAG_IDEA: 'SEED_TAG_003',
} as const

function makeBlock(
  id: string,
  blockType: string,
  content: string | null,
  parentId: string | null,
  position: number,
): Record<string, unknown> {
  return {
    id,
    block_type: blockType,
    content,
    parent_id: parentId,
    position,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

function seedBlocks(): void {
  blocks.clear()
  counter = 0

  const today = todayDate()

  // Pages
  blocks.set(
    SEED_IDS.PAGE_GETTING_STARTED,
    makeBlock(SEED_IDS.PAGE_GETTING_STARTED, 'page', 'Getting Started', null, 0),
  )
  blocks.set(
    SEED_IDS.PAGE_QUICK_NOTES,
    makeBlock(SEED_IDS.PAGE_QUICK_NOTES, 'page', 'Quick Notes', null, 1),
  )
  blocks.set(SEED_IDS.PAGE_DAILY, makeBlock(SEED_IDS.PAGE_DAILY, 'page', today, null, 2))

  // Content blocks — children of "Getting Started"
  blocks.set(
    SEED_IDS.BLOCK_GS_1,
    makeBlock(
      SEED_IDS.BLOCK_GS_1,
      'content',
      'Welcome to Block Notes! This is your personal knowledge base.',
      SEED_IDS.PAGE_GETTING_STARTED,
      0,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_GS_2,
    makeBlock(
      SEED_IDS.BLOCK_GS_2,
      'content',
      'Use the sidebar to navigate between pages, tags, and search.',
      SEED_IDS.PAGE_GETTING_STARTED,
      1,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_GS_3,
    makeBlock(
      SEED_IDS.BLOCK_GS_3,
      'content',
      'Create new blocks by pressing Enter at the end of any block.',
      SEED_IDS.PAGE_GETTING_STARTED,
      2,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_GS_4,
    makeBlock(
      SEED_IDS.BLOCK_GS_4,
      'content',
      'Try tagging blocks with #work or #personal to organize your notes.',
      SEED_IDS.PAGE_GETTING_STARTED,
      3,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_GS_5,
    makeBlock(
      SEED_IDS.BLOCK_GS_5,
      'content',
      'Use the search panel to find anything across all your pages.',
      SEED_IDS.PAGE_GETTING_STARTED,
      4,
    ),
  )

  // Daily page children
  blocks.set(
    SEED_IDS.BLOCK_DAILY_1,
    makeBlock(
      SEED_IDS.BLOCK_DAILY_1,
      'content',
      'Morning standup notes go here',
      SEED_IDS.PAGE_DAILY,
      0,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_DAILY_2,
    makeBlock(
      SEED_IDS.BLOCK_DAILY_2,
      'content',
      'Review project milestones',
      SEED_IDS.PAGE_DAILY,
      1,
    ),
  )

  // Tags
  blocks.set(SEED_IDS.TAG_WORK, makeBlock(SEED_IDS.TAG_WORK, 'tag', 'work', null, 0))
  blocks.set(SEED_IDS.TAG_PERSONAL, makeBlock(SEED_IDS.TAG_PERSONAL, 'tag', 'personal', null, 1))
  blocks.set(SEED_IDS.TAG_IDEA, makeBlock(SEED_IDS.TAG_IDEA, 'tag', 'idea', null, 2))
}

/** Reset mock state — clears and re-seeds the in-memory store. Useful for tests. */
export function resetMock(): void {
  seedBlocks()
}

export function setupMock(): void {
  // Fake the window label so getCurrent() works
  mockWindows('main')

  // Populate seed data for browser preview
  seedBlocks()

  mockIPC((cmd, args) => {
    switch (cmd) {
      case 'list_blocks': {
        const a = args as Record<string, unknown>
        let items: Record<string, unknown>[]
        if (a.showDeleted) {
          items = [...blocks.values()].filter((b) => b.deleted_at)
        } else {
          items = [...blocks.values()].filter((b) => !(b.deleted_at as string | null))
        }
        if (a.blockType) items = items.filter((b) => b.block_type === a.blockType)
        if (a.parentId) items = items.filter((b) => b.parent_id === a.parentId)
        // Sort by position for consistent ordering (matches real backend)
        items.sort((x, y) => ((x.position as number) ?? 0) - ((y.position as number) ?? 0))
        return { items, next_cursor: null, has_more: false }
      }

      case 'create_block': {
        const a = args as Record<string, unknown>
        const id = fakeId()
        const parentId = (a.parentId as string) ?? null
        // Compute position: if not provided, append after existing siblings
        let position = a.position as number | undefined
        if (position == null) {
          const siblings = [...blocks.values()].filter(
            (b) => b.parent_id === parentId && !b.deleted_at,
          )
          position = siblings.length
        }
        const row = {
          id,
          block_type: a.blockType as string,
          content: (a.content as string) ?? null,
          parent_id: parentId,
          position,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
        }
        blocks.set(id, row)
        return row
      }

      case 'edit_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (!b) throw new Error('not found')
        b.content = a.toText as string
        return b
      }

      case 'delete_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (b) b.deleted_at = new Date().toISOString()
        return {
          block_id: a.blockId,
          deleted_at: new Date().toISOString(),
          descendants_affected: 0,
        }
      }

      case 'restore_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (b) b.deleted_at = null
        return { block_id: a.blockId, restored_count: 1 }
      }

      case 'purge_block': {
        const a = args as Record<string, unknown>
        blocks.delete(a.blockId as string)
        return { block_id: a.blockId, purged_count: 1 }
      }

      case 'get_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (!b) throw new Error('not found')
        return b
      }

      case 'move_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (!b) throw new Error('not found')
        b.parent_id = a.newParentId as string | null
        b.position = a.newPosition as number
        return { block_id: a.blockId, new_parent_id: b.parent_id, new_position: b.position }
      }

      case 'add_tag': {
        const a = args as Record<string, unknown>
        return { block_id: a.blockId, tag_id: a.tagId }
      }

      case 'remove_tag': {
        const a = args as Record<string, unknown>
        return { block_id: a.blockId, tag_id: a.tagId }
      }

      case 'get_backlinks': {
        return { items: [], next_cursor: null, has_more: false }
      }

      case 'get_block_history': {
        return { items: [], next_cursor: null, has_more: false }
      }

      case 'get_conflicts': {
        return { items: [], next_cursor: null, has_more: false }
      }

      case 'search_blocks': {
        const a = args as Record<string, unknown>
        const query = ((a.query as string) ?? '').toLowerCase()
        if (!query) return { items: [], next_cursor: null, has_more: false }
        const items = [...blocks.values()].filter(
          (b) =>
            !(b.deleted_at as string | null) &&
            ((b.content as string) ?? '').toLowerCase().includes(query),
        )
        return { items, next_cursor: null, has_more: false }
      }

      case 'get_status': {
        return {
          foreground_queue_depth: 0,
          background_queue_depth: 0,
          total_ops_dispatched: 0,
          total_background_dispatched: 0,
          fg_high_water: 0,
          bg_high_water: 0,
        }
      }

      case 'query_by_tags': {
        // Simplified mock: return all non-deleted blocks as fallback
        // (real backend filters by block_tags join table)
        const items = [...blocks.values()].filter((b) => !(b.deleted_at as string | null))
        return { items, next_cursor: null, has_more: false }
      }

      case 'list_tags_by_prefix': {
        const a = args as Record<string, unknown>
        const prefix = ((a.prefix as string) ?? '').toLowerCase()
        const tagBlocks = [...blocks.values()].filter(
          (b) =>
            b.block_type === 'tag' &&
            !(b.deleted_at as string | null) &&
            ((b.content as string) ?? '').toLowerCase().startsWith(prefix),
        )
        return tagBlocks.map((b) => ({
          tag_id: b.id as string,
          name: (b.content as string) ?? '',
          usage_count: 0,
          updated_at: new Date().toISOString(),
        }))
      }

      case 'list_tags_for_block': {
        // In-memory mock doesn't track tag associations
        return []
      }

      default:
        return null
    }
  })
}
