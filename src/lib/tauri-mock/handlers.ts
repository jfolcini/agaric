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

import { matchesSearchFolded } from '../fold-for-search'
import { logger } from '../logger'
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

// Stub return shapes used by handlers that don't need behaviour beyond a
// type-correct empty payload. `list_projected_agenda` is cursor-paginated
// (M-25) and returns a `PageResponse<T>` shape, NOT a bare array — using
// `returnEmptyArray` for it crashes consumers that read `response.items`.
const returnNull: Handler = () => null
const returnUndefined: Handler = () => undefined
const returnEmptyArray: Handler = () => []
const returnEmptyPage: Handler = () => ({
  items: [],
  next_cursor: null,
  has_more: false,
})

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

  // BUG-48: indexed lookup for a single date-formatted journal page in
  // the active space. Real backend implementation: a SELECT on
  // `idx_blocks_journal_date` with a `space` ref-property subquery.
  get_journal_page_by_date: (args) => {
    const a = args as Record<string, unknown>
    const date = a['date'] as string
    const spaceId = a['spaceId'] as string
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (b['content'] !== date) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      return b
    }
    return null
  },

  // BUG-48 follow-up: list date-formatted journal pages in the active
  // space whose date falls in `[startDate, endDate]`. The real backend
  // uses the `idx_blocks_journal_date` partial index plus a content
  // range predicate so this is O(visible-days).
  list_journal_pages_in_range: (args) => {
    const a = args as Record<string, unknown>
    const startDate = a['startDate'] as string
    const endDate = a['endDate'] as string
    const spaceId = a['spaceId'] as string
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const content = b['content'] as string | null
      if (!content || !datePattern.test(content)) continue
      if (content < startDate || content > endDate) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      items.push(b)
    }
    items.sort((x, y) =>
      ((x['content'] as string) ?? '').localeCompare((y['content'] as string) ?? ''),
    )
    return items
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

  // PEND-35 Tier 4.3 — atomic batch-create. Mirrors the existing
  // `create_block` mock once per input spec, plus a `set_property` op
  // per (key, value) pair in the spec's `properties` map. The real
  // backend wraps the whole batch in one IMMEDIATE transaction; the
  // mock here is sequential (good enough for the FE shape — atomicity
  // is exercised by the Rust tests). Returns the created BlockRows in
  // INPUT ORDER so callers can map template-line index → block id.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing
  create_blocks_batch: (args) => {
    const a = args as Record<string, unknown>
    const specs = (a['specs'] as Array<Record<string, unknown>>) ?? []
    if (specs.length === 0) {
      throw new Error('specs list cannot be empty')
    }
    const out: Record<string, unknown>[] = []
    for (const spec of specs) {
      const id = fakeId()
      const parentId = (spec['parentId'] as string | null) ?? null
      let position = spec['position'] as number | undefined
      if (position == null) {
        const siblings = [...blocks.values()].filter(
          (b) => b['parent_id'] === parentId && !b['deleted_at'],
        )
        position = siblings.length
      }
      const blockType = spec['blockType'] as string
      const row: Record<string, unknown> = {
        id,
        block_type: blockType,
        content: (spec['content'] as string) ?? null,
        parent_id: parentId,
        page_id: blockType === 'page' ? id : parentId,
        position,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }
      blocks.set(id, row)
      pushOp('create_block', {
        block_id: id,
        content: row['content'],
        parent_id: parentId,
        block_type: blockType,
        position,
      })
      // Apply any per-spec properties (mirrors `set_property_in_tx`
      // dispatch — reserved keys land on the block row, others go to
      // the properties map).
      const props = (spec['properties'] as Record<string, string> | undefined) ?? {}
      for (const [key, value] of Object.entries(props)) {
        if (key === 'todo_state') row['todo_state'] = value
        else if (key === 'priority') row['priority'] = value
        else if (key === 'due_date') row['due_date'] = value
        else if (key === 'scheduled_date') row['scheduled_date'] = value
        else {
          if (!properties.has(id)) properties.set(id, new Map())
          properties.get(id)?.set(key, {
            block_id: id,
            key,
            value_text: value,
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          })
        }
        pushOp('set_property', {
          block_id: id,
          key,
          value_text: value,
          value_number: null,
          value_date: null,
          value_ref: null,
        })
      }
      out.push(row)
    }
    return out
  },

  // ---------------------------------------------------------------------------
  // Spaces — FEAT-3 Phase 1 / Phase 2
  // ---------------------------------------------------------------------------

  // A mock vault always exposes a single canonical "Personal" space — the
  // matching id used across the unit tests in `App.test.tsx`,
  // `PageHeader.test.tsx`, etc. This keeps the space store hydrated and
  // `currentSpaceId` non-null so page-creation flows (Ctrl+N, the
  // PageBrowser input, the `[[` picker) don't bail out at the
  // `if (!isReady || currentSpaceId == null) return` guard in `App.tsx`.
  list_spaces: () => [{ id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' }],

  // FEAT-3 Phase 2 atomic page-creation IPC. Accepts `parentId` (null for a
  // top-level page), `content`, and `spaceId`. Returns the new page's ULID
  // as a plain string — `bindings.ts` documents this departure from the
  // BlockRow shape used by `create_block`.
  //
  // BUG-48 — the real backend wraps both the CreateBlock and
  // SetProperty(space) ops in a single transaction; the mock mirrors
  // that here so journal-page lookups (`get_journal_page_by_date`,
  // `list_journal_pages_in_range`) find newly-created pages by their
  // active space.
  create_page_in_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const parentId = (a['parentId'] as string | null) ?? null
    const spaceId = (a['spaceId'] as string | null) ?? null
    const siblings = [...blocks.values()].filter(
      (b) => b['parent_id'] === parentId && !b['deleted_at'],
    )
    const position = siblings.length
    const row = {
      id,
      block_type: 'page',
      content: (a['content'] as string) ?? null,
      parent_id: parentId,
      page_id: id,
      position,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    if (spaceId) {
      if (!properties.has(id)) properties.set(id, new Map())
      properties.get(id)?.set('space', {
        block_id: id,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: parentId,
      block_type: 'page',
      position,
    })
    return id
  },

  // FEAT-3p6 atomic space-creation IPC. Accepts `name` and optional
  // `accentColor`. Returns the new space's ULID as a plain string.
  // Mirrors `create_page_in_space` but produces a top-level page block
  // marked with `is_space="true"` so `list_spaces` picks it up.
  create_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const row = {
      id,
      block_type: 'page',
      content: (a['name'] as string) ?? null,
      parent_id: null,
      page_id: id,
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: null,
      block_type: 'page',
      position: 0,
    })
    pushOp('set_property', {
      block_id: id,
      key: 'is_space',
      value_text: 'true',
      value_number: null,
      value_date: null,
      value_ref: null,
    })
    const accentColor = a['accentColor'] as string | null | undefined
    if (accentColor != null) {
      pushOp('set_property', {
        block_id: id,
        key: 'accent_color',
        value_text: accentColor,
        value_number: null,
        value_date: null,
        value_ref: null,
      })
    }
    return id
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

  // PEND-35 Tier 2.1 — batch soft-delete (mirror of `delete_block`'s
  // cascade). The backend version walks descendants via a recursive
  // CTE seeded from every root; here we approximate that by walking
  // the live `blocks` map per root once (covers the same set without
  // SQL). Already-deleted / missing ids are silently skipped to
  // mirror the backend's lenient policy. One `delete_block` op_log
  // entry per RESOLVED root (matches the real backend's shape).
  delete_blocks_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    if (inputIds.length === 0) {
      throw new Error('block_ids list cannot be empty')
    }
    const now = new Date().toISOString()
    // Resolve live roots (skip missing or already-deleted).
    const liveRoots = inputIds.filter((id) => {
      const b = blocks.get(id)
      return b && !b['deleted_at']
    })
    // BFS from every root, soft-delete every reachable descendant whose
    // `deleted_at` is currently NULL.
    let count = 0
    const stack: string[] = [...liveRoots]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const id = stack.pop()
      if (id == null) break
      if (seen.has(id)) continue
      seen.add(id)
      const b = blocks.get(id)
      if (!b || b['deleted_at']) continue
      b['deleted_at'] = now
      count++
      for (const child of blocks.values()) {
        if (child['parent_id'] === id && !child['deleted_at'] && !seen.has(child['id'] as string)) {
          stack.push(child['id'] as string)
        }
      }
    }
    // Append one delete_block op per resolved root (NOT per descendant)
    // — mirrors the backend's op_log shape.
    for (const root of liveRoots) {
      pushOp('delete_block', { block_id: root })
    }
    return count
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

  // PEND-35 Tier 2.2 — single-IPC batch restore. Iterates the input ids,
  // clears `deleted_at` on each (matches existing `restore_block` mock's
  // per-row logic), pushes one `restore_block` op per actually-restored
  // root (mirrors backend's one op-per-root semantic). Non-deleted /
  // missing ids are silently skipped.
  restore_blocks_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['blockIds'] as string[]) ?? []
    let count = 0
    for (const id of ids) {
      const b = blocks.get(id)
      if (b?.['deleted_at']) {
        b['deleted_at'] = null
        pushOp('restore_block', { block_id: id })
        count++
      }
    }
    return { affected_count: count }
  },

  // PEND-35 Tier 2.2 — single-IPC batch purge. Iterates the input ids,
  // physically removes each block plus all its related state from the
  // in-memory maps (matches the existing `purge_block` mock's cleanup
  // shape — that one only removed from `blocks`, but the real backend
  // cleans the ~13 dependent tables; we mirror that here for the maps
  // the seed actually tracks: properties, blockTags, attachments,
  // pageAliases). Non-deleted / missing ids are silently skipped.
  purge_blocks_by_ids: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['blockIds'] as string[]) ?? []
    let count = 0
    for (const id of ids) {
      const b = blocks.get(id)
      if (b?.['deleted_at']) {
        blocks.delete(id)
        properties.delete(id)
        blockTags.delete(id)
        attachments.delete(id)
        pageAliases.delete(id)
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

  get_block_history: (_args) => {
    // PEND-35 Tier 1.3 — the backend now accepts `opTypeFilter`. The
    // mock signature mirrors that for parity with `bindings.ts` (the
    // handlers-drift test only checks that the command name is
    // present, but accepting the arg is the right shape). Browser-mode
    // callers don't currently exercise per-block history end-to-end, so
    // returning an empty page is still the cheapest correct behaviour.
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

  // PEND-35 Tier 4.4 — mirror `find_undo_group_inner` semantics so
  // browser-mode FE tests observe the same group sizing the real
  // backend produces. Walks the in-memory `opLog` newest-first,
  // filtering out `undo_*` / `redo_*` ops, seeds at index `depth`,
  // and counts consecutive same-device + within-window ops.
  find_undo_group: (args) => {
    const a = (args ?? {}) as Record<string, unknown>
    const depth = (a['depth'] as number) ?? 0
    const windowMs = (a['windowMs'] as number) ?? 0

    // Newest-first ordering on (created_at DESC, seq DESC).
    const undoableOps = [...opLog]
      .filter((o) => !o.op_type.startsWith('undo_') && !o.op_type.startsWith('redo_'))
      .sort((a2, b2) => {
        if (a2.created_at !== b2.created_at) return a2.created_at < b2.created_at ? 1 : -1
        return b2.seq - a2.seq
      })

    if (depth < 0 || depth >= undoableOps.length) return 0

    const seed = undoableOps[depth] as (typeof undoableOps)[number]
    let count = 1
    let prevTs = new Date(seed.created_at).getTime()
    let prevDevice = seed.device_id

    for (let i = depth + 1; i < undoableOps.length && count < 1000; i++) {
      const op = undoableOps[i] as (typeof undoableOps)[number]
      const ts = new Date(op.created_at).getTime()
      if (op.device_id !== prevDevice) break
      if (Math.abs(prevTs - ts) > windowMs) break
      count += 1
      prevTs = ts
      prevDevice = op.device_id
    }

    return count
  },

  revert_ops: (args) => {
    const a = args as Record<string, unknown>
    const ops = a['ops'] as Array<{ device_id: string; seq: number }>
    const results: Array<Record<string, unknown>> = []

    const sorted = [...ops].sort((x, y) => y.seq - x.seq)

    for (const opRef of sorted) {
      const target = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
      if (!target) continue

      applyRevertForOp(target, blocks, { properties, blockTags })

      const newOp = pushOp(`revert_${target.op_type}`, { reverted: target })
      results.push(newOp)
    }

    return results
  },

  search_blocks: (args) => {
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    if (!query) return { items: [], next_cursor: null, has_more: false }
    // UX-248 — Unicode-aware fold so the mock parity-matches the real
    // backend's FTS5 / `COLLATE NOCASE` behaviour for Turkish / German
    // / accented inputs.  Tests that assert Unicode matching against
    // the mock now see consistent behaviour.
    const items = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
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

  list_unfinished_tasks: (args) => {
    const a = args as Record<string, unknown>
    const beforeDate = a['beforeDate'] as string
    const todoStates = a['todoStates'] as string[]
    const limit = (a['limit'] as number | null) ?? 200
    const spaceId = (a['spaceId'] as string | null) ?? null

    const items = Array.from(blocks.values()).filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId && b['page_id'] !== spaceId && b['id'] !== spaceId) return false
      if (!todoStates.includes((b['todo_state'] as string) ?? '')) return false
      const date = b['due_date'] ?? b['scheduled_date']
      if (!date || date >= beforeDate) return false
      return true
    })

    items.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = a['due_date'] ?? a['scheduled_date'] ?? ''
      const dateB = b['due_date'] ?? b['scheduled_date'] ?? ''
      if (dateA !== dateB) return (dateB as string).localeCompare(dateA as string)
      return (b['id'] as string).localeCompare(a['id'] as string)
    })

    return Promise.resolve({
      items: items.slice(0, limit),
      next_cursor: null,
      has_more: items.length > limit,
    })
  },

  query_by_property: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    const valueText = (a['valueText'] as string | null) ?? null
    const valueDate = (a['valueDate'] as string | null) ?? null
    // PEND-35 Tier 1.5 / Tier 3.4 — push-down filters bundled into
    // `extraFilters` on the IPC boundary. Mirror the backend
    // semantics so FE tests can observe the filter going through.
    //   - `excludeParentId` skips rows whose `parent_id` matches.
    //   - `contentNonEmpty` drops null/empty/whitespace-only content.
    //   - `blockType` (Tier 3.4) restricts to a single block_type.
    //   - `valueTextIn` (Tier 3.4) is set-membership over value_text;
    //     mutually exclusive with `valueText`.
    //   - `valueDateRange` (Tier 3.4) is half-open `[from, to)`.
    const extra = (a['extraFilters'] as Record<string, unknown> | null) ?? null
    const excludeParentId = ((extra?.['excludeParentId'] as string | null) ?? null) as string | null
    const contentNonEmpty = Boolean(extra?.['contentNonEmpty'])
    const blockType = ((extra?.['blockType'] as string | null) ?? null) as string | null
    const valueTextIn = ((extra?.['valueTextIn'] as string[] | null) ?? null) as string[] | null
    const valueDateRange = ((extra?.['valueDateRange'] as [string, string] | null) ?? null) as
      | [string, string]
      | null
    // Some well-known "properties" live on the block row itself in the seed
    // data (todo_state, priority, due_date, scheduled_date, completed_at,
    // created_at). The real backend exposes them through the properties
    // system, so the frontend calls query_by_property with those keys. We
    // fall back to reading the row-level field when the properties Map is
    // empty or doesn't carry that key (TEST-1f).
    const ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
      todo_state: 'text',
      priority: 'text',
      due_date: 'date',
      scheduled_date: 'date',
    }
    const rowKind = ROW_FIELD_KEYS[key]
    // The predicate below mirrors the SQL evaluation order from
    // `pagination/properties.rs::query_by_property` so the mock's
    // observable behaviour matches the backend across reserved-key /
    // non-reserved / row-fallback branches plus the four pushed-down
    // filters (excludeParentId, contentNonEmpty, blockType, value_text/
    // valueTextIn, valueDate/valueDateRange). Splitting this into helpers
    // would make the SQL→TS correspondence harder to audit and would
    // duplicate the keep/drop signal across multiple closures.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      // Push-down filters short-circuit before the property lookup so
      // the mock matches the SQL evaluation order.
      if (excludeParentId !== null && b['parent_id'] === excludeParentId) return false
      if (contentNonEmpty) {
        const content = b['content'] as string | null | undefined
        if (content == null || (content as string).trim() === '') return false
      }
      if (blockType !== null && b['block_type'] !== blockType) return false
      const blockProps = properties.get(b['id'] as string)
      const prop = blockProps?.get(key)
      const matchesValueTextIn = (v: string | null | undefined): boolean =>
        valueTextIn === null || valueTextIn.length === 0 || (v != null && valueTextIn.includes(v))
      const matchesValueDateRange = (v: string | null | undefined): boolean => {
        if (valueDateRange === null) return true
        if (v == null) return false
        const [from, to] = valueDateRange
        // Half-open `[from, to)`: include `from`, exclude `to`.
        return v >= from && v < to
      }
      if (prop) {
        if (!matchesValueTextIn(prop['value_text'] as string | null | undefined)) return false
        if (!matchesValueDateRange(prop['value_date'] as string | null | undefined)) return false
        if (valueText !== null) return prop['value_text'] === valueText
        if (valueDate !== null) return prop['value_date'] === valueDate
        return true
      }
      if (rowKind !== undefined) {
        const rowValue = b[key] as string | null | undefined
        if (rowValue == null) return false
        if (rowKind === 'text' && !matchesValueTextIn(rowValue)) return false
        if (rowKind === 'date' && !matchesValueDateRange(rowValue)) return false
        if (valueText !== null) return rowKind === 'text' && rowValue === valueText
        if (valueDate !== null) return rowKind === 'date' && rowValue === valueDate
        return true
      }
      return false
    })
    return { items, next_cursor: null, has_more: false }
  },

  query_by_tags: (args) => {
    const a = args as Record<string, unknown>
    const tagIds = (a['tagIds'] as string[]) ?? []
    const prefixes = (a['prefixes'] as string[] | null) ?? []
    const mode = ((a['mode'] as string) ?? 'and').toLowerCase()
    // PEND-35 Tier 3.4 — `blockType` push-down: restrict to a single
    // block_type. `null` / `undefined` keeps the unfiltered behaviour.
    const blockType = (a['blockType'] as string | null) ?? null

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
      if (blockType !== null && b['block_type'] !== blockType) return false
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

  // PEND-35 Tier 2.10b — AND-intersected property + tag query that the
  // backend resolves entirely in SQL via composed `EXISTS` subqueries.
  // The mock exists so FE tests can assert the IPC fires and observe
  // the post-intersection result; cursor pagination is intentionally
  // skipped (the backend semantic the audit cares about is "no silent
  // row cap" / "single round-trip", not "the mock paginates").
  filtered_blocks_query: (args) => {
    const a = args as Record<string, unknown>
    const propertyFilters = (a['propertyFilters'] as Record<string, unknown>[] | null) ?? []
    const tagFilters = (a['tagFilters'] as Record<string, unknown> | null) ?? null
    const blockType = (a['blockType'] as string | null) ?? null

    const ROW_FIELD_KEYS: Record<string, 'text' | 'date'> = {
      todo_state: 'text',
      priority: 'text',
      due_date: 'date',
      scheduled_date: 'date',
    }

    /**
     * Evaluate one PropertyFilter against a block — mirrors the
     * EXISTS-subquery semantics the backend emits per filter (or, for
     * reserved keys, the direct column predicate routing).
     */
    const propertyFilterMatches = (
      b: Record<string, unknown>,
      pf: Record<string, unknown>,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing
    ): boolean => {
      const key = pf['key'] as string
      const valueText = (pf['valueText'] as string | null) ?? null
      const valueTextIn = (pf['valueTextIn'] as string[] | null) ?? null
      const valueDate = (pf['valueDate'] as string | null) ?? null
      const valueDateRange = (pf['valueDateRange'] as [string, string] | null) ?? null
      const operator = ((pf['operator'] as string | null) ?? 'eq').toLowerCase()

      const cmp = (lhs: string, rhs: string): boolean => {
        switch (operator) {
          case 'neq':
            return lhs !== rhs
          case 'lt':
            return lhs < rhs
          case 'gt':
            return lhs > rhs
          case 'lte':
            return lhs <= rhs
          case 'gte':
            return lhs >= rhs
          default:
            return lhs === rhs
        }
      }

      const blockProps = properties.get(b['id'] as string)
      const prop = blockProps?.get(key)
      const rowKind = ROW_FIELD_KEYS[key]
      // Resolve the candidate text/date for comparison from either
      // block_properties or the row-level reserved column.
      let pText: string | null = null
      let pDate: string | null = null
      if (prop) {
        pText = (prop['value_text'] as string | null) ?? null
        pDate = (prop['value_date'] as string | null) ?? null
      } else if (rowKind !== undefined) {
        const v = (b[key] as string | null | undefined) ?? null
        if (rowKind === 'text') pText = v
        else pDate = v
      } else {
        return false // key absent
      }

      if (valueTextIn && valueTextIn.length > 0) {
        if (pText == null || !valueTextIn.includes(pText)) return false
      }
      if (valueDateRange) {
        if (pDate == null) return false
        const [from, to] = valueDateRange
        if (!(pDate >= from && pDate < to)) return false
      }
      if (valueText !== null) {
        if (pText == null || !cmp(pText, valueText)) return false
      }
      if (valueDate !== null) {
        if (pDate == null || !cmp(pDate, valueDate)) return false
      }
      return true
    }

    const tagFilterMatches = (b: Record<string, unknown>): boolean => {
      if (!tagFilters) return true
      const tagIds = (tagFilters['tagIds'] as string[] | null) ?? []
      const prefixes = (tagFilters['prefixes'] as string[] | null) ?? []
      const mode = ((tagFilters['mode'] as string | null) ?? 'or').toLowerCase()
      if (tagIds.length === 0 && prefixes.length === 0) return true

      // Resolve prefixes to tag-block ids by content prefix-match
      // (mirrors the backend's `tags_cache.name LIKE ?` semantics —
      // the mock has no tags_cache table so we walk tag blocks).
      const resolvedFromPrefix: string[] = []
      for (const prefix of prefixes) {
        const lp = prefix.toLowerCase()
        for (const [, blk] of blocks) {
          if (
            blk['block_type'] === 'tag' &&
            !blk['deleted_at'] &&
            ((blk['content'] as string) ?? '').toLowerCase().startsWith(lp)
          ) {
            resolvedFromPrefix.push(blk['id'] as string)
          }
        }
      }
      const allIds = [...tagIds, ...resolvedFromPrefix]
      const tags = blockTags.get(b['id'] as string)
      if (!tags || tags.size === 0) return false
      if (mode === 'and') return allIds.every((tid) => tags.has(tid))
      return allIds.some((tid) => tags.has(tid))
    }

    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (blockType !== null && b['block_type'] !== blockType) return false
      for (const pf of propertyFilters) {
        if (!propertyFilterMatches(b, pf)) return false
      }
      if (!tagFilterMatches(b)) return false
      return true
    })
    items.sort((x, y) => (x['id'] as string).localeCompare(y['id'] as string))
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
    // PEND-14: typed values are bundled under `value: SetPropertyArgs` (was 4 flat
    // args). Navigate the bundle to read each typed value column.
    const valueArgs = a['value'] as Record<string, unknown> | undefined
    const valueText = (valueArgs?.['value_text'] as string | null) ?? null
    const valueNum = (valueArgs?.['value_num'] as number | null) ?? null
    const valueDate = (valueArgs?.['value_date'] as string | null) ?? null
    const valueRef = (valueArgs?.['value_ref'] as string | null) ?? null
    const valueBool = (valueArgs?.['value_bool'] as boolean | null) ?? null
    // Capture the prior typed value (if any) so revert can restore it.
    // `from_value: null` signals "property did not exist" — revert removes it.
    const priorRow = properties.get(blockId)?.get(key)
    const fromValue = priorRow
      ? {
          value_text: (priorRow['value_text'] as string | null) ?? null,
          value_num: (priorRow['value_num'] as number | null) ?? null,
          value_date: (priorRow['value_date'] as string | null) ?? null,
          value_ref: (priorRow['value_ref'] as string | null) ?? null,
          value_bool: (priorRow['value_bool'] as number | null) ?? null,
        }
      : null
    if (!properties.has(blockId)) {
      properties.set(blockId, new Map())
    }
    properties.get(blockId)?.set(key, {
      key,
      value_text: valueText,
      value_num: valueNum,
      value_date: valueDate,
      value_ref: valueRef,
      value_bool: valueBool === null ? null : valueBool ? 1 : 0,
    })
    pushOp('set_property', { block_id: blockId, key, from_value: fromValue })
    const b = blocks.get(blockId)
    return b ? { ...b } : null
  },

  delete_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    // Capture the prior typed value so revert can re-add it.
    const priorRow = properties.get(blockId)?.get(key)
    const fromValue = priorRow
      ? {
          value_text: (priorRow['value_text'] as string | null) ?? null,
          value_num: (priorRow['value_num'] as number | null) ?? null,
          value_date: (priorRow['value_date'] as string | null) ?? null,
          value_ref: (priorRow['value_ref'] as string | null) ?? null,
          value_bool: (priorRow['value_bool'] as number | null) ?? null,
        }
      : null
    const blockProps = properties.get(blockId)
    if (blockProps) blockProps.delete(key)
    pushOp('delete_property', {
      block_id: blockId,
      key,
      from_value: fromValue,
    })
    return null
  },

  get_properties: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const blockProps = properties.get(blockId)
    if (!blockProps) return []
    return [...blockProps.values()]
  },

  // PEND-35 Tier 2.4c — single-key PK lookup. Returns the row or null.
  get_property: (args) => {
    const a = args as Record<string, unknown>
    const blockId = a['blockId'] as string
    const key = a['key'] as string
    const propMap = properties.get(blockId)
    return propMap?.get(key) ?? null
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
        const query = (filter['query'] as string) ?? ''
        // UX-248 — Unicode-aware fold (mock / backend parity).
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
    const fromState = (b['todo_state'] as string | null) ?? null
    b['todo_state'] = (a['state'] as string | null) ?? null
    pushOp('set_todo_state', {
      block_id: a['blockId'],
      state: b['todo_state'],
      from_state: fromState,
    })
    return { ...b }
  },

  // PEND-35 Tier 2.1 — batch set/clear todo state. Iterates the
  // input list, sets `b.todo_state` on each live block, and emits a
  // single `set_property` op per affected block (mirrors the
  // backend's per-block op_log entry under one tx). Missing /
  // soft-deleted ids are silently skipped (lenient batch semantic).
  set_todo_state_batch: (args) => {
    const a = args as Record<string, unknown>
    const inputIds = (a['blockIds'] as string[]) ?? []
    if (inputIds.length === 0) {
      throw new Error('block_ids list cannot be empty')
    }
    const newState = (a['state'] as string | null) ?? null
    let updated = 0
    for (const id of inputIds) {
      const b = blocks.get(id)
      if (!b || b['deleted_at']) continue
      b['todo_state'] = newState
      pushOp('set_property', {
        block_id: id,
        key: 'todo_state',
        value_text: newState,
      })
      updated++
    }
    return updated
  },

  set_priority: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromLevel = (b['priority'] as string | null) ?? null
    b['priority'] = (a['level'] as string | null) ?? null
    pushOp('set_priority', {
      block_id: a['blockId'],
      level: b['priority'],
      from_level: fromLevel,
    })
    return { ...b }
  },

  set_due_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromDate = (b['due_date'] as string | null) ?? null
    b['due_date'] = (a['date'] as string | null) ?? null
    pushOp('set_due_date', {
      block_id: a['blockId'],
      date: b['due_date'],
      from_date: fromDate,
    })
    return { ...b }
  },

  set_scheduled_date: (args) => {
    const a = args as Record<string, unknown>
    const b = blocks.get(a['blockId'] as string)
    if (!b) throw new Error('not found')
    const fromDate = (b['scheduled_date'] as string | null) ?? null
    b['scheduled_date'] = (a['date'] as string | null) ?? null
    pushOp('set_scheduled_date', {
      block_id: a['blockId'],
      date: b['scheduled_date'],
      from_date: fromDate,
    })
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
    // PEND-35 Tier 1.6 — honour `scope` so mock-mode FE tests can
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
    // UX-248 — Unicode-aware fold (mock / backend parity).
    const LINK_RE_UL = /\[\[([0-9A-Z]{26})\]\]/g
    const unlinked = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['id'] === pageId) return false
      if (b['parent_id'] === pageId) return false
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

  // PEND-17 Part B — diff between a block's historical content (as of
  // `historicalSeq`) and its current live content. Mirrors the Rust
  // command's contract: empty/all-Equal spans for unmodified blocks,
  // throws on a soft-deleted block.
  compute_block_vs_current_diff: (args) => {
    const a = args as Record<string, unknown>
    const blockId = (a['blockId'] as string).toUpperCase()
    const historicalSeq = a['historicalSeq'] as number
    const block = blocks.get(blockId)
    if (!block || block['deleted_at']) {
      throw new Error(`block '${blockId}' not found or soft-deleted (cannot diff against current)`)
    }
    const current = (block['content'] as string | null | undefined) ?? ''
    // Walk the op log for the most recent edit_block / create_block at
    // or before `historicalSeq` for this block.
    const candidates = opLog.filter((o) => {
      if (o.op_type !== 'edit_block' && o.op_type !== 'create_block') return false
      if (o.seq > historicalSeq) return false
      try {
        const p = JSON.parse(o.payload) as Record<string, unknown>
        const pid = (p['block_id'] as string | undefined)?.toUpperCase()
        return pid === blockId
      } catch {
        return false
      }
    })
    if (candidates.length === 0) {
      throw new Error(
        `no create_block or edit_block op for '${blockId}' at or before seq ${historicalSeq}`,
      )
    }
    candidates.sort((x, y) => y.seq - x.seq)
    const target = candidates[0] as MockOpLogEntry
    const targetPayload = JSON.parse(target.payload) as Record<string, unknown>
    const historical =
      target.op_type === 'edit_block'
        ? ((targetPayload['to_text'] as string) ?? '')
        : ((targetPayload['content'] as string) ?? '')
    if (historical === current) return []
    // Same simplified word-diff as compute_edit_diff above — Delete the
    // historical, Insert the current. Tests only assert the SHAPE
    // (presence of Insert / Delete / Equal tags) so this is fine.
    const spans: Array<Record<string, unknown>> = []
    if (historical) spans.push({ tag: 'Delete', value: historical })
    if (current) spans.push({ tag: 'Insert', value: current })
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

  list_property_defs: () => ({
    // M-85: paginated; the mock returns every def in one page (the
    // mock fixtures stay small enough that pagination is irrelevant).
    items: [...propertyDefs.values()],
    next_cursor: null,
    has_more: false,
  }),

  // PEND-35 Tier 2.6 — single-key PK lookup. Returns the entry or null.
  get_property_def: (args) => {
    const a = args as Record<string, unknown>
    const key = a['key'] as string
    return propertyDefs.get(key) ?? null
  },

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
    // PEND-35 Tier 1.2 — backend now takes `scope: SpaceScope`. Mirror
    // the `list_page_aliases_by_prefix` mock (sibling below) so an
    // alias pointing at a foreign-space page does not surface when the
    // caller is scoped to the active space. Global keeps the
    // cross-space lookup so the MCP / agent surfaces don't regress.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    for (const [pid, aliases] of pageAliases.entries()) {
      if (aliases.some((al) => al.toLowerCase() === alias)) {
        const page = blocks.get(pid)
        if (!page) continue
        if (spaceId !== null) {
          const space = properties.get(pid)?.get('space')?.['value_ref'] ?? null
          if (space !== spaceId) continue
        }
        return [pid, (page['content'] as string) ?? null]
      }
    }
    return null
  },

  // PEND-34 — prefix-indexed alias autocomplete used by the [[ picker.
  // Returns `[page_id, alias, title]` rows ordered shortest-alias first
  // (then alphabetical), capped at `limit` (default 50). When the IPC
  // arg's `scope` is `{ kind: 'active', space_id }` (PEND-18 Phase 3),
  // restricts matches to aliases pointing at pages whose `space`
  // property equals the wrapped ULID. Mirrors the backend's
  // `list_page_aliases_by_prefix_inner` shape.
  list_page_aliases_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const prefix = ((a['prefix'] as string) ?? '').toLowerCase()
    const limit = (a['limit'] as number | null) ?? 50
    // PEND-18 Phase 3 — IPC arg shape: `scope: SpaceScope`. Recover the
    // legacy `spaceId | null` shape for the active-space-scoping branch.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const rows: Array<[string, string, string | null]> = []
    for (const [pid, aliases] of pageAliases.entries()) {
      const page = blocks.get(pid)
      if (!page) continue
      if (page['deleted_at']) continue
      // Active-space scoping (PEND-34 Q3): when `scope.kind === 'active'`,
      // exclude pages that don't carry `space = ?spaceId` in their
      // property map.
      if (spaceId !== null) {
        const space = properties.get(pid)?.get('space')?.['value_ref'] ?? null
        if (space !== spaceId) continue
      }
      const title = (page['content'] as string | null) ?? null
      for (const alias of aliases) {
        if (alias.toLowerCase().startsWith(prefix)) {
          rows.push([pid, alias, title])
        }
      }
    }
    rows.sort((x, y) => x[1].length - y[1].length || x[1].localeCompare(y[1]))
    return rows.slice(0, limit)
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
    // PEND-35 Tier 1.1 — backend now requires `space_id`. Mirror the
    // backend behaviour: stamp `space = ?spaceId` on the created page
    // so `tauri-mock-parity` and downstream space-scoped read mocks
    // see the imported page in the active space. The backend rejects
    // empty / missing values with `AppError::Validation`; the mock is
    // permissive about the value (skips the stamp when empty) so older
    // mock fixtures that pre-date this fix don't break.
    const spaceId = (a['spaceId'] as string | undefined) ?? ''

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

    // Create the page block + stamp `space` ref property (PEND-35).
    const pageId = fakeId()
    const pageBlock = makeBlock(pageId, 'page', pageTitle, null, blocks.size)
    blocks.set(pageId, pageBlock)
    if (spaceId) {
      if (!properties.has(pageId)) properties.set(pageId, new Map())
      properties.get(pageId)?.set('space', {
        block_id: pageId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }

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

  // MAINT-131 / PEND-35 Tier 2.7a: full-list batch — single source for both
  // SortableBlock badge counts (consumer reads `.length`) and StaticBlock
  // inline-image-render decisions. Mirrors the json_each-backed batch
  // pattern in `commands/blocks/queries.rs::batch_resolve_inner`.
  list_attachments_batch: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = (a['blockIds'] as string[]) ?? []
    const result: Record<string, unknown[]> = {}
    for (const att of attachments.values()) {
      const bid = att['block_id'] as string
      if (blockIds.includes(bid)) {
        result[bid] = result[bid] ?? []
        result[bid].push(att)
      }
    }
    return result
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

  list_projected_agenda: returnEmptyPage,

  // ---------------------------------------------------------------------------
  // Draft autosave (F-17)
  // ---------------------------------------------------------------------------

  save_draft: returnNull,
  flush_draft: returnNull,
  delete_draft: returnNull,

  list_drafts: returnEmptyArray,

  // PEND-35 Tier 2.12 — boot recovery uses a single IPC. The mock has
  // no in-memory drafts map (existing `list_drafts: returnEmptyArray`
  // is the canonical source-of-truth shape), so `flushed` is always 0.
  flush_all_drafts: () => ({ flushed: 0 }),

  // ---------------------------------------------------------------------------
  // Peer address
  // ---------------------------------------------------------------------------

  set_peer_address: returnNull,

  // ---------------------------------------------------------------------------
  // Page links for graph view (F-33)
  // ---------------------------------------------------------------------------

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing
  list_page_links: (args) => {
    // Scan all non-deleted blocks for [[ULID]] page link tokens and
    // return page-to-page edges (source = parent page, target = linked page).
    const a = (args as Record<string, unknown> | null | undefined) ?? {}
    // PEND-35 Tier 4.5 — when `tagIds` is non-empty, restrict edges to
    // those whose target page carries at least one of the listed tags.
    // Mirrors the backend semantics (`block_tags`-only resolution in the
    // mock world; the real backend additionally unions
    // `block_tag_inherited` / `block_tag_refs`, which the mock does not
    // model — see seed.ts).
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
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
        // PEND-35 Tier 4.5 — apply target-side tag filter.
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
  // Bug report (FEAT-5)
  // ---------------------------------------------------------------------------

  collect_bug_report_metadata: () => ({
    app_version: '0.1.0',
    os: 'mock',
    arch: 'mock',
    device_id: 'mock-device-id',
    recent_errors: [],
  }),

  read_logs_for_report: () => [],

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

  restore_page_to_op: () => ({
    ops_reverted: 0,
    non_reversible_skipped: 0,
    results: [],
  }),

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

  // ---------------------------------------------------------------------------
  // Google Calendar integration (FEAT-5) — MAINT-160
  //
  // The real backend talks to Google over OAuth and exposes a `GcalStatus`
  // snapshot to the Settings tab. The mock returns a stable "disconnected"
  // status so the GoogleCalendarSettingsTab renders its sign-in CTA without
  // any per-call invoke stubbing in Playwright. Mutating commands return
  // `null` (or the new value where the binding declares one) and do not
  // persist state — this is enough to exercise the rendering paths.
  // ---------------------------------------------------------------------------

  get_gcal_status: () => ({
    connected: false,
    account_email: null,
    calendar_id: null,
    window_days: 30,
    privacy_mode: 'full',
    last_push_at: null,
    last_error: null,
    push_lease: {
      held_by_this_device: false,
      device_id: null,
      expires_at: null,
    },
  }),

  force_gcal_resync: returnNull,

  disconnect_gcal: (args) => {
    // Acknowledge the binding's `deleteCalendar: boolean` arg even though
    // the mock has no calendar to delete — the destructured (and discarded)
    // binding documents the contract for parity with the Rust command at
    // `src-tauri/src/commands/gcal.rs:332`. The mock has no observable
    // state to mutate either way, so this is a no-op.
    const a = args as { deleteCalendar?: boolean }
    void a.deleteCalendar
    return null
  },

  set_gcal_window_days: (args) => {
    const a = args as Record<string, unknown>
    return (a['n'] as number) ?? 30
  },

  set_gcal_privacy_mode: returnNull,

  // ---------------------------------------------------------------------------
  // MCP read-only / read-write servers (FEAT-4) — MAINT-160
  //
  // The real backend manages a Unix-domain-socket lifecycle that can't run
  // inside Playwright. The mock returns disabled status snapshots so
  // AgentAccessSettingsTab renders its toggles + socket-path readouts
  // without per-call stubbing. Toggle commands echo the requested value;
  // disconnect commands return `null` since they have no observable
  // effect on the mock state.
  // ---------------------------------------------------------------------------

  get_mcp_status: () => ({
    enabled: false,
    socket_path: '/mock/agaric-mcp-ro.sock',
    active_connections: 0,
  }),

  get_mcp_socket_path: () => '/mock/agaric-mcp-ro.sock',

  mcp_set_enabled: (args) => {
    const a = args as Record<string, unknown>
    return (a['enabled'] as boolean) ?? false
  },

  mcp_disconnect_all: returnNull,

  get_mcp_rw_status: () => ({
    enabled: false,
    socket_path: '/mock/agaric-mcp-rw.sock',
    active_connections: 0,
  }),

  get_mcp_rw_socket_path: () => '/mock/agaric-mcp-rw.sock',

  mcp_rw_set_enabled: (args) => {
    const a = args as Record<string, unknown>
    return (a['enabled'] as boolean) ?? false
  },

  mcp_rw_disconnect_all: returnNull,

  // ---------------------------------------------------------------------------
  // Trash descendant counts (MAINT-160)
  //
  // Returns a map of root_id → number of cascade-deleted descendants.
  //
  // ── Semantic divergence from the Rust backend ─────────────────────────
  // The Rust impl in `src-tauri/src/commands/blocks/queries.rs`
  // (`trash_descendant_counts_inner` → `pagination::trash_descendant_counts`)
  // uses a SQL JOIN on the root's `deleted_at` timestamp, so it counts
  // only blocks deleted in the *same cascade-batch* as the root.
  //
  // The mock here counts ALL soft-deleted descendants of the root via a
  // BFS over `parent_id`, regardless of *when* they were deleted.
  //
  // For the current Playwright e2e seed-data flows the two converge,
  // because the seed deletes whole subtrees in a single batch. Revisit
  // this if a Playwright spec ever creates mixed-batch trash state
  // (e.g. partial restore-then-redelete) — at that point the mock will
  // need to track and join on `deleted_at` like the Rust impl.
  // ---------------------------------------------------------------------------

  trash_descendant_counts: (args) => {
    const a = args as Record<string, unknown>
    const rootIds = (a['rootIds'] as string[]) ?? []
    const result: Record<string, number> = {}
    for (const rootId of rootIds) {
      let count = 0
      const queue: string[] = [rootId]
      const seen = new Set<string>([rootId])
      while (queue.length > 0) {
        const parent = queue.shift() as string
        for (const b of blocks.values()) {
          const id = b['id'] as string
          if (seen.has(id)) continue
          if (b['parent_id'] !== parent) continue
          seen.add(id)
          if (b['deleted_at']) count++
          queue.push(id)
        }
      }
      result[rootId] = count
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // PEND-35 Tier 2.3 — get_blocks batch endpoint
  // ---------------------------------------------------------------------------

  // get_blocks(ids: string[]) -> BlockRow[]
  //
  // Mirrors `commands/blocks/queries.rs::get_blocks_inner`: returns the
  // full BlockRow for every id present in the seed (NOT filtered by
  // soft-delete). Missing ids are silently omitted so callers map by id.
  get_blocks: (args) => {
    const a = args as Record<string, unknown>
    const ids = (a['ids'] as string[]) ?? []
    if (ids.length === 0) {
      throw new Error('ids list cannot be empty')
    }
    const out: Record<string, unknown>[] = []
    for (const id of ids) {
      const row = blocks.get(id)
      if (row) out.push(row)
    }
    return out
  },

  // ---------------------------------------------------------------------------
  // First-child-per-parent batch (PEND-35 Tier 2.8)
  //
  // Mirrors `commands/blocks/queries.rs::first_child_for_blocks_inner`:
  // returns a map of `parentId → first BlockRow` ordered by
  // `(position ASC, id ASC)`. Soft-deleted children are filtered out so
  // the value is always a live block. Parents with no active children
  // are omitted from the record.
  // ---------------------------------------------------------------------------

  first_child_for_blocks: (args) => {
    const a = args as Record<string, unknown>
    const blockIds = (a['blockIds'] as string[]) ?? []
    const parentSet = new Set(blockIds)
    const result: Record<string, unknown> = {}
    // Group children by parent_id, then pick the first by (position, id).
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const b of blocks.values()) {
      const parent = b['parent_id'] as string | null | undefined
      if (parent == null) continue
      if (!parentSet.has(parent)) continue
      if (b['deleted_at']) continue
      const bucket = grouped.get(parent) ?? []
      bucket.push(b)
      grouped.set(parent, bucket)
    }
    for (const [parent, children] of grouped) {
      children.sort((x, y) => {
        const px = (x['position'] as number | null) ?? 0
        const py = (y['position'] as number | null) ?? 0
        if (px !== py) return px - py
        const idX = x['id'] as string
        const idY = y['id'] as string
        return idX.localeCompare(idY)
      })
      const first = children[0]
      if (first) result[parent] = first
    }
    return result
  },

  // ---------------------------------------------------------------------------
  // Quick capture (FEAT-12) — MAINT-160
  //
  // Creates a content block under today's daily page in the requested
  // space and returns the new BlockRow. The mock uses the seeded
  // `PAGE_DAILY` as the parent when available so the new block shows up
  // in the daily-page list_blocks query like the real backend would.
  // ---------------------------------------------------------------------------

  quick_capture_block: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    // Prefer today's daily page as the parent so the captured block
    // shows up where the UI expects it.  Fall back to the supplied
    // spaceId if the daily page is missing for any reason.
    const todayIso = new Date().toISOString().slice(0, 10)
    let parentId: string | null = null
    for (const b of blocks.values()) {
      if (b['block_type'] === 'page' && b['content'] === todayIso) {
        parentId = b['id'] as string
        break
      }
    }
    if (parentId == null) {
      parentId = (a['spaceId'] as string | null) ?? null
    }
    const id = fakeId()
    const siblings = [...blocks.values()].filter(
      (b) => b['parent_id'] === parentId && !b['deleted_at'],
    )
    const position = siblings.length
    const row = {
      id,
      block_type: 'content',
      content,
      parent_id: parentId,
      page_id: parentId,
      position,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    pushOp('create_block', {
      block_id: id,
      content,
      parent_id: parentId,
      block_type: 'content',
      position,
    })
    return row
  },
}

/**
 * Dispatch an IPC command to its handler. Unknown commands log a warning via
 * the structured logger and return `null`.
 */
export function dispatch(cmd: string, args: unknown): unknown {
  const handler = HANDLERS[cmd]
  if (!handler) {
    logger.warn('TauriMock', 'unhandled command', { command: cmd })
    return null
  }
  return handler(args)
}
