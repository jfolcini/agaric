/**
 * Tauri mock — shared state, seed data, and helpers.
 *
 * All mutable state lives here as module-level Maps/arrays/counters. The
 * handler dispatch (handlers.ts) imports these and reads/writes them. That
 * keeps the decomposition a pure refactor without introducing a state-object
 * plumbing layer.
 */

let counter = 0

/** Generate a deterministic fake ULID-ish id for newly created rows. */
export function fakeId(): string {
  counter += 1
  return `MOCK${String(counter).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// In-memory stores — exported so handlers.ts can read/write them directly.
// Maps are reference types; mutating them from another module works fine.
// ---------------------------------------------------------------------------

export const blocks: Map<string, Record<string, unknown>> = new Map()

// Property store: block_id → key → PropertyRow
export const properties: Map<string, Map<string, Record<string, unknown>>> = new Map()

// Block-tag associations: block_id → Set<tag_id>
export const blockTags: Map<string, Set<string>> = new Map()

// Property definitions store
export const propertyDefs: Map<string, Record<string, unknown>> = new Map()

// Page aliases store: page_id → string[]
export const pageAliases: Map<string, string[]> = new Map()

// Attachment store: attachment_id → AttachmentRow-like object
export const attachments: Map<string, Record<string, unknown>> = new Map()

// Op log for undo/redo/history
export interface MockOpLogEntry {
  [key: string]: unknown
  device_id: string
  seq: number
  op_type: string
  payload: string
  created_at: string
}

export const opLog: MockOpLogEntry[] = []
let opSeqCounter = 0

export function pushOp(opType: string, payload: Record<string, unknown>): MockOpLogEntry {
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
// Date helpers — keep output deterministic relative to fake timers in tests.
// ---------------------------------------------------------------------------

export function todayDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function offsetDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Seed data IDs — exported for tests and external reference
// ---------------------------------------------------------------------------

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

export function makeBlock(
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

// ---------------------------------------------------------------------------
// Seed loader — clears every store and re-inserts the canonical fixture.
// ---------------------------------------------------------------------------

export function seedBlocks(): void {
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

// ---------------------------------------------------------------------------
// E2E attachment seeding helper. Exposed on `window.__addMockAttachment` by
// setupMock() so Playwright specs can pre-seed attachments before interacting
// with the UI.
// ---------------------------------------------------------------------------

export function addMockAttachment(
  blockId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Record<string, unknown> {
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
