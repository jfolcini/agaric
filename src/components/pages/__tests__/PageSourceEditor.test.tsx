/**
 * PageSourceEditor + PageSourceConflictDialog — Edit as Markdown (#5140, #5160).
 *
 * The buffer is the real TipTap editor (`PageSourceBuffer`), its lines under
 * their block ids. Keys go through the keyboard; whole edits go through the
 * editor's own transactions, as typing does. The save paths that change the
 * page run against the REAL tauri-mock dispatch and re-read the page's buffer
 * afterwards; the paths that only decide what to show stub the IPCs.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { writeText as pluginWriteText } from '@tauri-apps/plugin-clipboard-manager'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import type React from 'react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { type CommandReturns, deferred, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PageSourceConflictDialog } from '@/components/pages/PageSourceConflictDialog'
import { PageSourceEditor, refusedLine } from '@/components/pages/PageSourceEditor'
import { readLines, type SourceLines } from '@/editor/source-buffer'
import type { PageBuffer } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, pageAliases, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

const PAGE_ID = '01J00000000000000000000PAG'
const A = '01J0000000000000000000000A'
const B = '01J0000000000000000000000B'
const BUFFER: PageBuffer = {
  source: `- first ^${A}\n- second ^${B}\n`,
  text: '- first\n- second\n',
  line_ids: [A, B, null],
}
const draftKey = (pageId = PAGE_ID): string => `agaric-page-source-draft:${pageId}`
const WELCOME = '- Welcome to Agaric!'
const HELLO = '- Hello, Agaric!'

function report(
  overrides: Partial<CommandReturns['apply_page_source']> = {},
): CommandReturns['apply_page_source'] {
  return {
    op_refs: [{ device_id: 'dev1', seq: 1 }],
    created: 0,
    edited: 0,
    moved: 0,
    deleted: 0,
    properties_set: 0,
    properties_deleted: 0,
    names_created: [],
    warnings: [],
    ...overrides,
  }
}

/** `get_page_buffer` answers BUFFER; `apply_page_source` as given. */
function stubSource(applyPageSource: () => unknown = () => report()): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      get_page_buffer: () => BUFFER,
      apply_page_source: applyPageSource as () => CommandReturns['apply_page_source'],
      load_page_subtree: () => ({ blocks: [], truncated: false, total: 0 }),
    }),
  )
}

/** Every IPC goes to the real tauri-mock; returns the seeded page's buffer. */
function routeToMockBackend(): PageBuffer {
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  return pageBuffer(SEED_IDS.PAGE_GETTING_STARTED)
}

function pageBuffer(pageId: string): PageBuffer {
  return dispatch('get_page_buffer', { pageId }) as PageBuffer
}

function renderEditor(pageId = PAGE_ID) {
  const onClose = vi.fn()
  const store = createPageBlockStore(pageId)
  const utils = render(
    <PageBlockContext.Provider value={store}>
      <PageSourceEditor pageId={pageId} onClose={onClose} />
    </PageBlockContext.Provider>,
  )
  return { ...utils, onClose, store }
}

async function loadedEditor(): Promise<HTMLElement> {
  return screen.findByRole('textbox', { name: t('pageSource.editorLabel') })
}

function editorOf(box: HTMLElement): Editor {
  return (box as HTMLElement & { editor: Editor }).editor
}

function bufferOf(box: HTMLElement): SourceLines {
  return readLines(editorOf(box).state.doc)
}

/** The first line holding `find`: its text and where that starts. */
function lineOf(ed: Editor, find: string): { text: string; start: number } {
  let found: { text: string; start: number } | null = null
  ed.state.doc.forEach((line, offset) => {
    if (found === null && line.textContent.includes(find)) {
      found = { text: line.textContent, start: offset + 1 }
    }
  })
  if (found === null) throw new Error(`no line holds ${find}`)
  return found
}

/** Replace `find`, within one line, with `replacement`, as typing over it does. */
function edit(box: HTMLElement, find: string, replacement: string): void {
  const ed = editorOf(box)
  const { start, text } = lineOf(ed, find)
  const from = start + text.indexOf(find)
  act(() => {
    ed.view.dispatch(ed.state.tr.insertText(replacement, from, from + find.length))
  })
}

/** Remove the line holding `find`, line break and all. */
function deleteLine(box: HTMLElement, find: string): void {
  const ed = editorOf(box)
  const { start, text } = lineOf(ed, find)
  act(() => {
    ed.view.dispatch(ed.state.tr.delete(start, start + text.length + 2))
  })
}

/** Put the caret at the end of the line holding `find`, or of the buffer. */
function caretAtEnd(box: HTMLElement, find?: string): void {
  const ed = editorOf(box)
  act(() => {
    if (find === undefined) ed.commands.focus('end')
    else {
      const { start, text } = lineOf(ed, find)
      ed.commands.focus(start + text.length)
    }
  })
}

function applyCalls(): unknown[] {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'apply_page_source').map(([, a]) => a)
}

interface ReportOptions {
  description?: React.ReactNode
  duration?: number
  action?: { label: string; onClick: () => void }
}

/** The one save report shown, a success or (with warnings) a warning toast. */
function saveReport(): { message: string; options: ReportOptions } {
  const calls = [...vi.mocked(toast.success).mock.calls, ...vi.mocked(toast.warning).mock.calls]
  expect(calls).toHaveLength(1)
  const [message, options] = calls[0] as [string, ReportOptions]
  return { message, options }
}

