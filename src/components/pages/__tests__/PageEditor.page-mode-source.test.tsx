/**
 * PageEditor between page mode and Edit as Markdown (#5691), through the real page-mode editor
 * over the mock backend: closing the buffer unchanged brings page mode back on the page as saved,
 * and neither that nor coming back from another page puts the caret where page mode first opened.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { Ref } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import { PageEditor } from '@/components/pages/PageEditor'
import { caret, markdownOf, press, type } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { editorIn, SCOPE, seedPage } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { blockIdOf } from '@/editor/token-ids'
import type { BlockRow } from '@/lib/bindings'
import { PREFERENCES, writePreference } from '@/lib/preferences'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useBlockStore } from '@/stores/blocks'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/editor/BlockTree', () => ({
  BlockTree: () => <div data-testid="block-tree" />,
}))

interface HeaderProps {
  onEditSource?: () => void
  onEditModeChange?: (mode: 'blocks' | 'page') => void
  kebabRef?: Ref<HTMLButtonElement>
}
let header: HeaderProps = {}
vi.mock('@/components/pages/PageHeader', () => ({
  PageHeader: (props: HeaderProps) => {
    header = props
    return (
      <button type="button" ref={props.kebabRef}>
        Page actions
      </button>
    )
  },
}))

// The buffer's Cancel, and its Save with nothing changed, both close it without a write.
vi.mock('@/components/pages/PageSourceEditor', () => ({
  PageSourceEditor: (props: { onClose: () => void }) => (
    <button type="button" data-testid="page-source-mode" onClick={props.onClose}>
      Cancel
    </button>
  ),
}))
vi.mock('@/components/backlinks/LinkedReferences', () => ({ LinkedReferences: () => null }))
vi.mock('@/components/backlinks/UnlinkedReferences', () => ({ UnlinkedReferences: () => null }))
vi.mock('@/components/pages/PagesTreeSection', () => ({ PagesTreeSection: () => null }))

/** The page's live blocks in the backend: id and text, in order. */
function backendPage(pageId: string): Array<[string, string]> {
  const { blocks } = dispatch('load_page_subtree', { rootBlockId: pageId, scope: SCOPE }) as {
    blocks: BlockRow[]
  }
  return blocks
    .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((block) => [block.id, block.content ?? ''])
}

/** The document as shown: each block's id and text. */
function shownPage(editor: Editor): Array<[string, string]> {
  const out: Array<[string, string]> = []
  editor.state.doc.forEach((node) => out.push([blockIdOf(node) ?? '', markdownOf(node)]))
  return out
}

/** Open Edit as Markdown, as the kebab does, once page mode's save let it. */
async function openSource(): Promise<void> {
  await act(async () => header.onEditSource?.())
  await screen.findByTestId('page-source-mode')
}

