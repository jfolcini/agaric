/**
 * The in-page find bar's replace row (#6608) over a page's block tree: what
 * Replace and Replace all save, the one undo entry Replace all leaves, a match
 * in a chip left alone, and a failed save stopping the run.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlock, makeBlockRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { strictInvokeFallback, stubInvoke } from '@/__tests__/helpers/invoke'
import { InPageFind } from '@/components/query/InPageFind'
import { takeReloadedText } from '@/editor/active-editor'
import { registerBlockCommandTarget } from '@/stores/block-command-bus'
import { createPageBlockStore, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

vi.mock('@/editor/active-editor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/editor/active-editor')>()),
  reloadBaseline: () => 'baseline',
  takeReloadedText: vi.fn(() => true),
}))

const mockedInvoke = vi.mocked(invoke)

const LINKED = '01HZZZZZZZZZZZZZZZZZZZPAGE'
const PAGE = 'PAGE_1'

/** What the backend holds, by block id. */
let saved: Map<string, string>
/** Block ids whose save the backend refuses. */
let refuse: Set<string>
let store: StoreApi<PageBlockState>
let unregister: () => void
let host: HTMLDivElement

function seed(rows: Array<[string, string]>): void {
  saved = new Map(rows)
  store.setState({
    blocks: rows.map(([id, content], position) =>
      makeBlock({ id, content, position, parent_id: PAGE }),
    ),
  })
  host.innerHTML = rows
    .map(
      ([id]) =>
        `<li data-block-id="${id}"><div data-testid="block-static" data-block-id="${id}"></div></li>`,
    )
    .join('')
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  useUndoStore.setState({ pages: new Map() })
  useInPageFindStore.setState({
    open: false,
    query: '',
    toggles: { caseSensitive: false, wholeWord: false, isRegex: false },
    totalMatches: 0,
    currentIndex: -1,
    regexError: null,
    skippedLongNodes: 0,
    lastQuery: '',
    replaceOpen: false,
    replacement: '',
  })
  refuse = new Set()
  let seq = 0
  mockedInvoke.mockImplementation(strictInvokeFallback)
  stubInvoke(mockedInvoke, {
    edit_block: (args) => {
      const id = String(args['blockId'])
      if (refuse.has(id)) throw new Error('disk full')
      saved.set(id, String(args['toText']))
      return {
        ...makeBlockRow({ id, content: String(args['toText']) }),
        op_refs: [{ device_id: 'dev1', seq: ++seq }],
      }
    },
  })
  store = createPageBlockStore(PAGE)
  unregister = registerBlockCommandTarget(store, {})
  host = document.createElement('div')
  document.body.append(host)
  useInPageFindStore.getState().setContainer(host)
})

afterEach(() => {
  unregister()
  host.remove()
  useInPageFindStore.getState().setContainer(null)
})

async function openReplace(query: string, replacement: string) {
  const user = userEvent.setup()
  const { container } = render(<InPageFind />)
  act(() => {
    useInPageFindStore.getState().open$(query)
    useInPageFindStore.getState().setReplaceOpen(true)
  })
  const input = await screen.findByRole('textbox', { name: 'Replace with' })
  await user.type(input, replacement)
  return { user, input, container }
}

const contents = () => store.getState().blocks.map((b) => b.content)

