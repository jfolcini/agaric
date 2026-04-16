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

// -- Error injection for E2E tests --------------------------------------------

const injectedErrors = new Map<string, string>()

export function injectMockError(command: string, message: string): void {
  injectedErrors.set(command, message)
}

export function clearMockErrors(): void {
  injectedErrors.clear()
}

const blocks: Map<string, Record<string, unknown>> = new Map()

// Property store: block_id → key → PropertyRow
const properties: Map<string, Map<string, Record<string, unknown>>> = new Map()

// Block-tag associations: block_id → Set<tag_id>
const blockTags: Map<string, Set<string>> = new Map()

// Property definitions store
const propertyDefs: Map<string, Record<string, unknown>> = new Map()

// Page aliases store: page_id → string[]
const pageAliases: Map<string, string[]> = new Map()

// Attachment store: attachment_id → AttachmentRow-like object
const attachments: Map<string, Record<string, unknown>> = new Map()

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

function offsetDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
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
  // -- Additional seed data for richer browser preview --
  PAGE_PROJECTS: '00000000000000000000PAGE04',
  PAGE_MEETINGS: '00000000000000000000PAGE05',
  BLOCK_DAILY_3: '0000000000000000000BLOCK10',
  BLOCK_DAILY_4: '0000000000000000000BLOCK11',
  BLOCK_DAILY_5: '0000000000000000000BLOCK12',
  BLOCK_PROJ_1: '0000000000000000000BLOCK13',
  BLOCK_PROJ_2: '0000000000000000000BLOCK14',
  BLOCK_PROJ_3: '0000000000000000000BLOCK15',
  BLOCK_PROJ_4: '0000000000000000000BLOCK16',
  BLOCK_MTG_1: '0000000000000000000BLOCK17',
  BLOCK_MTG_2: '0000000000000000000BLOCK18',
  BLOCK_OVERDUE_1: '0000000000000000000BLOCK19',
  // -- Template seed data --
  PAGE_TMPL_MEETING: '00000000000000000000PAGE06',
  BLOCK_TMPL_M1: '0000000000000000000BLOCK20',
  BLOCK_TMPL_M2: '0000000000000000000BLOCK21',
  BLOCK_TMPL_M3: '0000000000000000000BLOCK22',
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
    page_id: blockType === 'page' ? id : parentId,
    position,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
  }
}

