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

export function setupMock(): void {
  // Fake the window label so getCurrent() works
  mockWindows('main')

  mockIPC((cmd, args) => {
    switch (cmd) {
      case 'list_blocks': {
        const a = args as Record<string, unknown>
        let items = [...blocks.values()].filter((b) => !(b.deleted_at as string | null))
        if (a.blockType) items = items.filter((b) => b.block_type === a.blockType)
        if (a.parentId) items = items.filter((b) => b.parent_id === a.parentId)
        if (a.showDeleted) items = [...blocks.values()].filter((b) => b.deleted_at)
        return { items, next_cursor: null, has_more: false }
      }

      case 'create_block': {
        const a = args as Record<string, unknown>
        const id = fakeId()
        const row = {
          id,
          block_type: a.blockType as string,
          content: (a.content as string) ?? null,
          parent_id: (a.parentId as string) ?? null,
          position: (a.position as number) ?? 0,
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

      default:
        return null
    }
  })
}