/** The report's body, rendered on its own. */
function renderReportBody(options: ReportOptions): HTMLElement {
  const { container } = render(<div data-testid="report-body">{options.description}</div>)
  return container
}

/** Open the seeded page, edit the buffer and save it with Ctrl+S. */
async function saveSeededPage(change: (box: HTMLElement) => void) {
  const base = routeToMockBackend()
  const rendered = renderEditor(SEED_IDS.PAGE_GETTING_STARTED)
  const user = userEvent.setup()
  const box = await loadedEditor()
  change(box)
  await user.keyboard('{Control>}s{/Control}')
  await waitFor(() => {
    expect(rendered.onClose).toHaveBeenCalledOnce()
  })
  return { ...rendered, base, user }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({ currentView: 'page-editor', selectedBlockId: null })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  stubSource()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PageSourceEditor loading', () => {
  it('shows the page’s text in a focused textbox, each block’s id on the line it starts on and none in the text', async () => {
    const buffer = routeToMockBackend()
    renderEditor(SEED_IDS.PAGE_GETTING_STARTED)

    const box = await loadedEditor()

    expect(bufferOf(box)).toEqual({ text: buffer.text, lineIds: buffer.line_ids })
    expect(box).toHaveTextContent(WELCOME.slice(2))
    expect(box.textContent).not.toContain('^')
    expect(
      [...box.querySelectorAll('[data-block-id]')].map((line) =>
        line.getAttribute('data-block-id'),
      ),
    ).toEqual([
      SEED_IDS.BLOCK_GS_1,
      SEED_IDS.BLOCK_GS_2,
      SEED_IDS.BLOCK_GS_3,
      SEED_IDS.BLOCK_GS_4,
      SEED_IDS.BLOCK_GS_5,
    ])
    await waitFor(() => expect(box).toHaveFocus())
    expect(box).toHaveAttribute('aria-multiline', 'true')
    expect(box).toHaveAttribute('data-testid', 'page-source-editor')
  })

  it('a rejected load shows the load-failed alert, logs, and Close closes', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const failure = { kind: 'not_found', message: `page '${PAGE_ID}' not found` }
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ get_page_buffer: () => Promise.reject(failure) }),
    )
    const user = userEvent.setup()
    const { onClose } = renderEditor()

    expect(await screen.findByRole('alert')).toHaveTextContent(t('pageSource.loadFailed'))
    expect(errorSpy).toHaveBeenCalledWith(
      'PageSourceEditor',
      'Failed to load page source',
      { pageId: PAGE_ID },
      failure,
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('ui.close') }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has no a11y violations once loaded', async () => {
    const { container } = renderEditor()
    await loadedEditor()

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('with no draft restored, is described by the hint alone', async () => {
    renderEditor()
    const box = await loadedEditor()

    expect(box).toHaveAccessibleDescription(t('pageSource.hint'))
  })
})

