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

// Property store: block_id → key → PropertyRow
const properties: Map<string, Map<string, Record<string, unknown>>> = new Map()

// Block-tag associations: block_id → Set<tag_id>
const blockTags: Map<string, Set<string>> = new Map()

// Op log for undo/redo/history
interface MockOpLogEntry {
  [key: string]: unknown
  device_id: string
  seq: number
  op_type: string
  payload: string
  created_at: string
}
const opLog: MockOpLogEntry[] = []
let opSeqCounter = 0

function pushOp(opType: string, payload: Record<string, unknown>): MockOpLogEntry {
  opSeqCounter += 1
  const entry: MockOpLogEntry = {
    device_id: 'mock-device',
    seq: opSeqCounter,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
  }
  opLog.push(entry)
  return entry
}

// ---------------------------------------------------------------------------
// Seed data IDs — exported for tests and external reference
// ---------------------------------------------------------------------------

function todayDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Deterministic IDs for seed data so tests and components can reference them.
 *  Must be valid 26-char Crockford base32 ULIDs so [[id]] and #[id] tokens
 *  parse correctly through the markdown serializer. */
export const SEED_IDS = {
  PAGE_GETTING_STARTED: '00000000000000000000PAGE01',
  PAGE_QUICK_NOTES: '00000000000000000000PAGE02',
  PAGE_DAILY: '00000000000000000000PAGE03',
  BLOCK_GS_1: '0000000000000000000BLOCK01',
  BLOCK_GS_2: '0000000000000000000BLOCK02',
  BLOCK_GS_3: '0000000000000000000BLOCK03',
  BLOCK_GS_4: '0000000000000000000BLOCK04',
  BLOCK_GS_5: '0000000000000000000BLOCK05',
  BLOCK_DAILY_1: '0000000000000000000BLOCK06',
  BLOCK_DAILY_2: '0000000000000000000BLOCK07',
  BLOCK_QN_1: '0000000000000000000BLOCK08',
  BLOCK_QN_2: '0000000000000000000BLOCK09',
  TAG_WORK: '000000000000000000000TAG01',
  TAG_PERSONAL: '000000000000000000000TAG02',
  TAG_IDEA: '000000000000000000000TAG03',
  CONFLICT_01: '0000000000000000CONFLICT01',
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
  properties.clear()
  blockTags.clear()
  counter = 0
  opLog.length = 0
  opSeqCounter = 0

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
      `Use the sidebar to navigate between pages, tags, and search. See [[${SEED_IDS.PAGE_QUICK_NOTES}]] for tips.`,
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
      `Try tagging blocks with #[${SEED_IDS.TAG_WORK}] or #[${SEED_IDS.TAG_PERSONAL}] to organize your notes.`,
      SEED_IDS.PAGE_GETTING_STARTED,
      3,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_GS_5,
    makeBlock(
      SEED_IDS.BLOCK_GS_5,
      'content',
      '**Use the search panel** to find anything across all your pages.',
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

  // Conflict seed data — a conflict copy of BLOCK_GS_1 (edited on another device)
  const conflict1 = makeBlock(
    SEED_IDS.CONFLICT_01,
    'content',
    'Conflict version of block 1 (edited on another device)',
    SEED_IDS.BLOCK_GS_1,
    0,
  )
  conflict1.is_conflict = true
  blocks.set(SEED_IDS.CONFLICT_01, conflict1)

  // Content blocks — children of "Quick Notes" (with backlink to Getting Started)
  blocks.set(
    SEED_IDS.BLOCK_QN_1,
    makeBlock(
      SEED_IDS.BLOCK_QN_1,
      'content',
      `These notes complement the [[${SEED_IDS.PAGE_GETTING_STARTED}]] guide.`,
      SEED_IDS.PAGE_QUICK_NOTES,
      0,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_QN_2,
    makeBlock(
      SEED_IDS.BLOCK_QN_2,
      'content',
      'Jot down quick thoughts and *ideas* here.',
      SEED_IDS.PAGE_QUICK_NOTES,
      1,
    ),
  )
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
        pushOp('create_block', {
          block_id: id,
          content: row.content,
          parent_id: parentId,
          block_type: row.block_type,
          position,
        })
        return row
      }

      case 'edit_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (!b) throw new Error('not found')
        const oldContent = b.content as string | null
        b.content = a.toText as string
        pushOp('edit_block', { block_id: a.blockId, to_text: a.toText, from_text: oldContent })
        return b
      }

      case 'delete_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (b) b.deleted_at = new Date().toISOString()
        pushOp('delete_block', { block_id: a.blockId })
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
        pushOp('restore_block', { block_id: a.blockId })
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

      case 'batch_resolve': {
        const a = args as Record<string, unknown>
        const ids = a.ids as string[]
        return ids
          .map((id) => blocks.get(id))
          .filter(Boolean)
          .map((b) => ({
            id: b?.id as string,
            title: (b?.content as string | null) ?? null,
            block_type: b?.block_type as string,
            deleted: b?.deleted_at !== null,
          }))
      }

      case 'move_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a.blockId as string)
        if (!b) throw new Error('not found')
        const oldParentId = b.parent_id
        const oldPosition = b.position
        b.parent_id = a.newParentId as string | null
        b.position = a.newPosition as number
        pushOp('move_block', {
          block_id: a.blockId,
          new_parent_id: b.parent_id,
          new_position: b.position,
          old_parent_id: oldParentId,
          old_position: oldPosition,
        })
        return { block_id: a.blockId, new_parent_id: b.parent_id, new_position: b.position }
      }

      case 'add_tag': {
        const a = args as Record<string, unknown>
        const blockId = a.blockId as string
        const tagId = a.tagId as string
        if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
        blockTags.get(blockId)?.add(tagId)
        pushOp('add_tag', { block_id: blockId, tag_id: tagId })
        return { block_id: blockId, tag_id: tagId }
      }

      case 'remove_tag': {
        const a = args as Record<string, unknown>
        const blockId = a.blockId as string
        const tagId = a.tagId as string
        blockTags.get(blockId)?.delete(tagId)
        pushOp('remove_tag', { block_id: blockId, tag_id: tagId })
        return { block_id: blockId, tag_id: tagId }
      }

      case 'get_backlinks': {
        const a = args as Record<string, unknown>
        const targetId = a.blockId as string
        // Scan all blocks for [[ULID]] tokens matching the target
        const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
        const backlinkItems = [...blocks.values()].filter((b) => {
          if (b.deleted_at) return false
          const content = (b.content as string) ?? ''
          for (const m of content.matchAll(LINK_RE)) {
            if (m[1] === targetId) return true
          }
          return false
        })
        return { items: backlinkItems, next_cursor: null, has_more: false }
      }

      case 'get_block_history': {
        return { items: [], next_cursor: null, has_more: false }
      }

      case 'list_page_history': {
        const items = [...opLog].reverse().map((o) => ({
          device_id: o.device_id,
          seq: o.seq,
          op_type: o.op_type,
          payload: o.payload,
          created_at: o.created_at,
        }))
        return { items, next_cursor: null, has_more: false }
      }

      case 'revert_ops': {
        const a = args as Record<string, unknown>
        const ops = a.ops as Array<{ device_id: string; seq: number }>
        const results: Array<Record<string, unknown>> = []

        const sorted = [...ops].sort((x, y) => y.seq - x.seq)

        for (const opRef of sorted) {
          const target = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
          if (!target) continue

          const payload = JSON.parse(target.payload) as Record<string, unknown>

          if (target.op_type === 'create_block') {
            const b = blocks.get(payload.block_id as string)
            if (b) b.deleted_at = new Date().toISOString()
          } else if (target.op_type === 'delete_block') {
            const b = blocks.get(payload.block_id as string)
            if (b) b.deleted_at = null
          } else if (target.op_type === 'edit_block') {
            const b = blocks.get(payload.block_id as string)
            if (b) b.content = (payload.from_text as string | null) ?? null
          } else if (target.op_type === 'move_block') {
            const b = blocks.get(payload.block_id as string)
            if (b) {
              b.parent_id = payload.old_parent_id as string | null
              b.position = payload.old_position as number
            }
          } else if (target.op_type === 'restore_block') {
            const b = blocks.get(payload.block_id as string)
            if (b) b.deleted_at = new Date().toISOString()
          }

          const newOp = pushOp(`revert_${target.op_type}`, { reverted: target })
          results.push(newOp)
        }

        return results
      }

      case 'get_conflicts': {
        const items = [...blocks.values()].filter((b) => b.is_conflict === true && !b.deleted_at)
        return { items, next_cursor: null, has_more: false }
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
        const a = args as Record<string, unknown>
        const tagIds = a.tagIds as string[]
        // Find blocks that have ALL the specified tags
        const items = [...blocks.values()].filter((b) => {
          if (b.deleted_at) return false
          const tags = blockTags.get(b.id as string)
          if (!tags) return false
          return tagIds.every((tid) => tags.has(tid))
        })
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
        const a = args as Record<string, unknown>
        const blockId = a.blockId as string
        const tagSet = blockTags.get(blockId)
        if (!tagSet || tagSet.size === 0) return []
        return [...tagSet].map((tagId) => {
          const tagBlock = blocks.get(tagId)
          return {
            tag_id: tagId,
            name: tagBlock ? ((tagBlock.content as string) ?? '') : tagId,
            usage_count: 0,
            updated_at: new Date().toISOString(),
          }
        })
      }

      case 'set_property': {
        const a = args as Record<string, unknown>
        const blockId = a.blockId as string
        const key = a.key as string
        if (!properties.has(blockId)) {
          properties.set(blockId, new Map())
        }
        properties.get(blockId)?.set(key, {
          key,
          value_text: (a.valueText as string | null) ?? null,
          value_num: (a.valueNum as number | null) ?? null,
          value_date: (a.valueDate as string | null) ?? null,
          value_ref: (a.valueRef as string | null) ?? null,
        })
        return null
      }

      case 'delete_property': {
        const a = args as Record<string, unknown>
        const blockId = a.blockId as string
        const key = a.key as string
        const blockProps = properties.get(blockId)
        if (blockProps) blockProps.delete(key)
        return null
      }

      case 'get_properties': {
        const a = args as Record<string, unknown>
        const blockId = a.blockId as string
        const blockProps = properties.get(blockId)
        if (!blockProps) return []
        return [...blockProps.values()]
      }

      case 'get_batch_properties': {
        const a = args as Record<string, unknown>
        const blockIds = a.blockIds as string[]
        const result: Record<string, Record<string, unknown>[]> = {}
        for (const id of blockIds) {
          const blockProps = properties.get(id)
          result[id] = blockProps ? [...blockProps.values()] : []
        }
        return result
      }

      case 'undo_page_op': {
        const a = args as Record<string, unknown>
        const undoDepth = (a.undoDepth as number) ?? 0

        const undoableOps = opLog.filter(
          (o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'),
        )
        const targetIndex = undoableOps.length - 1 - undoDepth
        if (targetIndex < 0) throw new Error('no undoable op found')
        const target = undoableOps[targetIndex]

        const payload = JSON.parse(target.payload) as Record<string, unknown>
        let reverseOpType = 'edit_block'
        if (target.op_type === 'create_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.deleted_at = new Date().toISOString()
          reverseOpType = 'delete_block'
        } else if (target.op_type === 'delete_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.deleted_at = null
          reverseOpType = 'restore_block'
        } else if (target.op_type === 'edit_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.content = (payload.from_text as string | null) ?? null
          reverseOpType = 'edit_block'
        } else if (target.op_type === 'move_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) {
            b.parent_id = payload.old_parent_id as string | null
            b.position = payload.old_position as number
          }
          reverseOpType = 'move_block'
        } else if (target.op_type === 'restore_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.deleted_at = new Date().toISOString()
          reverseOpType = 'delete_block'
        }

        const newOp = pushOp(`undo_${reverseOpType}`, { reversed: target })
        return {
          reversed_op: { device_id: target.device_id, seq: target.seq },
          new_op: {
            device_id: newOp.device_id,
            seq: newOp.seq,
            op_type: reverseOpType,
            payload: newOp.payload,
            created_at: newOp.created_at,
          },
          is_redo: false,
        }
      }

      case 'redo_page_op': {
        const a = args as Record<string, unknown>
        const undoSeq = a.undoSeq as number

        // The frontend stores reversed_op (the original op's ref) in the redo
        // stack, so undoSeq is the original op's seq. Find and re-apply it.
        const originalOp = opLog.find((o) => o.seq === undoSeq)
        if (!originalOp) throw new Error('op not found for redo')

        const payload = JSON.parse(originalOp.payload) as Record<string, unknown>

        let redoOpType = 'edit_block'
        if (originalOp.op_type === 'create_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.deleted_at = null
          redoOpType = 'create_block'
        } else if (originalOp.op_type === 'delete_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.deleted_at = new Date().toISOString()
          redoOpType = 'delete_block'
        } else if (originalOp.op_type === 'edit_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.content = (payload.to_text as string | null) ?? null
          redoOpType = 'edit_block'
        } else if (originalOp.op_type === 'move_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) {
            b.parent_id = payload.new_parent_id as string | null
            b.position = payload.new_position as number
          }
          redoOpType = 'move_block'
        } else if (originalOp.op_type === 'restore_block') {
          const b = blocks.get(payload.block_id as string)
          if (b) b.deleted_at = null
          redoOpType = 'restore_block'
        }

        const newOp = pushOp(`redo_${redoOpType}`, { re_applied: originalOp })
        return {
          reversed_op: { device_id: originalOp.device_id, seq: originalOp.seq },
          new_op: {
            device_id: newOp.device_id,
            seq: newOp.seq,
            op_type: redoOpType,
            payload: newOp.payload,
            created_at: newOp.created_at,
          },
          is_redo: true,
        }
      }

      default:
        return null
    }
  })
}
