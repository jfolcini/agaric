/**
 * #6755 — the notes on a tag's page, against the mock backend: the paired
 * page's block tree when the tag has a page, and "Add notes", which makes the
 * page through the tag, when it has none.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { TagNotesSection } from '@/components/pages/TagNotesSection'
import type { BlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/components/editor/BlockTree', () => ({
  BlockTree: (props: { parentId?: string; autoCreateFirstBlock?: boolean }) => (
    <div
      data-testid="block-tree"
      data-parent-id={props.parentId}
      data-auto-create={String(props.autoCreateFirstBlock)}
    />
  ),
}))

const mockedInvoke = vi.mocked(invoke)
const WORK = SEED_IDS.TAG_WORK
const addNotes = () => screen.findByRole('button', { name: t('tagNotes.add') })

/** The live pages titled `title`, read back from the mock's store. */
function pagesTitled(title: string): string[] {
  return [...blocks.values()]
    .filter((b) => b['block_type'] === 'page' && !b['deleted_at'] && b['content'] === title)
    .map((b) => b['id'] as string)
}

function rejecting(command: string) {
  return async (cmd: string, args?: InvokeArgs) => {
    if (cmd === command) throw new Error('boom')
    return dispatch(cmd, args)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  seedBlocks()
  const spaceId = blocks.get(WORK)?.['space_id'] as string
  useSpaceStore.setState({
    currentSpaceId: spaceId,
    availableSpaces: [{ id: spaceId, name: 'Space', accent_color: null }],
  })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

describe('TagNotesSection', () => {
  it('offers to add notes on a tag without a page, and mounts no tree', async () => {
    render(<TagNotesSection tagId={WORK} tagName="work" />)

    expect(await addNotes()).toBeEnabled()
    expect(screen.getByText(t('tagNotes.empty'))).toBeInTheDocument()
    expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
    expect(pagesTitled('Tag/work')).toEqual([])
  })

  it('makes the page through the tag and mounts its tree, seeding a first block', async () => {
    const user = userEvent.setup()
    render(<TagNotesSection tagId={WORK} tagName="work" />)

    await user.click(await addNotes())

    const tree = await screen.findByTestId('block-tree')
    const [pageId] = pagesTitled('Tag/work')
    expect(pagesTitled('Tag/work')).toHaveLength(1)
    expect(tree).toHaveAttribute('data-parent-id', pageId)
    expect(tree).toHaveAttribute('data-auto-create', 'true')
    expect(screen.queryByRole('button', { name: t('tagNotes.add') })).not.toBeInTheDocument()
  })

  it("mounts the tree of the tag's page when it has one", async () => {
    const page = (await dispatch('create_tag_page', { tagId: WORK })) as BlockRow

    render(<TagNotesSection tagId={WORK} tagName="work" />)

    expect(await screen.findByTestId('block-tree')).toHaveAttribute('data-parent-id', page.id)
    expect(screen.queryByRole('button', { name: t('tagNotes.add') })).not.toBeInTheDocument()
  })

  it('follows the tag to its renamed page', async () => {
    const page = (await dispatch('create_tag_page', { tagId: WORK })) as BlockRow
    const { rerender } = render(<TagNotesSection tagId={WORK} tagName="work" />)
    expect(await screen.findByTestId('block-tree')).toBeInTheDocument()

    await dispatch('edit_block', { blockId: WORK, toText: 'job' })
    rerender(<TagNotesSection tagId={WORK} tagName="job" />)

    await waitFor(() => expect(blocks.get(page.id)?.['content']).toBe('Tag/job'))
    expect(await screen.findByTestId('block-tree')).toHaveAttribute('data-parent-id', page.id)
  })

  // A sync, an undo or another surface can make the page while this one shows.
  it('reads the page again when the names are invalidated', async () => {
    render(<TagNotesSection tagId={WORK} tagName="work" />)
    expect(await addNotes()).toBeInTheDocument()

    const page = (await dispatch('create_tag_page', { tagId: WORK })) as BlockRow
    invalidateNameCaches()

    expect(await screen.findByTestId('block-tree')).toHaveAttribute('data-parent-id', page.id)
  })

  it('reports a failed create and keeps the offer', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(rejecting('create_tag_page'))
    render(<TagNotesSection tagId={WORK} tagName="work" />)

    await user.click(await addNotes())

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('tagNotes.createFailed')))
    expect(await addNotes()).toBeEnabled()
    expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
    expect(pagesTitled('Tag/work')).toEqual([])
  })

  it('reports a failed lookup of the page', async () => {
    mockedInvoke.mockImplementation(rejecting('resolve_page_title'))
    render(<TagNotesSection tagId={WORK} tagName="work" />)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('tagNotes.loadFailed')))
  })

  it('has no a11y violations with and without a page', async () => {
    const user = userEvent.setup()
    const { container } = render(<TagNotesSection tagId={WORK} tagName="work" />)
    await addNotes()
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations())

    await user.click(await addNotes())
    await screen.findByTestId('block-tree')
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations())
  })
})
