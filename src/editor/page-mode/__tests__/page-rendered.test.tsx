/**
 * Page mode's query and embed blocks (#5743, #5915): which text block mode
 * draws as results, the results each block's view draws in its place over the
 * mock backend, and the arrows that step into such a block.
 *
 * Equivalent mutants, accepted:
 * - `renderedText`'s cheap test before the serialiser, each part dropped or
 *   loosened (its `?.`s, its text node, its `{{`): it only spares a block the
 *   serialise, and the sniff after it decides the same. A page block and a
 *   text node always hold a first child and a text.
 * - `arrow.dir > 0` → `>= 0`: a direction is 1 or -1.
 * - The extension's name: nothing looks it up.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, within } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  blockId,
  caret,
  openPage,
  posIn,
  press,
  type Row,
  rowsOf,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockEl,
  FakeTasks,
  mountNodeViews,
  SCOPE,
  seedPage,
  settleReads,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { RENDERED, renderedText } from '@/editor/page-mode/page-rendered'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)

const QUERY = '{{query tag:work}}'
const WELCOME = 'Welcome to Agaric! This is your personal knowledge base.'
const embedOf = (id: string) => `{{embed ((${id}))}}`

const mockedInvoke = vi.mocked(invoke)

let teardown: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IntersectionObserver', undefined)
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

function mount(rows: readonly Row[], tasks = new FakeTasks()) {
  const mounted = mountNodeViews(rows, tasks)
  teardown = () => {
    mounted.unmount()
    mounted.editor.destroy()
  }
  return mounted
}

/** What block `id`'s results list. */
function results(container: HTMLElement, id: string): string[] {
  return [
    ...blockEl(container, id).querySelectorAll(
      '.page-block-rendered [data-testid="query-result-item"]',
    ),
  ].map((item) => item.textContent ?? '')
}

describe('renderedText', () => {
  function textOf(markdown: string): string | null {
    const editor = openPage([[A, 0, markdown]])
    const text = renderedText(editor.state.doc.child(0))
    editor.destroy()
    return text
  }

  it('is a query’s or an embed’s whole text, the block or the page form', () => {
    expect(textOf(QUERY)).toBe(QUERY)
    expect(textOf(embedOf(B))).toBe(embedOf(B))
    expect(textOf(`{{embed [[${B}]]}}`)).toBe(`{{embed [[${B}]]}}`)
    // Block mode's embed sniff trims the text.
    expect(textOf(`  ${embedOf(B)}`)).toBe(`  ${embedOf(B)}`)
  })

  it('is null for plain text, a half-typed token, another `{{` token or one with text after it', () => {
    expect(textOf('plain')).toBeNull()
    expect(textOf('{{query tag:work')).toBeNull()
    expect(textOf('{{querytag:work}}')).toBeNull()
    expect(textOf('{{query tag:work}} more')).toBeNull()
    expect(textOf('{{embed ((x)) y}}')).toBeNull()
    expect(textOf('{{template x}}')).toBeNull()
    expect(textOf(`[[${B}]] {{query tag:work}}`)).toBeNull()
    expect(textOf('')).toBeNull()
  })
})