describe('PageSourceEditor saving', () => {
  it('Save writes the edited text with each line’s id, closes, and the page reads back as the buffer', async () => {
    const base = routeToMockBackend()
    const { BLOCK_GS_1, PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose, store } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()

    edit(box, WELCOME, HELLO)
    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    const text = base.text.replace(WELCOME, HELLO)
    expect(applyCalls()).toEqual([
      {
        pageId: PAGE_GETTING_STARTED,
        source: text,
        baseSource: base.source,
        force: false,
        merge: false,
        lineIds: base.line_ids,
      },
    ])
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual({ ...base, text, source: expect.any(String) })
    expect(store.getState().blocksById.get(BLOCK_GS_1)?.content).toBe(
      'Hello, Agaric! This is your personal knowledge base.',
    )
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
  })

  it('a line whose first word is cut and retyped saves as the same block, which a ((ref)) still finds', async () => {
    routeToMockBackend()
    const { BLOCK_GS_1, BLOCK_QN_2, PAGE_GETTING_STARTED } = SEED_IDS
    dispatch('edit_block', { blockId: BLOCK_QN_2, toText: `See ((${BLOCK_GS_1})).` })
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    const ed = editorOf(box)
    const { start } = lineOf(ed, WELCOME)

    act(() => {
      ed.commands.setTextSelection({ from: start, to: start + '- Welcome'.length })
      box.dispatchEvent(
        new ClipboardEvent('cut', {
          clipboardData: new DataTransfer(),
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText('- Hello, welcome', start))
    })
    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    const referrer = dispatch('get_block', { blockId: BLOCK_QN_2 }) as { content: string }
    const target = /\(\(([0-9A-Z]{26})\)\)/.exec(referrer.content)?.[1]
    expect(dispatch('get_block', { blockId: target })).toMatchObject({
      content: 'Hello, welcome to Agaric! This is your personal knowledge base.',
      deleted_at: null,
    })
  })

  it('Enter at the end of a bullet starts the next one, which saves as a new block after it', async () => {
    const base = routeToMockBackend()
    const { BLOCK_GS_1, BLOCK_GS_2, PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()

    caretAtEnd(box, WELCOME)
    await user.keyboard('{Enter}')
    await user.keyboard('Added by Enter')
    const at = base.line_ids.indexOf(BLOCK_GS_1)
    expect(
      bufferOf(box)
        .text.split('\n')
        .slice(at, at + 3),
    ).toEqual([
      expect.stringMatching(/^- Welcome/),
      '- Added by Enter',
      expect.stringMatching(/^- Use the sidebar/),
    ])
    await user.keyboard('{Control>}s{/Control}')

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    const saved = pageBuffer(PAGE_GETTING_STARTED)
    expect(saved.text.split('\n')[at + 1]).toBe('- Added by Enter')
    const added = saved.line_ids[at + 1] as string
    expect([saved.line_ids[at], saved.line_ids[at + 2]]).toEqual([BLOCK_GS_1, BLOCK_GS_2])
    expect(base.line_ids).not.toContain(added)
    expect(dispatch('get_block', { blockId: added })).toMatchObject({ content: 'Added by Enter' })
  })

  it('Save with the buffer unchanged closes without any IPC', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await loadedEditor()

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(['get_page_buffer'])
  })

  it('Mod+Enter in the buffer saves', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    edit(await loadedEditor(), WELCOME, HELLO)

    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED).text).toBe(base.text.replace(WELCOME, HELLO))
  })

  it.each([
    ['Ctrl+S', { ctrlKey: true }],
    ['Cmd+S', { metaKey: true }],
  ])('%s in the buffer saves, and the browser does not see it', async (_, modifier) => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    edit(box, WELCOME, HELLO)

    const notPrevented = fireEvent.keyDown(box, { key: 's', ...modifier })

    expect(notPrevented).toBe(false)
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED).text).toBe(base.text.replace(WELCOME, HELLO))
  })

  it('a second Mod+Enter while the save is in flight does not save again', async () => {
    const base = routeToMockBackend()
    const gate = deferred<void>()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'apply_page_source') await gate.promise
      return dispatch(cmd, args)
    })
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    edit(await loadedEditor(), WELCOME, HELLO)

    await user.keyboard('{Control>}{Enter}{Enter}{/Control}')
    gate.resolve()

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(pageBuffer(PAGE_GETTING_STARTED).text).toBe(base.text.replace(WELCOME, HELLO))
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
  })

  it('disables Save and makes the buffer read-only while the save is in flight', async () => {
    const pending = deferred<CommandReturns['apply_page_source']>()
    stubSource(() => pending.promise)
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const box = await loadedEditor()
    edit(box, 'first', 'first x')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(screen.getByRole('button', { name: t('action.save') })).toBeDisabled()
    await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'false'))
    expect(box).toHaveAttribute('aria-readonly', 'true')
    pending.resolve(report())
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  it('lists the save warnings one per line in a warning report that stays until dismissed', async () => {
    const warnings = ['line 2: a copy of the block on line 1; saved as a new block', 'second']
    stubSource(() => report({ warnings }))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    edit(await loadedEditor(), 'first', 'first x')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    const { message, options } = saveReport()
    expect(message).toBe(t('pageSource.saved'))
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    const body = renderReportBody(options)
    expect(within(body).getByText(t('pageSource.reportWarnings'))).toBeInTheDocument()
    expect(
      within(body)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(warnings)
    expect(within(body).queryByText(/deleted/)).not.toBeInTheDocument()
  })

  it('a rejected save shows the backend message inline, logs, and keeps the buffer open', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = { kind: 'validation', message: 'the save would nest a block too deep' }
    stubSource(() => Promise.reject(failure))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const box = await loadedEditor()
    edit(box, 'second', 'second, edited')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(failure.message)
    expect(bufferOf(box)).toEqual({ text: '- first\n- second, edited\n', lineIds: [A, B, null] })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(warnSpy).toHaveBeenCalledWith(
      'PageSourceEditor',
      'Failed to save page source',
      { pageId: PAGE_ID },
      failure,
    )
  })

  it('a refusal naming a line selects that line of the buffer (#5160 X3)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = { kind: 'validation', message: "line 2: 'due' takes a date" }
    stubSource(() => Promise.reject(failure))
    const user = userEvent.setup()
    renderEditor()
    const box = await loadedEditor()
    edit(box, 'first', 'first x')
    caretAtEnd(box, 'first x')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(failure.message)
    await waitFor(() => expect(box).toHaveFocus())
    const { from, to } = editorOf(box).state.selection
    expect(editorOf(box).state.doc.textBetween(from, to)).toBe('- second')
    expect(lineOf(editorOf(box), '- second').start).toBe(from)
  })
})

