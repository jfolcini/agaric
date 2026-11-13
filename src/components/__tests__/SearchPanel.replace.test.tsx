/**
 * Replace across pages in `<SearchPanel>` (#6608).
 *
 * A small vault stands in for the backend: `search_blocks` answers from it,
 * `edit_blocks_batch` writes to it and `undo_ops` puts a run back, so each
 * test reads what a replace left behind, not only what it was asked.
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { SearchPanel } from '@/components/SearchPanel'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import type { OpRef, SearchBlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { MAX_BATCH_BLOCK_IDS } from '@/lib/ipc-helpers'
import { useNavigationStore } from '@/stores/navigation'
import { useSearchHistoryStore } from '@/stores/search-history'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

const mockedInvoke = vi.mocked(invoke)

const PAGE_A = '01HZ00000000000000000PAGEA'
const PAGE_B = '01HZ00000000000000000PAGEB'

function row(id: string, content: string, pageId: string, blockType = 'content'): SearchBlockRow {
  return {
    id,
    block_type: blockType,
    content,
    parent_id: blockType === 'page' ? null : pageId,
    position: 1,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: pageId,
  }
}

/** The vault: every row the search can return, as the backend holds it now. */
let vault: SearchBlockRow[]
/** The content each appended op overwrote, by its `seq`. */
let overwritten: Map<number, { id: string; content: string | null }>

interface Edit {
  blockId: string
  expected: string
  toText: string
}

function stubVault(handlers: Readonly<TypedInvokeHandlers> = {}) {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      // A superset, as the index gives: every row, whatever the query.
      search_blocks: () => ({
        items: vault.map((r) => ({ ...r })),
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
      batch_resolve: () => [],
      edit_blocks_batch: (args) => {
        const { edits } = args as { edits: Edit[] }
        const skipped: string[] = []
        const op_refs: OpRef[] = []
        for (const edit of edits) {
          const held = vault.find((r) => r.id === edit.blockId)
          if (held === undefined || held.content !== edit.expected) {
            skipped.push(edit.blockId)
            continue
          }
          const seq = overwritten.size + 1
          overwritten.set(seq, { id: held.id, content: held.content })
          held.content = edit.toText
          op_refs.push({ device_id: 'DEV', seq })
        }
        return { skipped, op_refs }
      },
      undo_ops: (args) => {
        for (const { seq } of (args as { ops: OpRef[] }).ops) {
          const prior = overwritten.get(seq)
          const held = vault.find((r) => r.id === prior?.id)
          if (held !== undefined && prior !== undefined) held.content = prior.content
        }
        return []
      },
      ...handlers,
    }),
  )
}

function contentOf(id: string): string | null {
  return vault.find((r) => r.id === id)?.content ?? null
}

function callsOf(command: string): unknown[] {
  return mockedInvoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1])
}

/** Search `find`, open the replace row and type `replacement`. */
async function openReplace(find: string, replacement: string) {
  const user = userEvent.setup()
  render(<SearchPanel />)
  const input = screen.getByRole('combobox', { name: t('search.searchLabel') })
  fireEvent.change(input, { target: { value: find } })
  const form = input.closest('form')
  if (form) fireEvent.submit(form)
  await user.click(screen.getByTestId('search-replace-toggle'))
  const replaceInput = screen.getByRole('textbox', { name: t('findInPage.replaceInputLabel') })
  if (replacement !== '') await user.type(replaceInput, replacement)
  return { user, run: () => screen.getByTestId('search-replace-run') }
}