describe('a query or an embed in its block', () => {
  it('draws block mode’s results and embed after the text, outside it, with no a11y violations', async () => {
    const { container } = mount([
      [A, 0, 'first'],
      [B, 0, QUERY],
      [C, 0, embedOf(SEED_IDS.BLOCK_GS_1)],
    ])
    await settleReads()

    expect(results(container, B)).toHaveLength(4)
    const embed = within(blockEl(container, C)).getByTestId('embed-container')
    expect(embed).toHaveTextContent(WELCOME)
    for (const id of [B, C]) {
      const block = blockEl(container, id)
      const drawn = block.querySelector('.page-block-rendered') as HTMLElement
      expect(block).toHaveAttribute(RENDERED, '')
      expect(drawn.contentEditable).toBe('false')
      expect(drawn.previousElementSibling).toHaveClass('page-block-content')
    }
    expect(blockEl(container, A)).not.toHaveAttribute(RENDERED)
    expect(blockEl(container, A).querySelector('.page-block-rendered')).toBeNull()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('an embed of a page draws the page’s blocks', async () => {
    const embedded = seedPage(['alpha', 'beta'], 'Embedded page')
    const { container } = mount([[A, 0, `{{embed [[${embedded.pageId}]]}}`]])
    await settleReads()

    const embed = within(blockEl(container, A)).getByTestId('embed-container')
    expect(embed).toHaveTextContent('alpha')
    expect(embed).toHaveTextContent('beta')
  })

  it('an embed of a page that cannot be read shows block mode’s unresolved state, and logs why', async () => {
    const embedded = seedPage(['alpha'], 'Embedded page')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'get_block' && (args as { blockId: string }).blockId === embedded.pageId) {
        throw new Error('database locked')
      }
      return dispatch(cmd, args)
    })
    const { container, editor } = mount([[A, 0, `{{embed [[${embedded.pageId}]]}}`]])
    await settleReads()

    expect(within(blockEl(container, A)).getByTestId('embed-unresolved')).toHaveTextContent(
      t('embed.unresolved'),
    )
    expect(warn).toHaveBeenCalledWith(
      'EmbedContainer',
      'embed target fetch failed',
      { targetId: embedded.pageId },
      expect.any(Error),
    )
    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, `{{embed [[${embedded.pageId}]]}}`]])
  })

  it('a click on the results puts the caret in the text, through the block’s edit', async () => {
    const tasks = new FakeTasks()
    const { container } = mount(
      [
        [A, 0, 'first'],
        [B, 0, QUERY],
      ],
      tasks,
    )
    await settleReads()

    fireEvent.click(
      blockEl(container, B).querySelector('[data-testid="query-result-item"]') as Element,
    )

    expect(tasks.edit).toHaveBeenCalledWith(B)
  })
})

describe('the arrows into a block drawn as its results', () => {
  function open() {
    return mount([
      [A, 0, 'first'],
      [B, 0, QUERY],
      [C, 0, 'last'],
    ])
  }

  /** Press `key` with the browser's caret at the edge of its textblock towards `side`. */
  function arrow(editor: Editor, key: string, side: string, init: KeyboardEventInit = {}) {
    const edge = vi.spyOn(editor.view, 'endOfTextblock').mockImplementation((dir) => dir === side)
    let taken = false
    act(() => {
      taken = press(editor, key, init)
    })
    edge.mockRestore()
    return taken
  }

  const caretBlock = (editor: Editor) => editor.state.selection.$head.index(0)

  it('Down and Right from the block before step in at its start; Up and Left from the one after, at its end', () => {
    const { editor } = open()
    const end = QUERY.length

    for (const [from, key, side, offset] of [
      [0, 'ArrowDown', 'down', 0],
      [0, 'ArrowRight', 'right', 0],
      [2, 'ArrowUp', 'up', end],
      [2, 'ArrowLeft', 'left', end],
    ] as const) {
      act(() => caret(editor, from, from === 0 ? 5 : 0))
      expect(arrow(editor, key, side)).toBe(true)
      expect(caretBlock(editor)).toBe(1)
      expect(editor.state.selection.head).toBe(posIn(editor, 1, offset))
    }
  })

  it('leave an arrow with a rule on its way to the block to the editor', () => {
    const { editor } = mount([
      [A, 0, 'first\n\n---'],
      [B, 0, QUERY],
      [C, 0, '---\n\nlast'],
    ])

    act(() => caret(editor, 0, 5))
    expect(arrow(editor, 'ArrowDown', 'down')).toBe(false)
    act(() => {
      editor.commands.setTextSelection(
        posIn(editor, 2, 0) + editor.state.doc.child(2).child(0).nodeSize,
      )
    })
    expect(arrow(editor, 'ArrowUp', 'up')).toBe(false)
    expect(caretBlock(editor)).toBe(2)
  })

  it('leave the caret to the browser into a block drawn as text, with a modifier, a selection, or mid-line', () => {
    const { editor } = open()

    act(() => caret(editor, 1, 0))
    expect(arrow(editor, 'ArrowDown', 'down')).toBe(false)
    act(() => caret(editor, 0, 5))
    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
    ]) {
      expect(arrow(editor, 'ArrowDown', 'down', init)).toBe(false)
    }
    expect(arrow(editor, 'ArrowDown', 'up')).toBe(false)
    expect(arrow(editor, 'PageDown', 'down')).toBe(false)
    act(() => {
      editor.commands.setTextSelection({ from: posIn(editor, 0, 1), to: posIn(editor, 0, 3) })
    })
    expect(arrow(editor, 'ArrowDown', 'down')).toBe(false)
    act(() => caret(editor, 2, 4))
    expect(arrow(editor, 'ArrowDown', 'down')).toBe(false)
    expect(caretBlock(editor)).toBe(2)
  })
})