describe('PageSourceEditor front matter (#5160 S8)', () => {
  const FRONT_MATTER = ['---', 'aliases: [getting-started, gs]', '---', '']

  it('opens with the page’s front matter first, its lines carrying no id, and saving it unchanged writes nothing', async () => {
    const base = routeToMockBackend()
    const { BLOCK_GS_1, PAGE_GETTING_STARTED } = SEED_IDS
    const ops = opLog.length
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()

    const { text, lineIds } = bufferOf(box)
    expect(text.split('\n').slice(0, FRONT_MATTER.length)).toEqual(FRONT_MATTER)
    expect(lineIds.slice(0, FRONT_MATTER.length + 1)).toEqual([null, null, null, null, BLOCK_GS_1])
    await user.click(screen.getByRole('button', { name: t('action.save') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(applyCalls()).toEqual([])
    expect(opLog).toHaveLength(ops)
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual(base)
  })

  it('an alias typed into the front matter is saved, and the block edited under it is the save’s one block write', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const ops = opLog.length
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()

    edit(box, 'aliases: [getting-started, gs]', 'aliases: [getting-started, gs, handbook]')
    edit(box, WELCOME, HELLO)
    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageAliases.get(PAGE_GETTING_STARTED)?.toSorted()).toEqual([
      'getting-started',
      'gs',
      'handbook',
    ])
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual({
      ...base,
      text: base.text.replace('gs]', 'gs, handbook]').replace(WELCOME, HELLO),
      source: expect.any(String),
    })
    expect(opLog.slice(ops).map((op) => op.op_type)).toEqual(['edit_block'])
  })
})

describe('refusedLine', () => {
  it('is the line, counted from 0, the message starts by naming', () => {
    expect(refusedLine('line 1: x')).toBe(0)
    expect(refusedLine('line 12: x')).toBe(11)
  })

  it('is null for a message that names no line first', () => {
    for (const message of ['x', 'block 2: x', 'see line 2: x', 'line two: x']) {
      expect(refusedLine(message)).toBeNull()
    }
  })
})

describe('PageSourceEditor emptying the page', () => {
  it('asks before deleting every block: Cancel keeps the buffer, Delete all saves it', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    act(() => {
      editorOf(box).chain().selectAll().deleteSelection().insertContent('  ').run()
    })

    const save = screen.getByRole('button', { name: t('action.save') })
    await user.click(save)
    const confirm = await screen.findByRole('alertdialog', {
      name: t('pageSource.deleteAllTitle'),
    })
    await user.click(within(confirm).getByRole('button', { name: t('dialog.cancel') }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    await waitFor(() => expect(save).toHaveFocus())
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual(base)
    expect(bufferOf(box).text).toBe('  ')
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: t('action.save') }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('pageSource.deleteAll'),
      }),
    )

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED).text).toBe('')
  })
})

