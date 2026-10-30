/**
 * The switch between page mode and Edit as Markdown (#5691), as GitLab's "Switch to plain text
 * editing" and back: page mode's footer opens the buffer once its text is saved, and the buffer's
 * link opens page mode on the page as it is now, the header read again and the focus not sent to
 * the kebab. The journal's day page has no Markdown mode, so no link. Through the real page-mode
 * editor over the mock backend; the buffer is stubbed.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { type Ref, useEffect } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import { DayPageEditor } from '@/components/journal/DayPageEditor'
import { PageEditor } from '@/components/pages/PageEditor'
import { caret, markdownOf, type } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { editorIn, SCOPE, seedPage } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { blockerMessage, PAGE_MODE_BLOCK_CAP } from '@/editor/page-mode/page-mode-fit'
import type { BlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { PREFERENCES, writePreference } from '@/lib/preferences'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useBlockStore } from '@/stores/blocks'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

let touch = false
vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => touch }))

vi.mock('@/components/editor/BlockTree', () => ({
  BlockTree: () => <div data-testid="block-tree" />,
}))

interface HeaderProps {
  onEditSource?: () => void
  kebabRef?: Ref<HTMLButtonElement>
}
let header: HeaderProps = {}
let headerMounts = 0
let kebabFocuses = 0
vi.mock('@/components/pages/PageHeader', () => ({
  PageHeader: (props: HeaderProps) => {
    header = props
    useEffect(() => {
      headerMounts += 1
    }, [])
    return (
      <button
        type="button"
        ref={props.kebabRef}
        onFocus={() => {
          kebabFocuses += 1
        }}
      >
        Page actions
      </button>
    )
  },
}))

interface SourceProps {
  onClose: () => void
  onSwitchToPage?: () => void
  pageModeBlocked?: string | null
}
let source: SourceProps | null = null
vi.mock('@/components/pages/PageSourceEditor', () => ({
  PageSourceEditor: (props: SourceProps) => {
    source = props
    return <div data-testid="page-source-mode" />
  },
}))
vi.mock('@/components/backlinks/LinkedReferences', () => ({ LinkedReferences: () => null }))
vi.mock('@/components/backlinks/UnlinkedReferences', () => ({ UnlinkedReferences: () => null }))
vi.mock('@/components/pages/PagesTreeSection', () => ({ PagesTreeSection: () => null }))

/** The page's live blocks' text in the backend, in order. */
function backendTexts(pageId: string): string[] {
  const { blocks } = dispatch('load_page_subtree', { rootBlockId: pageId, scope: SCOPE }) as {
    blocks: BlockRow[]
  }
  return blocks
    .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((block) => block.content ?? '')
}

function shownTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(markdownOf(node)))
  return out
}

function footerLink(): HTMLElement | null {
  return screen.queryByRole('button', { name: t('pageSource.edit') })
}

/** Back from the buffer, as its link does once its save, if any, has landed. */
async function switchToPage(container: HTMLElement): Promise<void> {
  await act(async () => source?.onSwitchToPage?.())
  await waitFor(() =>
    expect(container.querySelector('[data-testid="page-source-mode"]')).toBe(null),
  )
}