function seedBlocks(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  pageAliases.clear()
  attachments.clear()
  counter = 0
  opLog.length = 0
  opSeqCounter = 0

  const today = todayDate()
  const yesterday = offsetDate(-1)
  const tomorrow = offsetDate(1)
  const nextWeek = offsetDate(7)

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
  blocks.set(SEED_IDS.PAGE_PROJECTS, makeBlock(SEED_IDS.PAGE_PROJECTS, 'page', 'Projects', null, 3))
  blocks.set(SEED_IDS.PAGE_MEETINGS, makeBlock(SEED_IDS.PAGE_MEETINGS, 'page', 'Meetings', null, 4))

  // Content blocks — children of "Getting Started"
  blocks.set(
    SEED_IDS.BLOCK_GS_1,
    makeBlock(
      SEED_IDS.BLOCK_GS_1,
      'content',
      'Welcome to Agaric! This is your personal knowledge base.',
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

  // Daily page children — original seed blocks
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

  // Daily page children — task blocks with due dates, states, priorities
  const daily3 = makeBlock(
    SEED_IDS.BLOCK_DAILY_3,
    'content',
    'Buy groceries',
    SEED_IDS.PAGE_DAILY,
    2,
  )
  daily3['todo_state'] = 'TODO'
  daily3['priority'] = '1'
  daily3['due_date'] = today
  blocks.set(SEED_IDS.BLOCK_DAILY_3, daily3)

  const daily4 = makeBlock(
    SEED_IDS.BLOCK_DAILY_4,
    'content',
    'Review pull requests',
    SEED_IDS.PAGE_DAILY,
    3,
  )
  daily4['todo_state'] = 'DOING'
  daily4['priority'] = '2'
  daily4['due_date'] = today
  blocks.set(SEED_IDS.BLOCK_DAILY_4, daily4)

  const daily5 = makeBlock(
    SEED_IDS.BLOCK_DAILY_5,
    'content',
    'Write documentation',
    SEED_IDS.PAGE_DAILY,
    4,
  )
  daily5['todo_state'] = 'DONE'
  daily5['priority'] = '3'
  daily5['due_date'] = today
  blocks.set(SEED_IDS.BLOCK_DAILY_5, daily5)

  // Projects page children — mixed states and dates
  const proj1 = makeBlock(
    SEED_IDS.BLOCK_PROJ_1,
    'content',
    'Ship v2.0 release',
    SEED_IDS.PAGE_PROJECTS,
    0,
  )
  proj1['todo_state'] = 'TODO'
  proj1['priority'] = '1'
  proj1['due_date'] = tomorrow
  proj1['scheduled_date'] = today
  blocks.set(SEED_IDS.BLOCK_PROJ_1, proj1)

  const proj2 = makeBlock(
    SEED_IDS.BLOCK_PROJ_2,
    'content',
    'Fix login bug',
    SEED_IDS.PAGE_PROJECTS,
    1,
  )
  proj2['todo_state'] = 'DOING'
  proj2['priority'] = '1'
  proj2['due_date'] = today
  blocks.set(SEED_IDS.BLOCK_PROJ_2, proj2)

  const proj3 = makeBlock(
    SEED_IDS.BLOCK_PROJ_3,
    'content',
    'Update dependencies',
    SEED_IDS.PAGE_PROJECTS,
    2,
  )
  proj3['todo_state'] = 'DONE'
  blocks.set(SEED_IDS.BLOCK_PROJ_3, proj3)

  const proj4 = makeBlock(
    SEED_IDS.BLOCK_PROJ_4,
    'content',
    'Design new dashboard',
    SEED_IDS.PAGE_PROJECTS,
    3,
  )
  proj4['todo_state'] = 'TODO'
  proj4['priority'] = '2'
  proj4['due_date'] = nextWeek
  proj4['scheduled_date'] = tomorrow
  blocks.set(SEED_IDS.BLOCK_PROJ_4, proj4)

  // Meetings page children — with custom properties
  blocks.set(
    SEED_IDS.BLOCK_MTG_1,
    makeBlock(SEED_IDS.BLOCK_MTG_1, 'content', 'Weekly standup notes', SEED_IDS.PAGE_MEETINGS, 0),
  )
  blocks.set(
    SEED_IDS.BLOCK_MTG_2,
    makeBlock(SEED_IDS.BLOCK_MTG_2, 'content', 'Design review feedback', SEED_IDS.PAGE_MEETINGS, 1),
  )

  // Overdue task — due yesterday, still TODO
  const overdue1 = makeBlock(
    SEED_IDS.BLOCK_OVERDUE_1,
    'content',
    'Submit report',
    SEED_IDS.PAGE_PROJECTS,
    4,
  )
  overdue1['todo_state'] = 'TODO'
  overdue1['priority'] = '1'
  overdue1['due_date'] = yesterday
  blocks.set(SEED_IDS.BLOCK_OVERDUE_1, overdue1)

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
  conflict1['is_conflict'] = true
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

  // -- Seed properties for richer browser preview --

  // completed_at property on DONE blocks
  const setMockProp = (blockId: string, key: string, vals: Record<string, unknown>) => {
    if (!properties.has(blockId)) properties.set(blockId, new Map())
    properties.get(blockId)?.set(key, { key, ...vals })
  }
  setMockProp(SEED_IDS.BLOCK_DAILY_5, 'completed_at', {
    value_text: null,
    value_num: null,
    value_date: today,
    value_ref: null,
  })
  setMockProp(SEED_IDS.BLOCK_PROJ_3, 'completed_at', {
    value_text: null,
    value_num: null,
    value_date: today,
    value_ref: null,
  })
  // Custom properties on meeting blocks
  setMockProp(SEED_IDS.BLOCK_MTG_1, 'context', {
    value_text: '@office',
    value_num: null,
    value_date: null,
    value_ref: null,
  })
  setMockProp(SEED_IDS.BLOCK_MTG_1, 'project', {
    value_text: 'alpha',
    value_num: null,
    value_date: null,
    value_ref: null,
  })
  setMockProp(SEED_IDS.BLOCK_MTG_2, 'context', {
    value_text: '@remote',
    value_num: null,
    value_date: null,
    value_ref: null,
  })
  setMockProp(SEED_IDS.BLOCK_MTG_2, 'project', {
    value_text: 'beta',
    value_num: null,
    value_date: null,
    value_ref: null,
  })

  // -- Seed tag associations --
  blockTags.set(SEED_IDS.BLOCK_PROJ_1, new Set([SEED_IDS.TAG_WORK]))
  blockTags.set(SEED_IDS.BLOCK_PROJ_2, new Set([SEED_IDS.TAG_WORK]))
  blockTags.set(SEED_IDS.BLOCK_MTG_1, new Set([SEED_IDS.TAG_WORK]))
  blockTags.set(SEED_IDS.BLOCK_DAILY_3, new Set([SEED_IDS.TAG_PERSONAL]))

  // -- Seed property definitions --
  propertyDefs.set('context', {
    key: 'context',
    value_type: 'text',
    options: null,
    created_at: new Date().toISOString(),
  })
  propertyDefs.set('project', {
    key: 'project',
    value_type: 'select',
    options: JSON.stringify(['alpha', 'beta', 'gamma']),
    created_at: new Date().toISOString(),
  })

  // -- Seed page aliases --
  pageAliases.set(SEED_IDS.PAGE_GETTING_STARTED, ['gs', 'getting-started'])
  pageAliases.set(SEED_IDS.PAGE_PROJECTS, ['proj'])

  // -- Seed template page (Meeting Notes template) --
  blocks.set(
    SEED_IDS.PAGE_TMPL_MEETING,
    makeBlock(SEED_IDS.PAGE_TMPL_MEETING, 'page', 'Meeting Notes Template', null, 5),
  )
  blocks.set(
    SEED_IDS.BLOCK_TMPL_M1,
    makeBlock(SEED_IDS.BLOCK_TMPL_M1, 'content', '## Attendees', SEED_IDS.PAGE_TMPL_MEETING, 0),
  )
  blocks.set(
    SEED_IDS.BLOCK_TMPL_M2,
    makeBlock(
      SEED_IDS.BLOCK_TMPL_M2,
      'content',
      '## Notes — <% today %>',
      SEED_IDS.PAGE_TMPL_MEETING,
      1,
    ),
  )
  blocks.set(
    SEED_IDS.BLOCK_TMPL_M3,
    makeBlock(
      SEED_IDS.BLOCK_TMPL_M3,
      'content',
      '## Action items for <% page title %>',
      SEED_IDS.PAGE_TMPL_MEETING,
      2,
    ),
  )
  // Mark the meeting template page with the `template` property
  setMockProp(SEED_IDS.PAGE_TMPL_MEETING, 'template', {
    value_text: 'true',
    value_num: null,
    value_date: null,
    value_ref: null,
  })
}

/** Reset mock state — clears and re-seeds the in-memory store. Useful for tests. */
export function resetMock(): void {
  injectedErrors.clear()
  seedBlocks()
}

export function setupMock(): void {
  // Fake the window label so getCurrent() works
  mockWindows('main')

  // Populate seed data for browser preview
  seedBlocks()

  mockIPC((cmd, args) => {
    // Error injection — E2E tests can force any command to fail
    if (injectedErrors.has(cmd)) {
      // biome-ignore lint/style/noNonNullAssertion: has() guard above ensures get() is defined
      throw new Error(injectedErrors.get(cmd)!)
    }

    switch (cmd) {
      case 'list_blocks': {
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
            items = items.filter(
              (b) => b['due_date'] === dateStr || b['scheduled_date'] === dateStr,
            )
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
      }

      case 'list_undated_tasks': {
        const items = [...blocks.values()].filter(
          (b) =>
            b['todo_state'] !== null &&
            b['due_date'] === null &&
            b['scheduled_date'] === null &&
            !b['deleted_at'],
        )
        return { items, next_cursor: null, has_more: false }
      }

      case 'create_block': {
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
      }

      case 'edit_block': {
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
      }

      case 'delete_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (b) b['deleted_at'] = new Date().toISOString()
        pushOp('delete_block', { block_id: a['blockId'] })
        return {
          block_id: a['blockId'],
          deleted_at: new Date().toISOString(),
          descendants_affected: 0,
        }
      }

      case 'restore_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (b) b['deleted_at'] = null
        pushOp('restore_block', { block_id: a['blockId'] })
        return { block_id: a['blockId'], restored_count: 1 }
      }

      case 'purge_block': {
        const a = args as Record<string, unknown>
        blocks.delete(a['blockId'] as string)
        return { block_id: a['blockId'], purged_count: 1 }
      }

      case 'restore_all_deleted': {
        let count = 0
        for (const b of blocks.values()) {
          if (b['deleted_at']) {
            b['deleted_at'] = null
            count++
          }
        }
        return { affected_count: count }
      }

      case 'purge_all_deleted': {
        let count = 0
        for (const [id, b] of blocks.entries()) {
          if (b['deleted_at']) {
            blocks.delete(id)
            count++
          }
        }
        return { affected_count: count }
      }

      case 'get_block': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (!b) throw new Error('not found')
        return b
      }

      case 'batch_resolve': {
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
      }

      case 'move_block': {
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
      }

      case 'add_tag': {
        const a = args as Record<string, unknown>
        const blockId = a['blockId'] as string
        const tagId = a['tagId'] as string
        if (!blockTags.has(blockId)) blockTags.set(blockId, new Set())
        blockTags.get(blockId)?.add(tagId)
        pushOp('add_tag', { block_id: blockId, tag_id: tagId })
        return { block_id: blockId, tag_id: tagId }
      }

      case 'remove_tag': {
        const a = args as Record<string, unknown>
        const blockId = a['blockId'] as string
        const tagId = a['tagId'] as string
        blockTags.get(blockId)?.delete(tagId)
        pushOp('remove_tag', { block_id: blockId, tag_id: tagId })
        return { block_id: blockId, tag_id: tagId }
      }

      case 'get_backlinks': {
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
        const ops = a['ops'] as Array<{ device_id: string; seq: number }>
        const results: Array<Record<string, unknown>> = []

        const sorted = [...ops].sort((x, y) => y.seq - x.seq)

        for (const opRef of sorted) {
          const target = opLog.find((o) => o.device_id === opRef.device_id && o.seq === opRef.seq)
          if (!target) continue

          const payload = JSON.parse(target.payload) as Record<string, unknown>

          if (target.op_type === 'create_block') {
            const b = blocks.get(payload['block_id'] as string)
            if (b) b['deleted_at'] = new Date().toISOString()
          } else if (target.op_type === 'delete_block') {
            const b = blocks.get(payload['block_id'] as string)
            if (b) b['deleted_at'] = null
          } else if (target.op_type === 'edit_block') {
            const b = blocks.get(payload['block_id'] as string)
            if (b) b['content'] = (payload['from_text'] as string | null) ?? null
          } else if (target.op_type === 'move_block') {
            const b = blocks.get(payload['block_id'] as string)
            if (b) {
              b['parent_id'] = payload['old_parent_id'] as string | null
              b['position'] = payload['old_position'] as number
            }
          } else if (target.op_type === 'restore_block') {
            const b = blocks.get(payload['block_id'] as string)
            if (b) b['deleted_at'] = new Date().toISOString()
          }

          const newOp = pushOp(`revert_${target.op_type}`, { reverted: target })
          results.push(newOp)
        }

        return results
      }

      case 'get_conflicts': {
        const items = [...blocks.values()].filter(
          (b) => b['is_conflict'] === true && !b['deleted_at'],
        )
        return { items, next_cursor: null, has_more: false }
      }

      case 'search_blocks': {
        const a = args as Record<string, unknown>
        const query = ((a['query'] as string) ?? '').toLowerCase()
        if (!query) return { items: [], next_cursor: null, has_more: false }
        const items = [...blocks.values()].filter(
          (b) =>
            !(b['deleted_at'] as string | null) &&
            ((b['content'] as string) ?? '').toLowerCase().includes(query),
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
          fg_errors: 0,
          bg_errors: 0,
          fg_panics: 0,
          bg_panics: 0,
        }
      }

      case 'query_by_property': {
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
      }

      case 'query_by_tags': {
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
      }

      case 'list_tags_by_prefix': {
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
      }

      case 'list_tags_for_block': {
        const a = args as Record<string, unknown>
        const blockId = a['blockId'] as string
        const tagSet = blockTags.get(blockId)
        if (!tagSet || tagSet.size === 0) return []
        return [...tagSet]
      }

      case 'set_property': {
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
      }

      case 'delete_property': {
        const a = args as Record<string, unknown>
        const blockId = a['blockId'] as string
        const key = a['key'] as string
        const blockProps = properties.get(blockId)
        if (blockProps) blockProps.delete(key)
        return null
      }

      case 'get_properties': {
        const a = args as Record<string, unknown>
        const blockId = a['blockId'] as string
        const blockProps = properties.get(blockId)
        if (!blockProps) return []
        return [...blockProps.values()]
      }

      case 'get_batch_properties': {
        const a = args as Record<string, unknown>
        const blockIds = a['blockIds'] as string[]
        const result: Record<string, Record<string, unknown>[]> = {}
        for (const id of blockIds) {
          const blockProps = properties.get(id)
          result[id] = blockProps ? [...blockProps.values()] : []
        }
        return result
      }

      case 'undo_page_op': {
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
      }

      case 'redo_page_op': {
        const a = args as Record<string, unknown>
        const undoSeq = a['undoSeq'] as number

        // The frontend stores reversed_op (the original op's ref) in the redo
        // stack, so undoSeq is the original op's seq. Find and re-apply it.
        const originalOp = opLog.find((o) => o.seq === undoSeq)
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
      }

      case 'query_backlinks_filtered': {
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
      }

      case 'list_property_keys': {
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
      }

      // -----------------------------------------------------------------------
      // Sync / Peer-ref commands
      // -----------------------------------------------------------------------

      case 'list_peer_refs': {
        return []
      }

      case 'get_peer_ref': {
        return null
      }

      case 'delete_peer_ref': {
        return undefined
      }

      case 'get_device_id': {
        return 'mock-device-id-0000'
      }

      case 'start_pairing': {
        return { passphrase: 'alpha bravo charlie delta', qr_svg: '<svg></svg>', port: 8765 }
      }

      case 'confirm_pairing': {
        return undefined
      }

      case 'cancel_pairing': {
        return undefined
      }

      case 'start_sync': {
        const a = args as Record<string, unknown>
        return {
          state: 'syncing',
          local_device_id: 'mock-device-id-0000',
          remote_device_id: a['peerId'],
          ops_received: 0,
          ops_sent: 0,
        }
      }

      case 'cancel_sync': {
        return undefined
      }

      case 'set_todo_state': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (!b) throw new Error('not found')
        b['todo_state'] = (a['state'] as string | null) ?? null
        pushOp('set_todo_state', { block_id: a['blockId'], state: b['todo_state'] })
        return { ...b }
      }

      case 'set_priority': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (!b) throw new Error('not found')
        b['priority'] = (a['level'] as string | null) ?? null
        pushOp('set_priority', { block_id: a['blockId'], level: b['priority'] })
        return { ...b }
      }

      case 'set_due_date': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (!b) throw new Error('not found')
        b['due_date'] = (a['date'] as string | null) ?? null
        pushOp('set_due_date', { block_id: a['blockId'], date: b['due_date'] })
        return { ...b }
      }

      case 'set_scheduled_date': {
        const a = args as Record<string, unknown>
        const b = blocks.get(a['blockId'] as string)
        if (!b) throw new Error('not found')
        b['scheduled_date'] = (a['date'] as string | null) ?? null
        pushOp('set_scheduled_date', { block_id: a['blockId'], date: b['scheduled_date'] })
        return { ...b }
      }

      // -----------------------------------------------------------------------
      // Batch count commands
      // -----------------------------------------------------------------------

      case 'count_agenda_batch': {
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
      }

      case 'count_agenda_batch_by_source': {
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
      }

      case 'count_backlinks_batch': {
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
      }

      // -----------------------------------------------------------------------
      // Grouped backlinks + unlinked references
      // -----------------------------------------------------------------------

      case 'list_backlinks_grouped': {
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
      }

      case 'list_unlinked_references': {
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
      }

      // -----------------------------------------------------------------------
      // Word-level diff for history display
      // -----------------------------------------------------------------------

      case 'compute_edit_diff': {
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
      }

      // -----------------------------------------------------------------------
      // Property definition commands
      // -----------------------------------------------------------------------

      case 'create_property_def': {
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
      }

      case 'list_property_defs': {
        return [...propertyDefs.values()]
      }

      case 'update_property_def_options': {
        const a = args as Record<string, unknown>
        const key = a['key'] as string
        const def = propertyDefs.get(key)
        if (!def) throw new Error('property definition not found')
        def['options'] = a['options'] as string
        return { ...def }
      }

      case 'delete_property_def': {
        const a = args as Record<string, unknown>
        const key = a['key'] as string
        propertyDefs.delete(key)
        return undefined
      }

      // -----------------------------------------------------------------------
      // Peer name update
      // -----------------------------------------------------------------------

      case 'update_peer_name': {
        return undefined
      }

      // -----------------------------------------------------------------------
      // Page alias commands
      // -----------------------------------------------------------------------

      case 'set_page_aliases': {
        const a = args as Record<string, unknown>
        const pid = a['pageId'] as string
        const aliases = a['aliases'] as string[]
        pageAliases.set(pid, aliases)
        return aliases
      }

      case 'get_page_aliases': {
        const a = args as Record<string, unknown>
        const pid = a['pageId'] as string
        return pageAliases.get(pid) ?? []
      }

      case 'resolve_page_by_alias': {
        const a = args as Record<string, unknown>
        const alias = (a['alias'] as string).toLowerCase()
        for (const [pid, aliases] of pageAliases.entries()) {
          if (aliases.some((al) => al.toLowerCase() === alias)) {
            const page = blocks.get(pid)
            return [pid, page ? ((page['content'] as string) ?? null) : null]
          }
        }
        return null
      }

      // -----------------------------------------------------------------------
      // Markdown export
      // -----------------------------------------------------------------------

      case 'export_page_markdown': {
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
      }

      // -----------------------------------------------------------------------
      // Markdown import (#660)
      // -----------------------------------------------------------------------

      case 'import_markdown': {
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
      }

      // -----------------------------------------------------------------------
      // Attachment commands (F-7)
      // -----------------------------------------------------------------------

      case 'list_attachments': {
        const a = args as Record<string, unknown>
        const blockId = a['blockId'] as string
        return [...attachments.values()].filter((att) => att['block_id'] === blockId)
      }

      case 'add_attachment': {
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
      }

      case 'delete_attachment': {
        const a = args as Record<string, unknown>
        attachments.delete(a['attachmentId'] as string)
        return null
      }

      // -----------------------------------------------------------------------
      // Projected agenda (repeating tasks)
      // -----------------------------------------------------------------------

      case 'list_projected_agenda':
        return []

      // -----------------------------------------------------------------------
      // Draft autosave (F-17)
      // -----------------------------------------------------------------------

      case 'save_draft':
      case 'flush_draft':
      case 'delete_draft':
        return null

      case 'list_drafts':
        return []

      // -----------------------------------------------------------------------
      // Peer address
      // -----------------------------------------------------------------------

      case 'set_peer_address':
        return null

      // -----------------------------------------------------------------------
      // Page links for graph view (F-33)
      // -----------------------------------------------------------------------

      case 'list_page_links': {
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
      }

      // -----------------------------------------------------------------------
      // Logging commands (fire-and-forget)
      // -----------------------------------------------------------------------

      case 'log_frontend':
        return null

      case 'get_log_dir':
        return '/mock/logs'

      // -----------------------------------------------------------------------
      // Op log compaction commands
      // -----------------------------------------------------------------------

      case 'get_compaction_status':
        return {
          total_ops: opLog.length,
          oldest_op_date: opLog.length > 0 ? (opLog[0]?.created_at ?? null) : null,
          eligible_ops: 0,
          retention_days: 90,
        }

      case 'compact_op_log_cmd':
        return { snapshot_id: null, ops_deleted: 0 }

      // -----------------------------------------------------------------------
      // Point-in-time restore
      // -----------------------------------------------------------------------

      case 'restore_page_to_op':
        return { ops_reverted: 0, non_reversible_skipped: 0, results: [] }

      // -----------------------------------------------------------------------
      // Link metadata
      // -----------------------------------------------------------------------

      case 'fetch_link_metadata': {
        const a = args as Record<string, unknown>
        return {
          url: a['url'],
          title: 'Mock Title',
          favicon_url: null,
          description: null,
          fetched_at: new Date().toISOString(),
          auth_required: false,
        }
      }
      case 'get_link_metadata': {
        const a = args as Record<string, unknown>
        return {
          url: a['url'],
          title: 'Mock Title',
          favicon_url: null,
          description: null,
          fetched_at: new Date().toISOString(),
          auth_required: false,
        }
      }
      case 'clear_link_metadata_auth':
        return null

      default:
        console.warn(`[tauri-mock] Unhandled command: ${cmd}`)
        return null
    }
  })

  // Expose error injection to E2E tests via window globals
  const w = window as unknown as Record<string, unknown>
  w['__injectMockError'] = injectMockError
  w['__clearMockErrors'] = clearMockErrors

  // Expose attachment seeding to E2E tests
  w['__addMockAttachment'] = (
    blockId: string,
    filename: string,
    mimeType: string,
    sizeBytes: number,
  ) => {
    const row = {
      id: fakeId(),
      block_id: blockId,
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      fs_path: `/mock/${filename}`,
      created_at: new Date().toISOString(),
    }
    attachments.set(row.id, row)
    return row
  }
}