describe('PageSourceEditor when the page changed elsewhere', () => {
  const ELSEWHERE = 'Edited on another device'

  /** Opens the seeded page, edits the buffer, changes a block behind its back, and saves. */
  async function saveOverAChange(
    change: (box: HTMLElement) => void = (box) => edit(box, WELCOME, HELLO),
  ) {
    const base = routeToMockBackend()
    const { BLOCK_GS_3, PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const rendered = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    change(box)
    const edited = bufferOf(box)
    dispatch('edit_block', { blockId: BLOCK_GS_3, toText: ELSEWHERE })
    const current = pageBuffer(PAGE_GETTING_STARTED)

    await user.click(screen.getByRole('button', { name: t('action.save') }))
    const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })
    return { ...rendered, base, box, current, dialog, edited, user }
  }

  it('opens the conflict dialog listing what changed since the buffer was loaded', async () => {
    const { dialog, onClose } = await saveOverAChange()

    const row = within(dialog).getByText(`- ${ELSEWHERE} ^${SEED_IDS.BLOCK_GS_3}`)
    expect(row.closest('li')).toHaveTextContent(t('pageSource.changeChanged'))
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Overwrite saves the buffer with force against the page as it is now, and the buffer wins', async () => {
    const { base, current, dialog, edited, onClose, user } = await saveOverAChange()
    const { PAGE_GETTING_STARTED } = SEED_IDS

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.overwrite') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    const save = { pageId: PAGE_GETTING_STARTED, source: edited.text, lineIds: edited.lineIds }
    expect(applyCalls()).toEqual([
      { ...save, baseSource: base.source, force: false, merge: false },
      { ...save, baseSource: current.source, force: true, merge: false },
    ])
    expect(pageBuffer(PAGE_GETTING_STARTED).text).toBe(edited.text)
  })

  it('Merge saves the buffer against its own base with the change made elsewhere folded in, as one undo entry', async () => {
    const { current, dialog, onClose, user } = await saveOverAChange()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    await waitFor(() => {
      expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).not.toBeNull()
    })

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.merge') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual({
      ...current,
      text: current.text.replace(WELCOME, HELLO),
      source: expect.any(String),
    })
    expect(useUndoStore.getState().pages.get(PAGE_GETTING_STARTED)?.undoStack).toHaveLength(1)
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBeNull()
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
  })

  it("Merge keeps both versions of a block changed on both sides, the buffer's first, and warns", async () => {
    const mine = '- Mine: new blocks by pressing Enter'
    const { current, dialog, onClose, user } = await saveOverAChange((box) =>
      edit(box, '- Create new blocks by pressing Enter', mine),
    )

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.merge') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(SEED_IDS.PAGE_GETTING_STARTED).text).toBe(
      current.text.replace(`- ${ELSEWHERE}`, `${mine} at the end of any block.\n- ${ELSEWHERE}`),
    )
    expect(vi.mocked(toast.warning)).toHaveBeenCalledOnce()
  })

  it('a refused Merge shows the backend message inline and keeps the buffer', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = { kind: 'validation', message: 'the merge would nest a block too deep' }
    const replies = [{ kind: 'validation', code: 'RequiresRefresh', message: 'stale' }, failure]
    stubSource(() => Promise.reject(replies.shift()))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const box = await loadedEditor()
    edit(box, 'first', 'first x')
    await user.click(screen.getByRole('button', { name: t('action.save') }))
    const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.merge') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(failure.message)
    expect(bufferOf(box).text).toBe('- first x\n- second\n')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Reload replaces the buffer and its base with the page as it is now and drops the draft', async () => {
    const { current, dialog, onClose, user } = await saveOverAChange()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    await waitFor(() => {
      expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).not.toBeNull()
    })

    await user.click(within(dialog).getByRole('button', { name: t('action.reload') }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    const box = await loadedEditor()
    expect(bufferOf(box)).toEqual({ text: current.text, lineIds: current.line_ids })
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBeNull()
    // The new base is the page as it is now, so the reloaded buffer saves without a conflict.
    edit(box, WELCOME, HELLO)
    await user.click(screen.getByRole('button', { name: t('action.save') }))
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED).text).toBe(current.text.replace(WELCOME, HELLO))
  })

  it('Keep editing closes the dialog and keeps the buffer', async () => {
    const { box, dialog, edited, onClose, user } = await saveOverAChange()

    await user.click(within(dialog).getByRole('button', { name: t('pageSource.keepEditing') }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(box).toHaveFocus()
    })
    expect(bufferOf(box)).toEqual(edited)
    expect(applyCalls()).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('PageSourceEditor draft', () => {
  it('writes the buffer and its line ids as a draft while it differs from the page, and drops it when it matches again', async () => {
    const user = userEvent.setup()
    renderEditor()
    const box = await loadedEditor()
    caretAtEnd(box, '- second')

    await user.keyboard('x')
    await waitFor(() => {
      expect(localStorage.getItem(draftKey())).toBe(
        JSON.stringify({
          base: BUFFER.source,
          text: '- first\n- secondx\n',
          lineIds: [A, B, null],
        }),
      )
    })

    await user.keyboard('{Backspace}')
    await waitFor(() => {
      expect(localStorage.getItem(draftKey())).toBeNull()
    })
  })

  // The edit and `unmount()` run in one task, so the 300 ms timer cannot fire between.
  it('leaving before the debounce fires still stores the last keystrokes', async () => {
    const { unmount } = renderEditor()
    const box = await loadedEditor()

    edit(box, 'second', 'second x')
    unmount()

    expect(localStorage.getItem(draftKey())).toBe(
      JSON.stringify({ base: BUFFER.source, text: '- first\n- second x\n', lineIds: [A, B, null] }),
    )
  })

  it('leaving after Cancel and Discard stores nothing', async () => {
    const user = userEvent.setup()
    const { unmount } = renderEditor()
    edit(await loadedEditor(), 'second', 'second x')

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))
    await user.click(await screen.findByRole('button', { name: t('pageSource.discard') }))
    unmount()

    expect(localStorage.getItem(draftKey())).toBeNull()
  })

  it('restores a stored draft with its line ids over the page, says so, saves it and clears it', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const draft = {
      base: base.source,
      text: base.text.replace(WELCOME, HELLO),
      lineIds: base.line_ids,
    }
    localStorage.setItem(draftKey(PAGE_GETTING_STARTED), JSON.stringify(draft))
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()

    expect(bufferOf(box)).toEqual({ text: draft.text, lineIds: draft.lineIds })
    expect(box).toHaveAccessibleDescription(
      `${t('pageSource.draftRestored')} ${t('pageSource.hint')}`,
    )

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual({
      ...base,
      text: draft.text,
      source: expect.any(String),
    })
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBeNull()
  })

  it('a line cut before leaving, pasted into the draft restored, still saves as a move', async () => {
    routeToMockBackend()
    const { BLOCK_GS_1, BLOCK_GS_2, BLOCK_GS_3, BLOCK_GS_4, BLOCK_GS_5, PAGE_GETTING_STARTED } =
      SEED_IDS
    const leaving = renderEditor(PAGE_GETTING_STARTED)
    const before = editorOf(await loadedEditor())
    const cut = new DataTransfer()
    act(() => {
      const line = lineOf(before, 'Create new blocks')
      before.commands.setTextSelection({ from: line.start, to: line.start + line.text.length + 2 })
      before.view.dom.dispatchEvent(
        new ClipboardEvent('cut', { clipboardData: cut, bubbles: true, cancelable: true }),
      )
    })
    leaving.unmount()

    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    expect(bufferOf(box).lineIds).not.toContain(BLOCK_GS_3)
    act(() => {
      editorOf(box).commands.setTextSelection(lineOf(editorOf(box), WELCOME).start)
      box.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: cut, bubbles: true, cancelable: true }),
      )
    })
    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(pageBuffer(PAGE_GETTING_STARTED).line_ids.filter((id) => id !== null)).toEqual([
      BLOCK_GS_3,
      BLOCK_GS_1,
      BLOCK_GS_2,
      BLOCK_GS_4,
      BLOCK_GS_5,
    ])
  })

  it('a restored draft the page has changed since saves nothing and opens the conflict dialog', async () => {
    const now = routeToMockBackend()
    const { BLOCK_GS_1, PAGE_GETTING_STARTED } = SEED_IDS
    const before = '- Welcome, before an edit elsewhere!'
    const draft = {
      base: now.source.replace(WELCOME, before),
      text: `${now.text.replace(WELCOME, before)}- mine\n`,
      lineIds: [...now.line_ids, null],
    }
    localStorage.setItem(draftKey(PAGE_GETTING_STARTED), JSON.stringify(draft))
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    await loadedEditor()

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    const dialog = await screen.findByRole('dialog', { name: t('pageSource.conflictTitle') })
    const gs1Now = now.source.split('\n').find((line) => line.endsWith(` ^${BLOCK_GS_1}`)) as string
    expect(within(dialog).getByText(gs1Now).closest('li')).toHaveTextContent(
      t('pageSource.changeChanged'),
    )
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual(now)
    expect(onClose).not.toHaveBeenCalled()
    expect(localStorage.getItem(draftKey(PAGE_GETTING_STARTED))).toBe(JSON.stringify(draft))
  })

  it('Cancel on a restored draft asks, and Discard drops the draft and closes without saving', async () => {
    const draft = { base: BUFFER.source, text: '- first\n- second x\n', lineIds: [A, B, null] }
    localStorage.setItem(draftKey(), JSON.stringify(draft))
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    await loadedEditor()

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: t('pageSource.discard') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(localStorage.getItem(draftKey())).toBeNull()
    expect(applyCalls()).toEqual([])
  })

  it.each([
    ['not JSON', '{not json'],
    ['missing its text', JSON.stringify({ base: BUFFER.source, lineIds: [A] })],
    ['with a non-string base', JSON.stringify({ base: 1, text: BUFFER.text, lineIds: [A] })],
    ['with line ids that are not ids', JSON.stringify({ base: '', text: 'x', lineIds: [1] })],
  ])('ignores a draft that is %s and shows the page', async (_, stored) => {
    localStorage.setItem(draftKey(), stored)
    renderEditor()

    const box = await loadedEditor()

    expect(bufferOf(box)).toEqual({ text: BUFFER.text, lineIds: BUFFER.line_ids })
    expect(box).toHaveAccessibleDescription(t('pageSource.hint'))
    expect(screen.queryByText(t('pageSource.legacyDraft'))).not.toBeInTheDocument()
  })
})

