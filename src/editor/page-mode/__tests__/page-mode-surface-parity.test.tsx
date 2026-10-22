/**
 * What block mode offers and page mode leaves out (#5691): the roving editor's
 * extensions, the block menu's rows, the slash menu's commands and the
 * rebindable chords the block editor answers. Each is in
 * page mode, or left out here with a reason, as the source buffer's are
 * (`source-toolbar-parity.test.ts`), so one added to block mode alone fails
 * here until page mode takes it or names why not. `page-mode-parity.test.ts`
 * is the save's parity.
 */

import { fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import type { BlockActions } from '@/components/block-tree/use-block-actions'
import { searchSlashMenu } from '@/components/block-tree/use-block-slash-commands'
import {
  BLOCK_MENU_ACTION_IDS,
  type BlockMenuActionId,
  type BlockContextMenuProps,
} from '@/components/editor/block-context-menu/types'
import { BlockContextMenu } from '@/components/editor/BlockContextMenu'
import {
  blockId,
  caret,
  idMinter,
  openPage,
  PAGE,
  press,
  type Row,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { FakeTasks, listSource } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PageLists } from '@/editor/page-mode/page-lists'
import { pageModeExtensions } from '@/editor/page-mode/page-mode-extensions'
import { runsAtOnce, searchPageSlashCommands } from '@/editor/page-mode/page-slash-commands'
import { PageBlockMenu } from '@/editor/page-mode/PageBlockMenu'
import { useRovingEditor } from '@/editor/use-roving-editor'
import { DEFAULT_SHORTCUTS, parseChord } from '@/lib/keyboard-config'
import {
  ASSIGNEE_COMMANDS,
  CALLOUT_COMMANDS,
  EFFORT_COMMANDS,
  HEADING_COMMANDS,
  LOCATION_COMMANDS,
  PRIORITY_COMMANDS,
  REPEAT_COMMANDS,
  REPEAT_END_COMMANDS,
  TURN_INTO_COMMANDS,
} from '@/lib/slash-commands'
import { createPageBlockStore } from '@/stores/page-blocks'

vi.mock('@/components/editor/BlockContextMenu', () => ({ BlockContextMenu: vi.fn(() => null) }))
// Offered where the platform can record, which jsdom cannot.
vi.mock('@/components/attachments/voice-recording', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/attachments/voice-recording')>()),
  canRecordVoiceNote: () => true,
}))

/** The roving editor's extensions page mode leaves out, and why. */
const NOT_IN_PAGE_MODE: Record<string, string> = {
  htmlPaste:
    'writes a multi-block paste through the block store; page mode reads Markdown text itself (pagePaste) and rich HTML through ProseMirror',
  taskPaste:
    'makes a pasted task line a task paragraph; page mode keeps the checkbox as text, which the block takes once left',
  checkboxInputRule:
    'writes a typed checkbox to the block store; page mode keeps it as text, which the block takes once left',
  listStyleInputRule: 'writes through the block store; page mode has its own `- ` and `1. ` keys',
  listMarkerDecoration:
    'draws the focused block’s marker; page mode’s node view draws every block’s',
  priorityShortcuts: 'dispatches to the focused block’s tree; page mode binds the keys itself',
}

/** Page mode's own extensions, which take the place of the block tree's. */
const PAGE_MODE_ONLY = new Set([
  'pageBlock',
  'pageTaskKeys',
  'pageBlockIds',
  'pageKeys',
  'pageRenderedKeys',
  'pageListKeys',
  'pageBlockFocus',
  'pageCollapse',
  'pageDrag',
  'pagePaste',
])

/** The block menu's rows page mode leaves out, and why. */
const MENU_NOT_IN_PAGE_MODE: Partial<Record<BlockMenuActionId, string>> = {
  zoomIn: 'page mode shows the whole page; it has no zoom',
}

/**
 * The action each row runs, as `BlockContextMenu` gates it; null for a row
 * the block or the selection alone decides.
 */
const ROW_ACTION: Record<BlockMenuActionId, keyof BlockActions | null> = {
  openInNewTab: 'onOpenLinkInNewTab',
  openLink: null,
  copyUrl: null,
  copyBlockRef: null,
  copyPageRef: null,
  copyBlockContent: null,
  copySubtreeContent: null,
  copySelectionContent: null,
  cycleTodo: 'onToggleTodo',
  setTodo: 'onBatchSetTodo',
  cyclePriority: 'onTogglePriority',
  turnInto: 'onTurnInto',
  moveArrange: null,
  indent: 'onIndent',
  dedent: 'onDedent',
  moveUp: 'onMoveUp',
  moveDown: 'onMoveDown',
  duplicate: 'onDuplicate',
  merge: 'onMerge',
  collapse: 'onToggleCollapse',
  zoomIn: 'onZoomIn',
  history: 'onShowHistory',
  properties: 'onShowProperties',
  delete: 'onDelete',
}

