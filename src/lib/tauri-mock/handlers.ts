/**
 * Tauri mock — command dispatch layer.
 *
 * Every mocked command has a handler in `HANDLERS`, keyed by command name. The
 * handler receives the raw IPC args object and returns the mock response (or
 * throws to surface an error to callers). `dispatch()` is the single entry
 * point used by `setupMock()`.
 *
 * Converting the previous switch/case chain to a map makes coverage auditable:
 * `Object.keys(HANDLERS)` is the canonical list of mocked commands and can be
 * diffed against the real backend's command surface in `src/lib/bindings.ts`.
 */

import { applyRevertForOp } from './revert'
import {
  attachments,
  blocks,
  blockTags,
  fakeId,
  type MockOpLogEntry,
  makeBlock,
  opLog,
  pageAliases,
  properties,
  propertyDefs,
  pushOp,
} from './seed'

type Handler = (args: unknown) => unknown

// `list_projected_agenda` and the draft/peer stubs all return the same null-ish
// payload; define them once and alias to keep the map readable.
const returnNull: Handler = () => null
const returnUndefined: Handler = () => undefined
const returnEmptyArray: Handler = () => []

export const HANDLERS: Record<string, Handler> = {
  // ---------------------------------------------------------------------------
  // Block listing & CRUD
  // ---------------------------------------------------------------------------

  list_blocks: (args) => {
    const a = args as Record<string, unknown>
    let items: Record<string, unknown>[]
    if (a['showDeleted']) {
      items = [...blocks.values()].filter((b) => b['deleted_at'])
    } else {
      items = [...blocks.values()].filter((b) => !(b['deleted_at'] as string | null))
    }
    // Exclude conflict copies from normal queries (matches real backend).
    // Conflicts are only returned via get_conflicts.
    items = items.filter((b) => !b['is_conflict'])
    if (a['blockType']) items = items.filter((b) => b['block_type'] === a['blockType'])
    if (a['parentId']) items = items.filter((b) => b['parent_id'] === a['parentId'])
    // Tag filtering
    if (a['tagId']) {
      const tagId = a['tagId'] as string
      items = items.filter((b) => {
        const tags = blockTags.get(b['id'] as string)
        return tags?.has(tagId) ?? false
      })
    }
    // Agenda date filtering — matches blocks by due_date or scheduled_date
    if (a['agendaDate']) {
      const dateStr = a['agendaDate'] as string
      const source = (a['agendaSource'] as string | null) ?? null
      if (source === 'column:due_date') {
        items = items.filter((b) => b['due_date'] === dateStr)
      } else if (source === 'column:scheduled_date') {
        items = items.filter((b) => b['scheduled_date'] === dateStr)
      } else {
        items = items.filter((b) => b['due_date'] === dateStr || b['scheduled_date'] === dateStr)
      }
    }
    // Agenda date range filtering — for weekly/monthly views
    if (a['agendaDateRange']) {
      const range = a['agendaDateRange'] as { start: string; end: string }
      const source = (a['agendaSource'] as string | null) ?? null
      items = items.filter((b) => {
        const due = b['due_date'] as string | null
        const sched = b['scheduled_date'] as string | null
        const inRange = (d: string | null) => d != null && d >= range.start && d <= range.end
        if (source === 'column:due_date') return inRange(due)
        if (source === 'column:scheduled_date') return inRange(sched)
        return inRange(due) || inRange(sched)
      })
    }
    // Sort by position for consistent ordering (matches real backend)
    items.sort((x, y) => ((x['position'] as number) ?? 0) - ((y['position'] as number) ?? 0))
    return { items, next_cursor: null, has_more: false }
  },

  list_undated_tasks: () => {
    const items = [...blocks.values()].filter(
      (b) =>
        b['todo_state'] !== null &&
        b['due_date'] === null &&
        b['scheduled_date'] === null &&
        !b['deleted_at'],
    )
    return { items, next_cursor: null, has_more: false }
  },

  create_block: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const parentId = (a['parentId'] as string) ?? null
    // Compute position: if not provided, append after existing siblings
    let position = a['position'] as number | undefined
    if (position == null) {
      const siblings = [...blocks.values()].filter(
        (b) => b['parent_id'] === parentId && !b['deleted_at'],
      )
      position = siblings.length
    }
    const row = {
      id,
      block_type: a['blockType'] as string,
      content: (a['content'] as string) ?? null,
      parent_id: parentId,
      page_id: (a['blockType'] as string) === 'page' ? id : parentId,
      position,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
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
  },

  edit_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const oldContent = b['content'] as string | null
    b['content'] = a['toText'] as string
    pushOp('edit_block', {
      block_id: a['blockId'],
      to_text: a['toText'],
      from_text: oldContent,
    })
    return b
  },

  delete_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (b) b['deleted_at'] = new Date().toISOString()
    pushOp('delete_block', { block_id: a['blockId'] })
    return {
      block_id: a['blockId'],
      deleted_at: new Date().toISOString(),
      descendants_affected: 0,
    }
  },

  restore_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (b) b['deleted_at'] = null
    pushOp('restore_block', { block_id: a['blockId'] })
    return { block_id: a['blockId'], restored_count: 1 }
  },

  purge_block: (args) => {
    const a = args as Record<string, unknown>
    blocks.delete(a['blockId'] as string)
    return { block_id: a['blockId'], purged_count: 1 }
  },

  restore_all_deleted: () => {
    let count = 0
    for (const b of blocks.values()) {
      if (b['deleted_at']) {
        b['deleted_at'] = null
        count++
      }
    }
    return { affected_count: count }
  },

  purge_all_deleted: () => {
    let count = 0
    for (const [id, b] of blocks.entries()) {
      if (b['deleted_at']) {
        blocks.delete(id)
        count++
      }
    }
    return { affected_count: count }
  },

  get_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    return b
  },

  batch_resolve: (args) => {
    const a = args as Record<string, unknown>
    const ids = a['ids'] as string[]
    return ids
      .map((id) => blocks.get(id))
      .filter(Boolean)
      .map((b) => ({
        id: b?.['id'] as string,
        title: (b?.['content'] as string | null) ?? null,
        block_type: b?.['block_type'] as string,
        deleted: b?.['deleted_at'] !== null,
      }))
  },

  move_block: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const oldParentId = b['parent_id']
    const oldPosition = b['position']
    b['parent_id'] = a['newParentId'] as string | null
    b['position'] = a['newPosition'] as number
    // Compute page_id from new parent (like the real backend)
    if (a['newParentId']) {
      const newParent = blocks.get(a['newParentId'] as string)
      if (newParent) {
        b['page_id'] =
          newParent['block_type'] === 'page'
            ? (newParent['id'] as string)
            : (newParent['page_id'] as string | null)
      }
    } else {
      b['page_id'] = null
    }
    pushOp('move_block', {
      block_id: a['blockId'],
      new_parent_id: b['parent_id'],
      new_position: b['position'],
      old_parent_id: oldParentId,
      old_position: oldPosition,
    })
    return {
      block_id: a['blockId'],
      new_parent_id: b['parent_id'],
      new_position: b['position'],
    }
  },

  // ---------------------------------------------------------------------------
  // Tag associations
  // ---------------------------------------------------------------------------

  add_tag: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagId = a['tagId'] as string
    if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
    blockTags.get(blockId)?.add(tagId)
    pushOp('add_tag', { block_id: blockId, tag_id: tagId })
    return { block_id: blockId, tag_id: tagId }
  },

  remove_tag: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagId = a['tagId'] as string
    blockTags.get(blockId)?.delete(tagId)
    pushOp('remove_tag', { block_id: blockId, tag_id: tagId })
    return { block_id: blockId, tag_id: tagId }
  },

  // ---------------------------------------------------------------------------
  // Backlinks & history
  // ---------------------------------------------------------------------------

  get_backlinks: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // Scan all blocks for [[ULID]] tokens matching the target
    const LINK_RE = /\[\[([0-9A-Z]{26})\]\]/g
    const backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE)) {
        if (m[1] === targetId) return true
      }
      return false
    })
    return { items: backlinkItems, next_cursor: null, has_more: false }
  },

  get_block_history: () => {
    return { items: [], next_cursor: null, has_more: false }
  },

  list_page_history: () => {
    const items = [...opLog].reverse().map((o) => ({
      device_id: o.device_id,
      seq: o.seq,
      op_type: o.op_type,
      payload: o.payload,
      created_at: o.created_at,
    }))
    return { items, next_cursor: null, has_more: false }
  },

  revert_ops: (args) => {
    const a = args as Record<string, unknown>
    const ops = a['ops'] as Array<{ device_id: string; seq: number }>
    const results: Array<Record<string, unknown>> = []

    const sorted = [...ops].sort((x, y) => y.seq - x.seq)

    for (const opRef of sorted) {
      const target = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
      if (!target) continue

      applyRevertForOp(target, blocks)

      const newOp = pushOp(`revert_${target.op_type}`, { reverted: target })
      results.push(newOp)
    }

    return results
  },

  get_conflicts: () => {
    const items = [...blocks.values()].filter((b) => b['is_conflict'] === true && !b['deleted_at'])
    return { items, next_cursor: null, has_more: false }
  },

  search_blocks: (args) => {
    const a = args as Record<string, unknown>
    const query = ((a['query'] as string) ?? '').toLowerCase()
    if (!query) return { items: [], next_cursor: null, has_more: false }
    const items = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        ((b['content'] as string) ?? '').toLowerCase().includes(query),
    )
    return { items, next_cursor: null, has_more: false }
  },

  get_status: () => {
    return {
      foreground_queue_depth: 0,
      background_queue_depth: 0,
      total_ops_dispatched: 0,
      total_background_dispatched: 0,
      fg_high_water: 0,
      bg_high_water: 0,
      fg_errors: 0,
      bg_errors: 0,
      fg_panics: 0,
      bg_panics: 0,
    }
  },

  // ---------------------------------------------------------------------------
  // Properties & tags queries
  // ---------------------------------------------------------------------------

  query_by_property: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const valueText = (a['valueText'] as string | null) ?? null
    const valueDate = (a['valueDate'] as string | null) ?? null
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      const blockProps = properties.get(b['id'] as string)
      if (!blockProps) return false
      const prop = blockProps.get(key)
      if (!prop) return false
      if (valueText !== null) return prop['value_text'] === valueText
      if (valueDate !== null) return prop['value_date'] === valueDate
      return true
    })
    return { items, next_cursor: null, has_more: false }
  },

  query_by_tags: (args) => {
    const a = args as Record<string, unknown>
    const tagIds = (a['tagIds'] as string[]) ?? []
    const prefixes = (a['prefixes'] as string[] | null) ?? []
    const mode = ((a['mode'] as string) ?? 'and').toLowerCase()

    // Resolve prefixes to tag IDs by matching tag block content
    const resolvedFromPrefix: string[] = []
    for (const prefix of prefixes) {
      const lp = prefix.toLowerCase()
      for (const [, b] of blocks) {
        if (
          b['block_type'] === 'tag' &&
          !b['deleted_at'] &&
          ((b['content'] as string) ?? '').toLowerCase().startsWith(lp)
        ) {
          resolvedFromPrefix.push(b['id'] as string)
        }
      }
    }

    const allTagIds = [...tagIds, ...resolvedFromPrefix]

    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      const tags = blockTags.get(b['id'] as string)
      if (!tags || tags.size === 0) return false
      if (allTagIds.length === 0) return false
      if (mode === 'or') {
        return allTagIds.some((tid) => tags.has(tid))
      }
      // Default: AND — block must have ALL specified tags
      return allTagIds.every((tid) => tags.has(tid))
    })
    return { items, next_cursor: null, has_more: false }
  },

  list_tags_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const prefix = ((a['prefix'] as string) ?? '').toLowerCase()
    const tagBlocks = [...blocks.values()].filter(
      (b) =>
        b['block_type'] === 'tag' &&
        !(b['deleted_at'] as string | null) &&
        ((b['content'] as string) ?? '').toLowerCase().startsWith(prefix),
    )
    return tagBlocks.map((b) => ({
      tag_id: b['id'] as string,
      name: (b['content'] as string) ?? '',
      usage_count: 0,
      updated_at: new Date().toISOString(),
    }))
  },

  list_tags_for_block: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const tagSet = blockTags.get(blockId)
    if (!tagSet || tagSet.size === 0) return []
    return [...tagSet]
  },

  set_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    if (!properties.has(blockId)) {
      properties.set(blockId, new Map())
    }
    properties.get(blockId)?.set(key, {
      key,
      value_text: (a['valueText'] as string | null) ?? null,
      value_num: (a['valueNum'] as number | null) ?? null,
      value_date: (a['valueDate'] as string | null) ?? null,
      value_ref: (a['valueRef'] as string | null) ?? null,
    })
    const b = blocks.get(blockId)
    return b ? { ...b } : null
  },

  delete_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    const blockProps = properties.get(blockId)
    if (blockProps) blockProps.delete(key)
    return null
  },

  get_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const blockProps = properties.get(blockId)
    if (!blockProps) return []
    return [...blockProps.values()]
  },

  get_batch_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = a['blockIds'] as string[]
    const result: Record<string, Record<string, unknown>[]> = {}
    for (const id of blockIds) {
      const blockProps = properties.get(id)
      result[id] = blockProps ? [...blockProps.values()] : []
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  undo_page_op: (args) => {
    const a = args as Record<string, unknown>
    const undoDepth = (a['undoDepth'] as number) ?? 0

    const undoableOps = opLog.filter(
      (o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'),
    )
    const targetIndex = undoableOps.length - 1 - undoDepth
    if (targetIndex < 0) throw new Error('no undoable op found')
    const target = undoableOps[targetIndex]
    if (!target) throw new Error('no undoable op found')

    const payload = JSON.parse(target.payload) as Record<string, unknown>
    let reverseOpType = 'edit_block'
    if (target.op_type === 'create_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = new Date().toISOString()
      reverseOpType = 'delete_block'
    } else if (target.op_type === 'delete_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = null
      reverseOpType = 'restore_block'
    } else if (target.op_type === 'edit_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['content'] = (payload['from_text'] as string | null) ?? null
      reverseOpType = 'edit_block'
    } else if (target.op_type === 'move_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) {
        b['parent_id'] = payload['old_parent_id'] as string | null
        b['position'] = payload['old_position'] as number
      }
      reverseOpType = 'move_block'
    } else if (target.op_type === 'restore_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = new Date().toISOString()
      reverseOpType = 'delete_block'
    }

    const newOp = pushOp(`undo_${reverseOpType}`, { reversed: target })
    return {
      reversed_op: { device_id: target.device_id, seq: target.seq },
      new_op_ref: { device_id: newOp.device_id, seq: newOp.seq },
      new_op_type: reverseOpType,
      is_redo: false,
    }
  },

  redo_page_op: (args) => {
    const a = args as Record<string, unknown>
    const undoSeq = a['undoSeq'] as number

    // The frontend stores reversed_op (the original op's ref) in the redo
    // stack, so undoSeq is the original op's seq. Find and re-apply it.
    const originalOp: MockOpLogEntry | undefined = opLog.find((o) => o.seq === undoSeq)
    if (!originalOp) throw new Error('op not found for redo')

    const payload = JSON.parse(originalOp.payload) as Record<string, unknown>

    let redoOpType = 'edit_block'
    if (originalOp.op_type === 'create_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = null
      redoOpType = 'create_block'
    } else if (originalOp.op_type === 'delete_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = new Date().toISOString()
      redoOpType = 'delete_block'
    } else if (originalOp.op_type === 'edit_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['content'] = (payload['to_text'] as string | null) ?? null
      redoOpType = 'edit_block'
    } else if (originalOp.op_type === 'move_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) {
        b['parent_id'] = payload['new_parent_id'] as string | null
        b['position'] = payload['new_position'] as number
      }
      redoOpType = 'move_block'
    } else if (originalOp.op_type === 'restore_block') {
      const b = blocks.get(payload['block_id'] as string)
      if (b) b['deleted_at'] = null
      redoOpType = 'restore_block'
    }

    const newOp = pushOp(`redo_${redoOpType}`, { re_applied: originalOp })
    return {
      reversed_op: { device_id: originalOp.device_id, seq: originalOp.seq },
      new_op_ref: { device_id: newOp.device_id, seq: newOp.seq },
      new_op_type: redoOpType,
      is_redo: true,
    }
  },

  query_backlinks_filtered: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    const filterList = (a['filters'] as Array<Record<string, unknown>> | null) ?? []

    // Scan all blocks for [[ULID]] tokens matching the target
    const LINK_RE_F = /\[\[([0-9A-Z]{26})\]\]/g
    let backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
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
        const query = ((filter['query'] as string) ?? '').toLowerCase()
        backlinkItems = backlinkItems.filter((b) =>
          ((b['content'] as string) ?? '').toLowerCase().includes(query),
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

  list_property_keys: () => {
    // Collect all distinct property keys from mock data
    const keys = new Set<string>()
    for (const blockProps of properties.values()) {
      for (const key of blockProps.keys()) {
        keys.add(key)
      }
    }
    // Always include common keys
    keys.add('todo')
    keys.add('priority')
    return [...keys].sort()
  },

  // ---------------------------------------------------------------------------
  // Sync / Peer-ref commands
  // ---------------------------------------------------------------------------

  list_peer_refs: () => [],
  get_peer_ref: returnNull,
  delete_peer_ref: returnUndefined,
  get_device_id: () => 'mock-device-id-0000',

  start_pairing: () => ({
    passphrase: 'alpha bravo charlie delta',
    qr_svg: '<svg></svg>',
    port: 8765,
  }),
  confirm_pairing: returnUndefined,
  cancel_pairing: returnUndefined,

  start_sync: (args) => {
    const a = args as Record<string, unknown>
    return {
      state: 'syncing',
      local_device_id: 'mock-device-id-0000',
      remote_device_id: a['peerId'],
      ops_received: 0,
      ops_sent: 0,
    }
  },

  cancel_sync: returnUndefined,

  // ---------------------------------------------------------------------------
  // Task properties (todo/priority/due/scheduled)
  // ---------------------------------------------------------------------------

  set_todo_state: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    b['todo_state'] = (a['state'] as string | null) ?? null
    pushOp('set_todo_state', { block_id: a['blockId'], state: b['todo_state'] })
    return { ...b }
  },

  set_priority: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    b['priority'] = (a['level'] as string | null) ?? null
    pushOp('set_priority', { block_id: a['blockId'], level: b['priority'] })
    return { ...b }
  },

  set_due_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    b['due_date'] = (a['date'] as string | null) ?? null
    pushOp('set_due_date', { block_id: a['blockId'], date: b['due_date'] })
    return { ...b }
  },

  set_scheduled_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    b['scheduled_date'] = (a['date'] as string | null) ?? null
    pushOp('set_scheduled_date', { block_id: a['blockId'], date: b['scheduled_date'] })
    return { ...b }
  },

  // ---------------------------------------------------------------------------
  // Batch count commands
  // ---------------------------------------------------------------------------

  count_agenda_batch: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    const result: Record<string, number> = {}
    for (const dateStr of dates) {
      const count = [...blocks.values()].filter(
        (b) =>
          !(b['deleted_at'] as string | null) &&
          (b['due_date'] === dateStr || b['scheduled_date'] === dateStr),
      ).length
      result[dateStr] = count
    }
    return result
  },

  count_agenda_batch_by_source: (args) => {
    const a = args as Record<string, unknown>
    const dates = a['dates'] as string[]
    const result: Record<string, Record<string, number>> = {}
    for (const dateStr of dates) {
      const sources: Record<string, number> = {}
      for (const b of blocks.values()) {
        if (b['deleted_at'] as string | null) continue
        if (b['due_date'] === dateStr) {
          sources['column:due_date'] = (sources['column:due_date'] ?? 0) + 1
        }
        if (b['scheduled_date'] === dateStr) {
          sources['column:scheduled_date'] = (sources['column:scheduled_date'] ?? 0) + 1
        }
      }
      if (Object.keys(sources).length > 0) {
        result[dateStr] = sources
      }
    }
    return result
  },

  count_backlinks_batch: (args) => {
    const a = args as Record<string, unknown>
    const pageIds = a['pageIds'] as string[]
    const LINK_RE_BATCH = /\[\[([0-9A-Z]{26})\]\]/g
    const result: Record<string, number> = {}
    for (const pid of pageIds) {
      const count = [...blocks.values()].filter((b) => {
        if (b['deleted_at']) return false
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

  // ---------------------------------------------------------------------------
  // Grouped backlinks + unlinked references
  // ---------------------------------------------------------------------------

  list_backlinks_grouped: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    const LINK_RE_G = /\[\[([0-9A-Z]{26})\]\]/g
    const backlinkItems = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
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
    const pageTitle = ((page['content'] as string) ?? '').toLowerCase()
    if (!pageTitle)
      return {
        groups: [],
        next_cursor: null,
        has_more: false,
        total_count: 0,
        filtered_count: 0,
        truncated: false,
      }
    // Find blocks that mention the page title as text but don't have a [[link]]
    const LINK_RE_UL = /\[\[([0-9A-Z]{26})\]\]/g
    const unlinked = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['id'] === pageId) return false
      if (b['parent_id'] === pageId) return false
      const content = (b['content'] as string) ?? ''
      if (!content.toLowerCase().includes(pageTitle)) return false
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

  compute_edit_diff: (args) => {
    const a = args as Record<string, unknown>
    const deviceId = a['deviceId'] as string
    const seq = a['seq'] as number
    const target = opLog.find((o) => o.device_id === deviceId && o.seq === seq)
    if (!target || target.op_type !== 'edit_block') return null
    const payload = JSON.parse(target.payload) as Record<string, unknown>
    const fromText = ((payload['from_text'] as string) ?? '').split(/\s+/)
    const toText = ((payload['to_text'] as string) ?? '').split(/\s+/)
    // Simple word-level diff: mark all old as removed, all new as added
    const spans: Array<Record<string, unknown>> = []
    if (fromText.length > 0 && fromText[0] !== '') {
      spans.push({ tag: 'Delete', value: fromText.join(' ') })
    }
    if (toText.length > 0 && toText[0] !== '') {
      spans.push({ tag: 'Insert', value: toText.join(' ') })
    }
    return spans
  },

  // ---------------------------------------------------------------------------
  // Property definition commands
  // ---------------------------------------------------------------------------

  create_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const def = {
      key,
      value_type: a['valueType'] as string,
      options: (a['options'] as string | null) ?? null,
      created_at: new Date().toISOString(),
    }
    propertyDefs.set(key, def)
    return def
  },

  list_property_defs: () => [...propertyDefs.values()],

  update_property_def_options: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const def = propertyDefs.get(key)
    if (!def) throw new Error('property definition not found')
    def['options'] = a['options'] as string
    return { ...def }
  },

  delete_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    propertyDefs.delete(key)
    return undefined
  },

  // ---------------------------------------------------------------------------
  // Peer name update
  // ---------------------------------------------------------------------------

  update_peer_name: returnUndefined,

  // ---------------------------------------------------------------------------
  // Page alias commands
  // ---------------------------------------------------------------------------

  set_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const aliases = a['aliases'] as string[]
    pageAliases.set(pid, aliases)
    return aliases
  },

  get_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    return pageAliases.get(pid) ?? []
  },

  resolve_page_by_alias: (args) => {
    const a = args as Record<string, unknown>
    const alias = (a['alias'] as string).toLowerCase()
    for (const [pid, aliases] of pageAliases.entries()) {
      if (aliases.some((al) => al.toLowerCase() === alias)) {
        const page = blocks.get(pid)
        return [pid, page ? ((page['content'] as string) ?? null) : null]
      }
    }
    return null
  },

  // ---------------------------------------------------------------------------
  // Markdown export
  // ---------------------------------------------------------------------------

  export_page_markdown: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const page = blocks.get(pid)
    if (!page) throw new Error('not found')
    const children = [...blocks.values()]
      .filter((b) => b['parent_id'] === pid && !(b['deleted_at'] as string | null))
      .sort((x, y) => ((x['position'] as number) ?? 0) - ((y['position'] as number) ?? 0))
    let md = `# ${(page['content'] as string) ?? 'Untitled'}\n\n`
    for (const child of children) {
      md += `- ${(child['content'] as string) ?? ''}\n`
    }
    return md
  },

  // ---------------------------------------------------------------------------
  // Markdown import (#660)
  // ---------------------------------------------------------------------------

  import_markdown: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    const filename = (a['filename'] as string | null) ?? null

    // Derive page title from filename (strip .md extension) or first heading
    let pageTitle = 'Untitled'
    if (filename) {
      pageTitle = filename.replace(/\.md$/i, '')
    }
    const lines = content.split('\n')
    // If first line is a heading, use it as the page title
    const headingMatch = lines[0]?.match(/^#+\s+(.+)/)
    if (headingMatch) {
      pageTitle = headingMatch[1]?.trim() as string
      lines.shift() // remove heading line from block content
    }

    // Create the page block
    const pageId = fakeId()
    const pageBlock = makeBlock(pageId, 'page', pageTitle, null, blocks.size)
    blocks.set(pageId, pageBlock)

    // Create content blocks from non-empty lines
    let blocksCreated = 0
    let position = 0
    for (const line of lines) {
      // Strip leading list markers (-, *, +, numbered) and whitespace
      const trimmed = line
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .trim()
      if (!trimmed) continue

      const blockId = fakeId()
      const block = makeBlock(blockId, 'content', trimmed, pageId, position)
      blocks.set(blockId, block)
      blocksCreated++
      position++
    }

    return {
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: 0,
      warnings: [] as string[],
    }
  },

  // ---------------------------------------------------------------------------
  // Attachment commands (F-7)
  // ---------------------------------------------------------------------------

  list_attachments: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    return [...attachments.values()].filter((att) => att['block_id'] === blockId)
  },

  add_attachment: (args) => {
    const a = args as Record<string, unknown>
    const row = {
      id: fakeId(),
      block_id: a['blockId'] as string,
      filename: a['filename'] as string,
      mime_type: a['mimeType'] as string,
      size_bytes: a['sizeBytes'] as number,
      fs_path: a['fsPath'] as string,
      created_at: new Date().toISOString(),
    }
    attachments.set(row.id, row)
    return row
  },

  delete_attachment: (args) => {
    const a = args as Record<string, unknown>
    attachments.delete(a['attachmentId'] as string)
    return null
  },

  // ---------------------------------------------------------------------------
  // Projected agenda (repeating tasks)
  // ---------------------------------------------------------------------------

  list_projected_agenda: returnEmptyArray,

  // ---------------------------------------------------------------------------
  // Draft autosave (F-17)
  // ---------------------------------------------------------------------------

  save_draft: returnNull,
  flush_draft: returnNull,
  delete_draft: returnNull,

  list_drafts: returnEmptyArray,

  // ---------------------------------------------------------------------------
  // Peer address
  // ---------------------------------------------------------------------------

  set_peer_address: returnNull,

  // ---------------------------------------------------------------------------
  // Page links for graph view (F-33)
  // ---------------------------------------------------------------------------

  list_page_links: () => {
    // Scan all non-deleted blocks for [[ULID]] page link tokens and
    // return page-to-page edges (source = parent page, target = linked page).
    const LINK_RE_PL = /\[\[([0-9A-Z]{26})\]\]/g
    const linkSet = new Set<string>()
    const pageLinks: Array<{ source_id: string; target_id: string }> = []
    for (const b of blocks.values()) {
      if (b['deleted_at']) continue
      const parentId = b['parent_id'] as string | null
      if (!parentId) continue
      // Only consider blocks whose parent is a page
      const parentBlock = blocks.get(parentId)
      if (!parentBlock || parentBlock['block_type'] !== 'page') continue
      const content = (b['content'] as string) ?? ''
      for (const m of content.matchAll(LINK_RE_PL)) {
        const targetPageId = m[1] as string
        // Ensure target is an existing non-deleted page
        const targetBlock = blocks.get(targetPageId)
        if (!targetBlock || targetBlock['block_type'] !== 'page' || targetBlock['deleted_at'])
          continue
        // Deduplicate edges
        const key = `${parentId}→${targetPageId}`
        if (!linkSet.has(key)) {
          linkSet.add(key)
          pageLinks.push({ source_id: parentId, target_id: targetPageId })
        }
      }
    }
    return pageLinks
  },

  // ---------------------------------------------------------------------------
  // Logging commands (fire-and-forget)
  // ---------------------------------------------------------------------------

  log_frontend: returnNull,
  get_log_dir: () => '/mock/logs',

  // ---------------------------------------------------------------------------
  // Op log compaction commands
  // ---------------------------------------------------------------------------

  get_compaction_status: () => ({
    total_ops: opLog.length,
    oldest_op_date: opLog.length > 0 ? (opLog[0]?.created_at ?? null) : null,
    eligible_ops: 0,
    retention_days: 90,
  }),

  compact_op_log_cmd: () => ({ snapshot_id: null, ops_deleted: 0 }),

  // ---------------------------------------------------------------------------
  // Point-in-time restore
  // ---------------------------------------------------------------------------

  restore_page_to_op: () => ({ ops_reverted: 0, non_reversible_skipped: 0, results: [] }),

  // ---------------------------------------------------------------------------
  // Link metadata
  // ---------------------------------------------------------------------------

  fetch_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return {
      url: a['url'],
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: new Date().toISOString(),
      auth_required: false,
    }
  },

  get_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return {
      url: a['url'],
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: new Date().toISOString(),
      auth_required: false,
    }
  },

  clear_link_metadata_auth: returnNull,
}

/**
 * Dispatch an IPC command to its handler. Unknown commands log a warning and
 * return `null` (matches pre-decomposition behaviour, including the exact
 * warning text asserted by `tauri-mock.test.ts`).
 */
export function dispatch(cmd: string, args: unknown): unknown {
  const handler = HANDLERS[cmd]
  if (!handler) {
    console.warn(`[tauri-mock] Unhandled command: ${cmd}`)
    return null
  }
  return handler(args)
}
