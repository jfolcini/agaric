/**
 * Page mode's link, table and code-block bubbles (#5691) on a real editor and
 * TipTap's real BubbleMenu: each shows for a caret resting in its node and never
 * over a live selection, and each action changes the document (or the clipboard,
 * or opens the link). Persistence through page mode's save is in
 * `e2e/page-mode-bubbles.spec.ts`.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor, type JSONContent } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import Text from '@tiptap/extension-text'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PageBubbleMenus } from '@/editor/page-mode/PageBubbleMenus'
import { t } from '@/lib/i18n'

const mockOpenUrl = vi.fn()
vi.mock('@/lib/open-url', () => ({ openUrl: (url: string) => mockOpenUrl(url) }))
const mockWriteText = vi.fn()
vi.mock('@/lib/clipboard', () => ({ writeText: (text: string) => mockWriteText(text) }))

let editor: Editor
let host: HTMLElement

afterEach(() => {
  editor.destroy()
  host.remove()
  mockOpenUrl.mockReset()
  mockWriteText.mockReset()
})

const text = (value: string, marks?: JSONContent['marks']): JSONContent =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const cell = (type: string, value: string): JSONContent => ({
  type,
  content: [para(text(value))],
})

/** Just inside the first text node that reads `value`. */
function posOf(value: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text === value) found = pos + 1
  })
  return found
}

function setup(content: JSONContent[], caret: number | string) {
  host = document.createElement('div')
  document.body.append(host)
  editor = new Editor({
    element: host,
    extensions: [
      Document,
      Paragraph,
      Text,
      Link,
      CodeBlock,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: { type: 'doc', content },
  })
  const result = render(<PageBubbleMenus editor={editor} />)
  act(() => {
    editor.commands.setTextSelection(typeof caret === 'string' ? posOf(caret) : caret)
  })
  return result
}

const toolbar = (name: string) => screen.queryByRole('toolbar', { name: t(name) })
const press = (name: string) =>
  act(() => {
    fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0 })
  })

const LINK = [
  para(
    text('see '),
    text('example', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
    text(' here'),
  ),
]
const TABLE = [
  {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'a'), cell('tableHeader', 'b')] },
      { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] },
    ],
  },
]
const CODE = [{ type: 'codeBlock', attrs: { language: null }, content: [text('const x = 1')] }]

describe('the link bubble', () => {
  it('shows the href for a caret in a link, and not for a selection or plain text', async () => {
    setup(LINK, 7)
    expect(toolbar('pageMode.linkActions')).toHaveTextContent('https://example.com')

    act(() => {
      editor.commands.setTextSelection({ from: 6, to: 9 })
    })
    await waitFor(() => expect(toolbar('pageMode.linkActions')).toBeNull())

    act(() => {
      editor.commands.setTextSelection(2)
    })
    expect(toolbar('pageMode.linkActions')).toBeNull()
  })

  it('waits for the mouse button to come up, as a bubble under a press ends its drag', async () => {
    setup(LINK, 2)
    act(() => {
      fireEvent.pointerDown(editor.view.dom, { button: 0 })
      editor.commands.setTextSelection(7)
    })
    expect(toolbar('pageMode.linkActions')).toBeNull()

    act(() => {
      fireEvent.pointerUp(window)
    })
    await waitFor(() =>
      expect(toolbar('pageMode.linkActions')).toHaveTextContent('https://example.com'),
    )
  })

  it('has no a11y violations', async () => {
    setup(LINK, 7)
    expect(await axe(toolbar('pageMode.linkActions') as HTMLElement)).toHaveNoViolations()
  })

  it('opens the href', async () => {
    mockOpenUrl.mockResolvedValue(true)
    setup(LINK, 7)
    press(t('contextMenu.openLink'))
    expect(mockOpenUrl).toHaveBeenCalledWith('https://example.com')
    await Promise.resolve()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says so when the link does not open', async () => {
    mockOpenUrl.mockResolvedValue(false)
    setup(LINK, 7)
    press(t('contextMenu.openLink'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('contextMenu.actionFailed')))
  })

  it('removes the whole link from a caret inside it', () => {
    setup(LINK, 7)
    press(t('linkEdit.remove'))
    expect(editor.getJSON().content).toEqual([para(text('see example here'))])
  })

  it("asks for the link popover as Ctrl+K does, with the caret's range", () => {
    setup(LINK, 7)
    const heard = vi.fn()
    editor.view.dom.addEventListener('open-link-popover', (e) => heard((e as CustomEvent).detail))
    press(t('toolbar.link'))
    expect(heard).toHaveBeenCalledWith({ from: 7, to: 7 })
  })
})

describe('the table bubble', () => {
  /** In the first body cell. */
  const IN_CELL = '1'

  it('shows for a caret in a table, and not for a caret outside one', () => {
    setup([...TABLE, para(text('after'))], IN_CELL)
    expect(toolbar('pageMode.tableActions')).not.toBeNull()
    act(() => {
      editor.commands.setTextSelection(posOf('after'))
    })
    expect(toolbar('pageMode.tableActions')).toBeNull()
  })

  it('has no a11y violations', async () => {
    setup(TABLE, IN_CELL)
    expect(await axe(toolbar('pageMode.tableActions') as HTMLElement)).toHaveNoViolations()
  })

  it("adds a row through the table's operations", async () => {
    setup(TABLE, IN_CELL)
    press(t('toolbar.tableOps'))
    const op = await screen.findByTestId('table-op-insert-row-below')
    act(() => {
      fireEvent.pointerDown(op, { button: 0 })
    })
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(3)
  })
})

describe('the code-block bubble', () => {
  it('shows the language for a caret in a code block, and Plain text without one', () => {
    setup(CODE, 3)
    expect(screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })).toHaveTextContent(
      t('toolbar.plainText'),
    )
  })

  it('has no a11y violations', async () => {
    setup(CODE, 3)
    expect(await axe(toolbar('pageMode.codeActions') as HTMLElement)).toHaveNoViolations()
  })

  it('sets the language from the picker', async () => {
    setup(CODE, 3)
    press(t('toolbar.codeBlockLanguage'))
    const row = await screen.findByRole('button', { name: 'python' })
    act(() => {
      fireEvent.pointerDown(row, { button: 0 })
    })
    expect(editor.getJSON().content?.[0]?.attrs?.['language']).toBe('python')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') }),
      ).toHaveTextContent('python'),
    )
  })

  it('copies the code', async () => {
    mockWriteText.mockResolvedValue(undefined)
    setup(CODE, 3)
    press(t('pageMode.codeCopy'))
    expect(mockWriteText).toHaveBeenCalledWith('const x = 1')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t('pageMode.codeCopied')))
  })

  it('says so when the clipboard refuses', async () => {
    mockWriteText.mockRejectedValue(new Error('denied'))
    setup(CODE, 3)
    press(t('pageMode.codeCopy'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('pageMode.codeCopyFailed')))
  })
})