const HEADING_KEYS =
  'block mode runs them from the block tree’s listener, which page mode does not mount; /h1–/h6 and Turn into make headings here'

/** The catalog's categories whose chords the block editor answers. */
const EDITOR_CHORD_CATEGORIES = new Set([
  'keyboard.category.navigation',
  'keyboard.category.editing',
  'keyboard.category.blockTree',
  'keyboard.category.editorFormatting',
])

/** The block editor's rebindable chords page mode does not answer with their action, and why. */
const CHORD_NOT_IN_PAGE_MODE: Record<string, string> = {
  zoomIn: 'page mode shows the whole page; it has no zoom',
  zoomOut: 'page mode shows the whole page; it has no zoom, and its Escape leaves the text',
  heading1: HEADING_KEYS,
  heading2: HEADING_KEYS,
  heading3: HEADING_KEYS,
  heading4: HEADING_KEYS,
  heading5: HEADING_KEYS,
  heading6: HEADING_KEYS,
}

/** The commands page mode runs once a save has created the block (`page-slash-commands.tsx`). */
const AFTER_THE_SAVE = new Set([
  'todo',
  'doing',
  'done',
  'cancelled',
  'due',
  'schedule',
  'effort',
  'assignee',
  'location',
  'repeat',
  'numbered-list',
  'bullet-list',
  'callout',
  'query',
  'voice',
])

/**
 * The options the menu expands only for a typed query (`/turn`, `/priority`, …),
 * which `searchSlashMenu('')` leaves out. Those that write a property or the
 * list style (`turn-*` and `callout-*` set the block's list style) need the block
 * saved first.
 */
const AFTER_THE_SAVE_PREFIXES = [
  'priority-',
  'repeat-',
  'effort-',
  'assignee-',
  'location-',
  'turn-',
  'callout-',
]

const SUB_OPTION_IDS = [
  PRIORITY_COMMANDS,
  HEADING_COMMANDS,
  REPEAT_COMMANDS,
  REPEAT_END_COMMANDS,
  EFFORT_COMMANDS,
  ASSIGNEE_COMMANDS,
  LOCATION_COMMANDS,
  CALLOUT_COMMANDS,
  TURN_INTO_COMMANDS,
].flatMap((options) => options.map((option) => option.id))

const afterTheSave = (id: string): boolean =>
  AFTER_THE_SAVE.has(id) || AFTER_THE_SAVE_PREFIXES.some((prefix) => id.startsWith(prefix))

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

const namesOf = (editor: Editor): string[] =>
  editor.extensionManager.extensions.map((extension) => extension.name)

/** Page mode's editor with every option its session passes. */
function pageModeEditor(): Editor {
  const noItems = () => Promise.resolve([])
  const editor = new Editor({
    extensions: pageModeExtensions({
      resolveTagName: (id) => id,
      resolveBlockTitle: (id) => id,
      resolveBlockStatus: () => 'active',
      resolveTagStatus: () => 'active',
      searchTags: noItems,
      searchPages: noItems,
      searchBlockRefs: noItems,
      onCreatePage: () => Promise.resolve(''),
      onCreateTag: () => Promise.resolve(''),
      onNavigate: () => {},
      onTagClick: () => {},
      placeholder: '',
      pageId: PAGE,
      tasks: new FakeTasks(),
      lists: listSource(new PageLists({}, [])),
      commands: {
        searchSlashCommands: () => [],
        onSlashCommand: () => {},
        searchPropertyKeys: noItems,
      },
    }),
  })
  editors.push(editor)
  return editor
}

describe('the editor’s extensions', () => {
  it('has every one of the roving editor’s, or names why not, and only its own besides', async () => {
    const roving = renderHook(() => useRovingEditor())
    await waitFor(() => expect(roving.result.current.editor).not.toBeNull())
    const blockMode = namesOf(roving.result.current.editor as Editor)
    editors.push(roving.result.current.editor as Editor)
    const pageMode = namesOf(pageModeEditor())

    expect(blockMode.filter((name) => !pageMode.includes(name)).toSorted()).toEqual(
      Object.keys(NOT_IN_PAGE_MODE).toSorted(),
    )
    expect(pageMode.filter((name) => !blockMode.includes(name)).toSorted()).toEqual(
      [...PAGE_MODE_ONLY].toSorted(),
    )
    roving.unmount()
  })
})