/** Close the buffer unchanged, and wait for page mode's new editor. */
async function closeSource(container: HTMLElement, was: Editor): Promise<Editor> {
  fireEvent.click(screen.getByTestId('page-source-mode'))
  await waitFor(() =>
    expect(container.querySelector('[data-testid="page-source-mode"]')).toBe(null),
  )
  const editor = await editorIn(container)
  expect(editor).not.toBe(was)
  return editor
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
  useBlockStore.setState({ focusedBlockId: null })
  vi.mocked(invoke).mockImplementation(async (cmd, args) => dispatch(cmd, args))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PageEditor: page mode opened again, after Edit as Markdown or another page', () => {
  it('shows what was typed before, and the next edit keeps it', async () => {
    writePreference(PREFERENCES.editMode, 'page')
    const { pageId, ids } = seedPage(['first', 'second'], 'Typed before Markdown')
    const { container } = render(<PageEditor pageId={pageId} title="Typed before Markdown" />)
    const before = await editorIn(container)
    act(() => {
      caret(before, 1, 'second'.length)
      type(before, '!')
    })

    await openSource()
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first'],
      [ids[1], 'second!'],
    ])
    const editor = await closeSource(container, before)

    expect(shownPage(editor)).toEqual([
      [ids[0], 'first'],
      [ids[1], 'second!'],
    ])
    act(() => {
      caret(editor, 1, 'second!'.length)
      type(editor, '?')
    })
    await openSource()
    expect(backendPage(pageId)).toEqual([
      [ids[0], 'first'],
      [ids[1], 'second!?'],
    ])
  })

  it('shows a block made and a block joined away before, and saves neither back', async () => {
    writePreference(PREFERENCES.editMode, 'page')
    const { pageId, ids } = seedPage(['first', 'second', 'third'], 'Blocks before Markdown')
    const { container } = render(<PageEditor pageId={pageId} title="Blocks before Markdown" />)
    const before = await editorIn(container)
    act(() => {
      caret(before, 2, 'third'.length)
    })
    press(before, 'Enter')
    act(() => {
      type(before, 'fourth')
      caret(before, 1, 0)
    })
    press(before, 'Backspace')

    await openSource()
    const saved = backendPage(pageId)
    expect(saved.map(([, text]) => text)).toEqual(['firstsecond', 'third', 'fourth'])
    expect(saved.slice(0, 2).map(([id]) => id)).toEqual([ids[0], ids[2]])
    const editor = await closeSource(container, before)

    expect(shownPage(editor)).toEqual(saved)
    act(() => {
      caret(editor, 0, 0)
      type(editor, '>')
    })
    await openSource()
    expect(backendPage(pageId)).toEqual([[ids[0], '>firstsecond'], ...saved.slice(1)])
  })

  it('leaves the focus on the kebab, not on the block page mode first opened on', async () => {
    writePreference(PREFERENCES.editMode, 'blocks')
    const { pageId, ids } = seedPage(['first', 'second', 'third'], 'Caret before Markdown')
    const { container } = render(<PageEditor pageId={pageId} title="Caret before Markdown" />)
    await screen.findByTestId('block-tree')
    // Blocks to Page while block mode edits the second block: page mode opens there.
    useBlockStore.setState({ focusedBlockId: ids[1] as string })
    await act(async () => header.onEditModeChange?.('page'))
    const before = await editorIn(container)
    await waitFor(() => expect(before.view.hasFocus()).toBe(true))
    expect(blockIdOf(before.state.selection.$head.node(1))).toBe(ids[1])
    // The user goes on in the third block, then picks Edit as Markdown from the kebab.
    act(() => {
      caret(before, 2, 2)
    })
    act(() => {
      screen.getByRole('button', { name: 'Page actions' }).focus()
    })

    await openSource()
    const editor = await closeSource(container, before)

    expect(editor.view.hasFocus()).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Page actions' }))
  })

  it('opens on no block when the page is shown again, after another page', async () => {
    writePreference(PREFERENCES.editMode, 'blocks')
    const { pageId, ids } = seedPage(['first', 'second'], 'Left and back')
    const other = seedPage(['elsewhere'], 'Another page')
    const { container, rerender } = render(<PageEditor pageId={pageId} title="Left and back" />)
    await screen.findByTestId('block-tree')
    useBlockStore.setState({ focusedBlockId: ids[1] as string })
    await act(async () => header.onEditModeChange?.('page'))
    const before = await editorIn(container)
    await waitFor(() => expect(before.view.hasFocus()).toBe(true))

    // The switch was for that page: this one opens in blocks, as the setting says.
    rerender(<PageEditor pageId={other.pageId} title="Another page" />)
    await screen.findByTestId('block-tree')
    act(() => {
      screen.getByRole('button', { name: 'Page actions' }).focus()
    })
    rerender(<PageEditor pageId={pageId} title="Left and back" />)
    const back = await editorIn(container)
    expect(back).not.toBe(before)

    expect(back.view.hasFocus()).toBe(false)
  })
})