describe('PageSourceEditor with a draft from before the line ids (#5160 D-f)', () => {
  const OLD = { base: BUFFER.source, text: `- first, edited earlier ^${A}\n- second ^${B}\n` }

  it('shows it read-only beside the page, keeps it stored, and Copy puts its text on the clipboard', async () => {
    localStorage.setItem(draftKey(), JSON.stringify(OLD))
    const user = userEvent.setup()
    const { container } = renderEditor()
    const box = await loadedEditor()

    expect(bufferOf(box)).toEqual({ text: BUFFER.text, lineIds: BUFFER.line_ids })
    expect(box).toHaveAccessibleDescription(t('pageSource.hint'))
    const earlier = screen.getByRole('textbox', { name: t('pageSource.legacyDraft') })
    expect(earlier).toHaveValue(OLD.text)
    expect(earlier).toHaveAttribute('readonly')
    expect(localStorage.getItem(draftKey())).toBe(JSON.stringify(OLD))
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })

    await user.click(screen.getByRole('button', { name: t('pageSource.copyLegacyDraft') }))

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(t('pageSource.legacyDraftCopied'))
    })
    expect(vi.mocked(pluginWriteText)).toHaveBeenCalledWith(OLD.text)
  })

  it('a failed Copy says so and logs', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const failure = new Error('clipboard denied')
    vi.mocked(pluginWriteText).mockRejectedValueOnce(failure)
    const fallback = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(failure)
    localStorage.setItem(draftKey(), JSON.stringify(OLD))
    const user = userEvent.setup()
    renderEditor()
    await loadedEditor()

    try {
      await user.click(screen.getByRole('button', { name: t('pageSource.copyLegacyDraft') }))

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageSource.copyFailed'))
      })
      expect(fallback).toHaveBeenCalledWith(OLD.text)
      expect(warnSpy).toHaveBeenCalledWith(
        'PageSourceEditor',
        'Failed to copy the earlier draft',
        { pageId: PAGE_ID },
        failure,
      )
    } finally {
      fallback.mockRestore()
    }
  })
})