describe('the block menu', () => {
  /** The actions and rows the menu gets on a right click on the second of two saved blocks. */
  function openMenu(): Pick<BlockContextMenuProps, 'actions' | 'actionIds'> {
    const [first, second] = [blockId(1), blockId(2)]
    const editor = openPage(
      [
        [first, 0, 'first'],
        [second, 0, 'second'],
      ],
      idMinter(),
    )
    editors.push(editor)
    const pageStore = createPageBlockStore(PAGE)
    pageStore.setState({ blocksById: new Map([[second, makeBlock({ id: second })]]) })
    const actions = {
      current: {
        cycle: vi.fn(),
        setTodo: vi.fn(),
        cyclePriority: vi.fn(),
        openPropertyDrawer: vi.fn(),
        openHistory: vi.fn(),
        turnInto: vi.fn(),
      },
    }
    render(
      <PageBlockMenu
        editor={editor}
        pageId={PAGE}
        pageStore={pageStore}
        actions={actions}
        onOpenLinkInNewTab={vi.fn()}
      />,
    )
    const block = editor.view.dom.querySelector(`[data-page-block-id="${second}"]`) as Element
    fireEvent.contextMenu(block, { clientX: 1, clientY: 1 })
    const props = vi.mocked(BlockContextMenu).mock.lastCall?.[0]
    if (props === undefined) throw new Error('the block menu did not open')
    return props
  }

  it.each([...BLOCK_MENU_ACTION_IDS])('offers %s, or names why not', (id) => {
    const { actions, actionIds } = openMenu()
    const action = ROW_ACTION[id]
    const offered =
      actionIds?.has(id) === true && (action === null || actions[action] !== undefined)
    const reason = MENU_NOT_IN_PAGE_MODE[id]
    expect(offered || reason !== undefined).toBe(true)
    expect(offered && reason !== undefined).toBe(false)
    if (reason !== undefined) expect(reason.trim()).not.toBe('')
  })
})

describe('the slash menu', () => {
  const blockModeIds = searchSlashMenu('').map((command) => command.id)
  const pageModeIds = new Set(searchPageSlashCommands('').map((command) => command.id))

  it.each([...new Set([...blockModeIds, ...SUB_OPTION_IDS])])(
    '%s runs as it is picked, after the save, or is not offered',
    (id) => {
      const offered = pageModeIds.has(id) || SUB_OPTION_IDS.includes(id)
      const ways = [runsAtOnce(id), afterTheSave(id), !offered]
      expect(ways.filter(Boolean)).toHaveLength(1)
    },
  )

  it('names no command after the save that the menu does not have', () => {
    expect([...AFTER_THE_SAVE].filter((id) => !blockModeIds.includes(id))).toEqual([])
  })
})

describe('the block editor’s chords', () => {
  const chords = DEFAULT_SHORTCUTS.filter(
    (shortcut) => shortcut.rebindable !== false && EDITOR_CHORD_CATEGORIES.has(shortcut.category),
  )

  /** The key and modifiers of the binding's first chord, as the browser reports them. */
  function chordEvent(keys: string): [string, KeyboardEventInit] {
    const chord = parseChord(keys.split(' / ')[0] as string)
    if (chord === null) throw new Error(`no chord in ${keys}`)
    const key = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key.replaceAll(' ', '')
    return [key, { ctrlKey: chord.ctrl, altKey: chord.alt, shiftKey: chord.shift }]
  }

  it.each(chords.map((shortcut) => [shortcut.id, shortcut.keys]))(
    '%s (%s) is answered in page mode, or names why not',
    (id, keys) => {
      // The caret beside a page link, in a saved block with a block under it: where every chord acts.
      const rows: Row[] = [
        [blockId(1), 0, 'first'],
        [blockId(2), 0, `[[${blockId(9)}]] second`],
        [blockId(3), 1, 'third'],
      ]
      const lists = new PageLists(
        {},
        rows.map(([rowId, depth]) => ({ id: rowId, depth })),
      )
      const editor = openPage(rows, idMinter(), undefined, listSource(lists), new FakeTasks())
      editors.push(editor)
      caret(editor, 1, 1)
      expect(press(editor, ...chordEvent(keys)) || CHORD_NOT_IN_PAGE_MODE[id] !== undefined).toBe(
        true,
      )
    },
  )

  it('waives only the block editor’s chords', () => {
    const ids = new Set(chords.map((shortcut) => shortcut.id))
    expect(Object.keys(CHORD_NOT_IN_PAGE_MODE).filter((id) => !ids.has(id))).toEqual([])
  })
})