describe('InPageFind replace row', () => {
  it('Replace all saves every block, leaves a chip match, and is one undo entry', async () => {
    seed([
      ['A', 'foo and **f**oo'],
      ['B', 'nothing here'],
      ['C', `a [[${LINKED}|foo link]] then foo`],
    ])
    const { user } = await openReplace('foo', 'bar')
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('1 of 4'),
    )
    expect(screen.getByTestId('in-page-replace-status')).toHaveTextContent(
      '1 match is in a link, tag or block reference and will be left as it is',
    )

    await user.click(screen.getByRole('button', { name: 'Replace all' }))

    await waitFor(() =>
      expect(screen.getByTestId('in-page-replace-status')).toHaveTextContent(
        'Replaced 3 matches · 1 in a link, tag or reference left as it is',
      ),
    )
    const expected = ['bar and **bar**', 'nothing here', `a [[${LINKED}|foo link]] then bar`]
    expect(contents()).toEqual(expected)
    expect(['A', 'B', 'C'].map((id) => saved.get(id))).toEqual(expected)
    const stack = useUndoStore.getState().pages.get(PAGE)?.undoStack
    expect(stack?.map((entry) => entry.refs?.map((ref) => ref.seq))).toEqual([[1, 2]])
    // Only the chip's match is left.
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('1 of 1'),
    )

    // A new replacement drops the report of the run before it.
    await user.type(screen.getByRole('textbox', { name: 'Replace with' }), 'n')
    expect(screen.getByTestId('in-page-replace-status')).toHaveTextContent(
      '1 match is in a link, tag or block reference and will be left as it is',
    )
  })

  it('Replace (Enter) changes the current match only and moves past what it put in', async () => {
    seed([['A', 'foo foo']])
    const { user, input } = await openReplace('foo', 'foofoo')
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('1 of 2'),
    )

    await user.click(input)
    await user.keyboard('{Enter}')

    await waitFor(() => expect(saved.get('A')).toBe('foofoo foo'))
    expect(contents()).toEqual(['foofoo foo'])
    // Three matches now; the current one is the original second, not the text put in.
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('3 of 3'),
    )
  })

  it('Ctrl+Alt+Enter replaces all, with regex groups', async () => {
    seed([['A', 'x 2026-11-12 y']])
    useInPageFindStore.getState().setToggles({ isRegex: true })
    const { user, input } = await openReplace('(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1')
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('1 of 1'),
    )

    await user.click(input)
    await user.keyboard('{Control>}{Alt>}{Enter}{/Alt}{/Control}')

    await waitFor(() => expect(saved.get('A')).toBe('x 12/11/2026 y'))
  })

  it('a failed save stops the run, leaves the blocks after it, and says so', async () => {
    seed([
      ['A', 'foo one'],
      ['B', 'foo two'],
      ['C', 'foo three'],
    ])
    refuse.add('B')
    const { user } = await openReplace('foo', 'bar')
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('1 of 3'),
    )

    await user.click(screen.getByRole('button', { name: 'Replace all' }))

    await waitFor(() =>
      expect(screen.getByTestId('in-page-replace-status')).toHaveTextContent(
        'A save failed: stopped after 1 replaced',
      ),
    )
    expect(['A', 'B', 'C'].map((id) => saved.get(id))).toEqual(['bar one', 'foo two', 'foo three'])
    expect(contents()).toEqual(['bar one', 'foo two', 'foo three'])
    // A focused editor is handed only the text that was saved.
    expect(vi.mocked(takeReloadedText).mock.calls.map(([id]) => id)).toEqual(['A'])
  })

  it('recounts the matches left in a chip when the query changes but the count does not', async () => {
    seed([
      ['A', 'foo'],
      ['B', `[[${LINKED}|bar]]`],
    ])
    await openReplace('foo', 'x')
    await waitFor(() =>
      expect(screen.getByTestId('in-page-find-counter')).toHaveTextContent('1 of 1'),
    )
    expect(screen.getByTestId('in-page-replace-status')).toHaveTextContent('')

    act(() => useInPageFindStore.getState().setQuery('bar'))

    await waitFor(() =>
      expect(screen.getByTestId('in-page-replace-status')).toHaveTextContent(
        '1 match is in a link, tag or block reference and will be left as it is',
      ),
    )
  })

  it('has accessible controls and no a11y violations', async () => {
    seed([['A', 'foo']])
    const { container } = await openReplace('foo', 'bar')
    expect(screen.getByRole('button', { name: 'Replace (Ctrl+H)' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Replace' })).toBeEnabled()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