describe('PageSourceEditor Cancel and Escape', () => {
  it('Cancel with the text changed asks: Keep editing keeps the buffer, Discard closes without saving', async () => {
    const base = routeToMockBackend()
    const { PAGE_GETTING_STARTED } = SEED_IDS
    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    caretAtEnd(box)
    await user.keyboard('- mine')
    const cancel = screen.getByRole('button', { name: t('action.cancel') })

    await user.click(cancel)
    const confirm = await screen.findByRole('alertdialog', { name: t('pageSource.discardTitle') })
    await user.click(within(confirm).getByRole('button', { name: t('pageSource.keepEditing') }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    await waitFor(() => expect(cancel).toHaveFocus())
    expect(bufferOf(box).text).toBe(`${base.text}- mine`)
    expect(onClose).not.toHaveBeenCalled()

    await user.click(cancel)
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('pageSource.discard'),
      }),
    )

    expect(onClose).toHaveBeenCalledOnce()
    expect(pageBuffer(PAGE_GETTING_STARTED)).toEqual(base)
    expect(applyCalls()).toEqual([])
  })

  it('Cancel after lines that read the same swapped places, their ids with them, still asks', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        get_page_buffer: () => ({
          source: `- same ^${A}\n- same ^${B}\n`,
          text: '- same\n- same\n',
          line_ids: [A, B, null],
        }),
      }),
    )
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const box = await loadedEditor()
    const ed = editorOf(box)
    // The second line, from its start to the start of the line after it.
    const second = 1 + ed.state.doc.child(0).nodeSize
    act(() => {
      ed.commands.setTextSelection({ from: second, to: second + ed.state.doc.child(1).nodeSize })
    })
    const clipboard = new DataTransfer()
    act(() => {
      fireEvent(box, new ClipboardEvent('cut', { clipboardData: clipboard, bubbles: true }))
      ed.commands.setTextSelection(1)
      fireEvent(box, new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true }))
    })
    expect(bufferOf(box)).toEqual({ text: '- same\n- same\n', lineIds: [B, A, null] })

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    expect(
      await screen.findByRole('alertdialog', { name: t('pageSource.discardTitle') }),
    ).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Discard leaves focus where the page puts it on close, not pulled back into the dialog', async () => {
    const store = createPageBlockStore(PAGE_ID)
    function Page(): React.ReactElement {
      const kebab = useRef<HTMLButtonElement>(null)
      const [open, setOpen] = useState(true)
      const close = (): void => {
        setOpen(false)
        kebab.current?.focus()
      }
      return (
        <PageBlockContext.Provider value={store}>
          <button ref={kebab} type="button">
            Page actions
          </button>
          {open && <PageSourceEditor pageId={PAGE_ID} onClose={close} />}
        </PageBlockContext.Provider>
      )
    }
    const user = userEvent.setup()
    render(<Page />)
    edit(await loadedEditor(), 'first', 'first x')

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))
    await user.click(await screen.findByRole('button', { name: t('pageSource.discard') }))

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Page actions' })).toHaveFocus())
  })

  it('Cancel with the text back as loaded closes without asking', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    caretAtEnd(await loadedEditor())
    await user.keyboard('x{Backspace}')

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('Escape with the text changed asks, reaches nothing outside the buffer, and Escape again keeps editing', async () => {
    const outside = vi.fn()
    window.addEventListener('keydown', outside)
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const box = await loadedEditor()
    caretAtEnd(box)
    await user.keyboard('x')
    outside.mockClear()

    await user.keyboard('{Escape}')

    expect(
      await screen.findByRole('alertdialog', { name: t('pageSource.discardTitle') }),
    ).toBeInTheDocument()
    expect(outside).not.toHaveBeenCalled()
    window.removeEventListener('keydown', outside)
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    await waitFor(() => expect(box).toHaveFocus())
    expect(bufferOf(box).text).toBe(`${BUFFER.text}x`)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape with the text as loaded closes without asking', async () => {
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    const box = await loadedEditor()
    await waitFor(() => expect(box).toHaveFocus())

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('an Escape that ends an input-method composition leaves the buffer open', async () => {
    const { onClose } = renderEditor()
    const box = await loadedEditor()

    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('the discard dialog has no a11y violations', async () => {
    const user = userEvent.setup()
    renderEditor()
    edit(await loadedEditor(), 'first', 'first x')

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    const confirm = await screen.findByRole('alertdialog', { name: t('pageSource.discardTitle') })
    expect(confirm).toHaveAccessibleDescription(t('pageSource.discardBody'))
    await waitFor(async () => {
      expect(await axe(confirm)).toHaveNoViolations()
    })
  })
})

describe('PageSourceEditor save report', () => {
  const NEW_PAGE = 'Brand New Page'
  const NEW_TAG = 'fresh-tag'

  /** Drops the last bullet and links a page and a tag no name matches yet from the first. */
  const deleteAndName = (box: HTMLElement): void => {
    deleteLine(box, '**Use the search panel**')
    edit(box, 'knowledge base.', `knowledge base. See [[${NEW_PAGE}]] #${NEW_TAG}`)
  }

  /** What the mock backend answered the (one) save with. */
  async function applied(): Promise<CommandReturns['apply_page_source']> {
    const i = mockedInvoke.mock.calls.findIndex(([cmd]) => cmd === 'apply_page_source')
    return (await mockedInvoke.mock.results[i]?.value) as CommandReturns['apply_page_source']
  }

  it('a save that deletes blocks and creates names keeps a report until dismissed: counts, and the names as links', async () => {
    const { user } = await saveSeededPage(deleteAndName)

    const { message, options } = saveReport()
    expect(message).toBe(t('pageSource.saved'))
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    const body = renderReportBody(options)
    expect(within(body).getByText('1 block deleted, 1 edited')).toBeInTheDocument()
    expect(within(body).getByText(t('pageSource.reportCreated'))).toBeInTheDocument()
    const links = within(body).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([NEW_PAGE, `#${NEW_TAG}`])
    await waitFor(async () => {
      expect(await axe(body)).toHaveNoViolations()
    })

    await user.click(links[0] as HTMLElement)

    const opened = selectPageStack(useTabsStore.getState()).at(-1)
    expect(opened?.title).toBe(NEW_PAGE)
    const row = dispatch('get_block', { blockId: opened?.pageId }) as { content: string }
    expect(row.content).toBe(NEW_PAGE)
  })

  it('a save with nothing to report says Saved for the usual few seconds, with Undo', async () => {
    await saveSeededPage((box) => edit(box, WELCOME, HELLO))

    const { message, options } = saveReport()
    expect(message).toBe(t('pageSource.saved'))
    expect(options.duration).toBeUndefined()
    expect(options.description).toBeUndefined()
    expect(options.action?.label).toBe(t('action.undo'))
  })

  it('Undo in the report reverts the whole save, the page and tag it created included', async () => {
    const { base } = await saveSeededPage(deleteAndName)
    const created = (await applied()).names_created.map((row) => row.id)
    expect(created).toHaveLength(2)

    await act(async () => {
      saveReport().options.action?.onClick()
    })

    await waitFor(() => {
      expect(pageBuffer(SEED_IDS.PAGE_GETTING_STARTED)).toEqual(base)
    })
    for (const id of created) {
      expect(() => dispatch('get_block', { blockId: id })).toThrow('not found')
    }
    expect(useUndoStore.getState().pages.get(SEED_IDS.PAGE_GETTING_STARTED)?.undoStack).toEqual([])
  })

  it('a stale Undo reverts nothing and says why', async () => {
    const { store } = await saveSeededPage(deleteAndName)
    const later = 'Edited after the save'
    await act(() => store.getState().edit(SEED_IDS.BLOCK_GS_2, later))
    const afterEdit = pageBuffer(SEED_IDS.PAGE_GETTING_STARTED)
    expect(afterEdit.text).toContain(`- ${later}\n`)

    await act(async () => {
      saveReport().options.action?.onClick()
    })

    expect(vi.mocked(toast)).toHaveBeenLastCalledWith(t('pageSource.undoStale'))
    expect(pageBuffer(SEED_IDS.PAGE_GETTING_STARTED)).toEqual(afterEdit)
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain('undo_ops')
  })

  it('a save that wrote nothing offers no Undo, so none can revert an earlier change', async () => {
    stubSource(() => report({ op_refs: [] }))
    useUndoStore.getState().onNewAction(PAGE_ID, [{ device_id: 'dev1', seq: 7 }])
    const user = userEvent.setup()
    const { onClose } = renderEditor()
    edit(await loadedEditor(), 'first', 'first x')

    await user.click(screen.getByRole('button', { name: t('action.save') }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect(saveReport().options.action).toBeUndefined()
  })

  it('lines pasted from another page’s buffer save as new blocks, with no warning, and that page is unchanged', async () => {
    const base = routeToMockBackend()
    const { BLOCK_QN_1, BLOCK_QN_2, PAGE_GETTING_STARTED, PAGE_QUICK_NOTES } = SEED_IDS
    const notes = pageBuffer(PAGE_QUICK_NOTES)
    const pasted = notes.text.split('\n').slice(0, 2)
    expect(notes.line_ids.slice(0, 2)).toEqual([BLOCK_QN_1, BLOCK_QN_2])
    const copying = renderEditor(PAGE_QUICK_NOTES)
    const notesEditor = editorOf(await loadedEditor())
    const copied = new DataTransfer()
    act(() => {
      const last = lineOf(notesEditor, pasted[1] as string)
      notesEditor.commands.setTextSelection({ from: 1, to: last.start + last.text.length })
      notesEditor.view.dom.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: copied, bubbles: true, cancelable: true }),
      )
    })
    expect(copied.getData('text/html')).toContain(BLOCK_QN_1)
    copying.unmount()

    const user = userEvent.setup()
    const { onClose } = renderEditor(PAGE_GETTING_STARTED)
    const box = await loadedEditor()
    caretAtEnd(box)
    act(() => {
      box.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: copied, bubbles: true, cancelable: true }),
      )
    })
    await user.keyboard('{Control>}s{/Control}')

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
    expect((await applied()).warnings).toEqual([])
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
    const saved = pageBuffer(PAGE_GETTING_STARTED)
    expect(saved.text).toBe(`${base.text}${pasted.join('\n')}\n`)
    const added = saved.line_ids.slice(base.line_ids.length - 1, -1)
    expect(added).toHaveLength(2)
    for (const id of added) {
      expect(id).toEqual(expect.any(String))
      expect([BLOCK_QN_1, BLOCK_QN_2, ...base.line_ids]).not.toContain(id)
    }
    expect(pageBuffer(PAGE_QUICK_NOTES)).toEqual(notes)
  })
})