function runLabel(blocks: number, pages: number): string {
  return t('search.replace.run', {
    blocks: t('search.replace.blocks', { count: blocks }),
    pages: t('search.replace.pages', { count: pages }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSearchHistoryStore.setState({ bySpace: {} })
  useNavigationStore.setState({ currentView: 'search', selectedBlockId: null })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  overwritten = new Map()
  vault = [
    row('A1', 'one needle here', PAGE_A),
    row('A2', 'two Needle, needle', PAGE_A),
    row('B1', 'three needle', PAGE_B),
    // The match is a link's label: found, never rewritten.
    row('B2', `see [[${PAGE_A}|needle link]]`, PAGE_B),
    // A page title holding the text: found, never rewritten.
    row(PAGE_B, 'needle notes', PAGE_B, 'page'),
    // A candidate the index returned that does not hold the text.
    row('B3', 'nee dle', PAGE_B),
  ]
})

describe('SearchPanel replace across pages', () => {
  it('searches the typed text as one phrase with the modes off', async () => {
    stubVault()
    await openReplace('one needle', '')

    await waitFor(() => {
      const last = callsOf('search_blocks').at(-1) as {
        query: string
        filter: Record<string, unknown>
      }
      expect(last.query).toBe('"one needle"')
      expect(last.filter['caseSensitive']).toBe(false)
      expect(last.filter['wholeWord']).toBe(false)
      expect(last.filter['isRegex']).toBe(false)
    })
  })

  it('previews the blocks a replace changes, ticked, and counts what it leaves', async () => {
    stubVault()
    const { run } = await openReplace('needle', 'pin')

    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'search-replace-row-A1',
      'search-replace-row-A2',
      'search-replace-row-B1',
    ])
    for (const r of rows) expect(r).toHaveAttribute('aria-selected', 'true')
    // Both matches of A2 are struck, each with the replacement beside it.
    const a2 = screen.getByTestId('search-replace-row-A2')
    expect([...a2.querySelectorAll('del')].map((d) => d.textContent)).toEqual(['Needle', 'needle'])
    expect([...a2.querySelectorAll('ins')].map((i) => i.textContent)).toEqual(['pin', 'pin'])
    expect(screen.getByTestId('search-replace-status')).toHaveTextContent(
      `${t('findInPage.unreplaceable', { count: 1 })} · ${t('search.replace.namesSkipped', { count: 1 })}`,
    )
  })

  it('matches as the case toggle says', async () => {
    stubVault()
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))

    await user.click(screen.getByTestId('search-toggle-case-sensitive'))

    const a2 = await screen.findByTestId('search-replace-row-A2')
    await waitFor(() =>
      expect([...a2.querySelectorAll('del')].map((d) => d.textContent)).toEqual(['needle']),
    )
  })

  it('unticks a row with a click or Space, and a page with its checkbox', async () => {
    stubVault()
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))

    await user.click(screen.getByTestId('search-replace-row-B1'))
    expect(screen.getByTestId('search-replace-row-B1')).toHaveAttribute('aria-selected', 'false')
    expect(run()).toHaveTextContent(runLabel(2, 1))

    // Space on the listbox toggles the row the roving focus is on: the first.
    const listbox = screen.getByTestId(`search-result-group-${PAGE_A}`)
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true')
    listbox.focus()
    await user.keyboard(' ')
    expect(screen.getByTestId('search-replace-row-A1')).toHaveAttribute('aria-selected', 'false')
    expect(run()).toHaveTextContent(runLabel(1, 1))

    const pageBox = screen.getByTestId(`search-replace-page-${PAGE_A}`)
    expect(pageBox).toHaveAttribute('aria-checked', 'mixed')
    await user.click(pageBox)
    expect(run()).toHaveTextContent(runLabel(2, 1))
    await user.click(pageBox)
    expect(run()).toBeDisabled()
    expect(run()).toHaveTextContent(t('search.replace.runIdle'))
  })

  it('writes the ticked blocks after the confirmation, and Undo puts them back', async () => {
    stubVault()
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))
    await user.click(screen.getByTestId('search-replace-row-B1'))

    await user.click(run())
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(
        t('search.replace.confirmTitle', {
          blocks: t('search.replace.blocks', { count: 2 }),
          pages: t('search.replace.pages', { count: 1 }),
        }),
      ),
    ).toBeInTheDocument()
    expect(callsOf('edit_blocks_batch')).toEqual([])
    await user.click(within(dialog).getByTestId('search-replace-confirm'))

    await waitFor(() => expect(contentOf('A1')).toBe('one pin here'))
    expect(contentOf('A2')).toBe('two pin, pin')
    expect(contentOf('B1')).toBe('three needle')
    expect(contentOf('B2')).toBe(`see [[${PAGE_A}|needle link]]`)
    expect(contentOf(PAGE_B)).toBe('needle notes')
    // Each edit carries the content the search returned.
    expect(callsOf('edit_blocks_batch')).toEqual([
      {
        edits: [
          { blockId: 'A1', expected: 'one needle here', toText: 'one pin here' },
          { blockId: 'A2', expected: 'two Needle, needle', toText: 'two pin, pin' },
        ],
      },
    ])
    const done = t('search.replace.done', {
      blocks: t('search.replace.blocks', { count: 2 }),
      pages: t('search.replace.pages', { count: 1 }),
    })
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1))
    const [message, options] = vi.mocked(toast.success).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ]
    expect(message).toBe(done)
    expect(options.action.label).toBe(t('action.undo'))
    // The search ran again: only the block left unticked still matches.
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((r) => r.getAttribute('data-testid'))).toEqual([
        'search-replace-row-B1',
      ]),
    )

    options.action.onClick()
    await waitFor(() => expect(contentOf('A1')).toBe('one needle here'))
    expect(contentOf('A2')).toBe('two Needle, needle')
    expect(callsOf('undo_ops')).toEqual([
      {
        ops: [
          { device_id: 'DEV', seq: 1 },
          { device_id: 'DEV', seq: 2 },
        ],
      },
    ])
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
  })

  it('says how many blocks changed since the search and were left alone', async () => {
    stubVault()
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))
    // Another device edits B1 after the preview read it.
    const b1 = vault.find((r) => r.id === 'B1')
    if (b1) b1.content = 'three needle, edited elsewhere'

    await user.click(run())
    await user.click(await screen.findByTestId('search-replace-confirm'))

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
      `${t('search.replace.done', {
        blocks: t('search.replace.blocks', { count: 2 }),
        pages: t('search.replace.pages', { count: 1 }),
      })} · ${t('search.replace.changedSince', { count: 1 })}`,
    )
    expect(contentOf('B1')).toBe('three needle, edited elsewhere')
    expect(contentOf('A1')).toBe('one pin here')
  })

  it('saves typing still pending in an editor first, and leaves that block alone', async () => {
    stubVault()
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))
    // An editor on B1 holds typing its debounce has not saved yet.
    const unregister = registerActiveDraftFlush('B1', () => {
      const b1 = vault.find((r) => r.id === 'B1')
      if (b1) b1.content = 'three needle, typed since'
      return Promise.resolve()
    })
    try {
      await user.click(run())
      await user.click(await screen.findByTestId('search-replace-confirm'))

      await waitFor(() => expect(contentOf('A1')).toBe('one pin here'))
      expect(contentOf('B1')).toBe('three needle, typed since')
    } finally {
      unregister()
    }
  })

  it('reports a refused write and changes nothing', async () => {
    stubVault({
      edit_blocks_batch: () => Promise.reject({ kind: 'database', message: 'disk full' }),
    })
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))

    await user.click(run())
    await user.click(await screen.findByTestId('search-replace-confirm'))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('search.replace.failed')),
    )
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(contentOf('A1')).toBe('one needle here')
    // The preview stands, ready to run again.
    expect(run()).toHaveTextContent(runLabel(3, 2))
  })

  it('refuses a search with more matching blocks than one run writes', async () => {
    vault = Array.from({ length: MAX_BATCH_BLOCK_IDS + 1 }, (_, i) =>
      row(`N${i}`, `needle ${i}`, PAGE_A),
    )
    stubVault()
    const { run } = await openReplace('needle', 'pin')

    await waitFor(() =>
      expect(screen.getByTestId('search-replace-status')).toHaveTextContent(
        t('search.replace.tooMany'),
      ),
    )
    expect(run()).toBeDisabled()
    expect(callsOf('edit_blocks_batch')).toEqual([])
  })

  it('loads every page of candidates before it offers the replace', async () => {
    stubVault({
      search_blocks: (args) => {
        const { cursor } = args as { cursor: string | null }
        return cursor === null
          ? { items: vault.slice(0, 1), next_cursor: 'c1', has_more: true, total_count: null }
          : { items: vault.slice(2, 3), next_cursor: null, has_more: false, total_count: null }
      },
    })
    const { run } = await openReplace('needle', 'pin')

    await waitFor(() => expect(run()).toHaveTextContent(runLabel(2, 2)))
    expect(screen.queryByRole('button', { name: t('search.loadMoreButton') })).toBeNull()
  })

  it('does not replace in regex mode or under three characters', async () => {
    stubVault()
    const { user, run } = await openReplace('ne', 'pin')
    expect(screen.getByTestId('search-replace-status')).toHaveTextContent(
      t('search.replace.tooShort'),
    )
    expect(run()).toBeDisabled()

    fireEvent.change(screen.getByRole('combobox', { name: t('search.searchLabel') }), {
      target: { value: 'needle' },
    })
    await user.click(screen.getByTestId('search-toggle-regex'))
    expect(screen.getByTestId('search-replace-status')).toHaveTextContent(
      t('search.replace.noRegex'),
    )
    expect(run()).toBeDisabled()
  })

  it('Ctrl+H in the panel opens and closes the replace row', async () => {
    stubVault()
    const user = userEvent.setup()
    render(<SearchPanel />)
    const input = screen.getByRole('combobox', { name: t('search.searchLabel') })
    input.focus()

    await user.keyboard('{Control>}h{/Control}')
    expect(screen.getByTestId('search-replace-bar')).toBeInTheDocument()
    expect(screen.getByTestId('search-replace-toggle')).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Control>}h{/Control}')
    expect(screen.queryByTestId('search-replace-bar')).toBeNull()
    expect(input).toHaveFocus()
  })

  it('has no a11y violations with the preview and with the confirmation open', async () => {
    stubVault()
    const { user, run } = await openReplace('needle', 'pin')
    await waitFor(() => expect(run()).toHaveTextContent(runLabel(3, 2)))
    await waitFor(async () => expect(await axe(document.body)).toHaveNoViolations())

    await user.click(run())
    await screen.findByRole('alertdialog')
    await waitFor(async () => expect(await axe(document.body)).toHaveNoViolations())
  })
})
