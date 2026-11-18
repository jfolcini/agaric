/**
 * #6755 — on a page titled `Tag/<tag>`, the link to its tag, against the mock
 * backend: shown when the space has that tag in any case, and opening it.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { TagPageLink } from '@/components/pages/TagPageLink'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

const mockedInvoke = vi.mocked(invoke)
const WORK = SEED_IDS.TAG_WORK
const linkName = t('tagNotes.openTag', { name: 'work' })

/** Resolves once the tag lookup has answered. */
async function lookupSettled(): Promise<void> {
  await waitFor(() =>
    expect(
      queryClient.getQueryState(['tagOfPage', useSpaceStore.getState().currentSpaceId, 'nosuch'])
        ?.status,
    ).toBe('success'),
  )
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

describe('TagPageLink', () => {
  it('links the page to its tag, read in any case, and opens the tag', async () => {
    const user = userEvent.setup()
    render(<TagPageLink pageTitle="tag/WORK" />)

    await user.click(await screen.findByRole('button', { name: linkName }))

    expect(selectPageStack(useTabsStore.getState()).at(-1)).toEqual({ pageId: WORK, title: 'work' })
  })

  it('shows nothing on a page whose tag does not exist', async () => {
    const { container } = render(<TagPageLink pageTitle="Tag/nosuch" />)

    await lookupSettled()
    expect(container).toBeEmptyDOMElement()
  })

  // The tag list is a cache the backend rebuilds after a rename commits.
  it('looks the tag up again when the names are invalidated', async () => {
    render(<TagPageLink pageTitle="Tag/nosuch" />)
    await lookupSettled()

    await dispatch('edit_block', { blockId: WORK, toText: 'nosuch' })
    invalidateNameCaches()

    expect(
      await screen.findByRole('button', { name: t('tagNotes.openTag', { name: 'nosuch' }) }),
    ).toBeInTheDocument()
  })

  it('shows nothing, and logs, when the lookup fails', async () => {
    const warn = vi.spyOn(logger, 'warn')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'list_all_tags_in_space') throw new Error('boom')
      return dispatch(cmd, args)
    })
    const { container } = render(<TagPageLink pageTitle="Tag/nosuch" />)

    await lookupSettled()
    expect(container).toBeEmptyDOMElement()
    expect(warn).toHaveBeenCalledWith(
      'TagPageLink',
      'Failed to look up the tag of a page',
      { pageTitle: 'Tag/nosuch' },
      expect.any(Error),
    )
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TagPageLink pageTitle="Tag/work" />)
    await screen.findByRole('button', { name: linkName })

    await waitFor(async () => expect(await axe(container)).toHaveNoViolations())
  })
})