describe('PageSourceConflictDialog', () => {
  const base = `- one ^${A}\n- two ^${B}\n`

  it('says only the order changed when no block did', () => {
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- two ^${B}\n- one ^${A}\n`}
        onMerge={vi.fn()}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={vi.fn()}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: t('pageSource.conflictTitle') })
    expect(within(dialog).getByText(t('pageSource.onlyOrderChanged'))).toBeInTheDocument()
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument()
  })

  it('offers Merge as the primary action: last, focused on open, described by what it does', async () => {
    const onMerge = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- one ^${A}\n`}
        onMerge={onMerge}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={vi.fn()}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    const footer = dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement
    expect(
      within(footer)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      t('pageSource.overwrite'),
      t('action.reload'),
      t('pageSource.keepEditing'),
      t('pageSource.merge'),
    ])
    const merge = within(footer).getByRole('button', { name: t('pageSource.merge') })
    expect(merge).toHaveFocus()
    expect(merge).toHaveAccessibleDescription(t('pageSource.mergeHint'))
    await user.click(merge)
    expect(onMerge).toHaveBeenCalledOnce()
  })

  it('describes Overwrite with its warning and closing it keeps editing', async () => {
    const onKeepEditing = vi.fn()
    const user = userEvent.setup()
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- one ^${A}\n`}
        onMerge={vi.fn()}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={onKeepEditing}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', { name: t('pageSource.overwrite') }),
    ).toHaveAccessibleDescription(t('pageSource.overwriteWarning'))
    await user.keyboard('{Escape}')
    expect(onKeepEditing).toHaveBeenCalledOnce()
  })

  it('has no a11y violations listing changes', async () => {
    render(
      <PageSourceConflictDialog
        base={base}
        current={`- one, edited ^${A}\n- three\n`}
        onMerge={vi.fn()}
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onKeepEditing={vi.fn()}
        onCloseAutoFocus={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3)
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