beforeEach(() => {
  touch = false
  source = null
  headerMounts = 0
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

describe('page mode footer: Edit as Markdown', () => {
  it('opens the buffer once the text typed is saved, with no a11y violations', async () => {
    writePreference(PREFERENCES.editMode, 'page')
    const { pageId } = seedPage(['first', 'second'], 'Footer to Markdown')
    const { container } = render(<PageEditor pageId={pageId} title="Footer to Markdown" />)
    const editor = await editorIn(container)
    act(() => {
      caret(editor, 1, 'second'.length)
      type(editor, '!')
    })
    const link = footerLink()
    expect(link).not.toBeNull()
    expect(link?.closest('div')).toHaveTextContent(t('pageMode.footerHint'))
    expect(await axe(container)).toHaveNoViolations()

    fireEvent.click(link as HTMLElement)

    await screen.findByTestId('page-source-mode')
    expect(backendTexts(pageId)).toEqual(['first', 'second!'])
  })

  it('is not on the journal’s day page, which has no Markdown mode', async () => {
    writePreference(PREFERENCES.editMode, 'page')
    const { pageId } = seedPage(['today'], '2026-10-28')
    const { container } = render(
      <PageBlockStoreProvider pageId={pageId}>
        <DayPageEditor pageId={pageId} onAddBlock={() => {}} />
      </PageBlockStoreProvider>,
    )
    await editorIn(container)

    expect(screen.getByText(t('pageMode.footerHint'))).toBeInTheDocument()
    expect(footerLink()).toBeNull()
  })
})

describe('Edit as Markdown link back to page mode', () => {
  it('opens page mode on the page as saved, the header read again and the caret in it, not on the kebab', async () => {
    writePreference(PREFERENCES.editMode, 'page')
    const { pageId, ids } = seedPage(['first', 'second'], 'Markdown to page')
    const { container } = render(<PageEditor pageId={pageId} title="Markdown to page" />)
    const before = await editorIn(container)
    fireEvent.click(footerLink() as HTMLElement)
    await screen.findByTestId('page-source-mode')
    const mounts = headerMounts
    kebabFocuses = 0
    // The buffer's save, as `apply_page_source` writes it.
    dispatch('edit_block', { blockId: ids[1], toText: 'second, saved in Markdown' })

    await switchToPage(container)

    const editor = await editorIn(container)
    expect(editor).not.toBe(before)
    expect(shownTexts(editor)).toEqual(['first', 'second, saved in Markdown'])
    expect(headerMounts).toBe(mounts + 1)
    expect(document.activeElement).toBe(editor.view.dom)
    expect(kebabFocuses).toBe(0)
  })

  it('opens page mode when the buffer was opened from block mode', async () => {
    writePreference(PREFERENCES.editMode, 'blocks')
    const { pageId } = seedPage(['first'], 'Blocks to Markdown to page')
    const { container } = render(<PageEditor pageId={pageId} title="Blocks to Markdown to page" />)
    await screen.findByTestId('block-tree')
    // Offered once `get_block` says the page is not a tag's; `?.()` before then does nothing.
    await waitFor(() => expect(header.onEditSource).toBeDefined())
    await act(async () => header.onEditSource?.())
    await screen.findByTestId('page-source-mode')
    expect(source?.pageModeBlocked).toBe(null)

    await switchToPage(container)

    expect(screen.queryByTestId('block-tree')).toBe(null)
    expect(shownTexts(await editorIn(container))).toEqual(['first'])
  })

  it('says why the page stays in Blocks when the buffer’s save took it over the cap', async () => {
    writePreference(PREFERENCES.editMode, 'blocks')
    const { pageId } = seedPage(['first'], 'Markdown over the cap')
    const { container } = render(<PageEditor pageId={pageId} title="Markdown over the cap" />)
    await screen.findByTestId('block-tree')
    await waitFor(() => expect(header.onEditSource).toBeDefined())
    await act(async () => header.onEditSource?.())
    await screen.findByTestId('page-source-mode')
    // The buffer's save, as `apply_page_source` writes it.
    dispatch('create_blocks_batch', {
      specs: Array.from({ length: PAGE_MODE_BLOCK_CAP }, (_, i) => ({
        blockType: 'content',
        content: `block ${i}`,
        parentId: pageId,
        position: null,
      })),
    })

    await switchToPage(container)

    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
      blockerMessage({ kind: 'overCap', count: PAGE_MODE_BLOCK_CAP + 1 }),
    )
    expect(screen.getByTestId('block-tree')).toBeInTheDocument()
  })

  it('is offered on touch too', async () => {
    touch = true
    const { pageId } = seedPage(['first'], 'Touch Markdown')
    render(<PageEditor pageId={pageId} title="Touch Markdown" />)
    await screen.findByTestId('block-tree')
    await waitFor(() => expect(header.onEditSource).toBeDefined())
    await act(async () => header.onEditSource?.())
    await screen.findByTestId('page-source-mode')

    expect(source?.onSwitchToPage).toBeTypeOf('function')
  })

  it('carries why page mode cannot show a page over its cap', async () => {
    const count = PAGE_MODE_BLOCK_CAP + 1
    const texts = Array.from({ length: count }, (_, i) => `block ${i}`)
    const { pageId } = seedPage(texts, 'Long Markdown')
    render(<PageEditor pageId={pageId} title="Long Markdown" />)
    await screen.findByTestId('block-tree')
    await waitFor(() => expect(header.onEditSource).toBeDefined())
    await act(async () => getPageStore(pageId)?.getState().load())
    await act(async () => header.onEditSource?.())
    await screen.findByTestId('page-source-mode')

    expect(source?.onSwitchToPage).toBeTypeOf('function')
    expect(source?.pageModeBlocked).toBe(blockerMessage({ kind: 'overCap', count }))
  })
})
