import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { HistoryNavButtons } from '@/components/common/HistoryNavButtons'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

async function visit(view: 'settings' | 'tags'): Promise<void> {
  await act(async () => {
    useNavigationStore.getState().setView(view)
    await Promise.resolve()
  })
}

async function openPage(pageId: string): Promise<void> {
  await act(async () => {
    useTabsStore.getState().navigateToPage(pageId, pageId)
    await Promise.resolve()
  })
}

function deletePage(pageId: string): void {
  act(() => {
    useResolveStore.getState().set(pageId, pageId, true)
  })
}

beforeEach(async () => {
  useSpaceStore.setState({ currentSpaceId: null })
  useResolveStore.setState({ cache: new Map() })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    tabsBySpace: {},
    activeTabIndexBySpace: {},
  })
  useNavigationStore.setState({
    currentView: 'journal',
    currentViewBySpace: {},
    selectedBlockId: null,
    navHistoryBySpace: {},
  })
  await Promise.resolve()
})

describe('HistoryNavButtons', () => {
  it('starts with nowhere to go either way', () => {
    render(<HistoryNavButtons />)

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  })

  it('Back and Forward step through the visited views', async () => {
    const user = userEvent.setup()
    render(<HistoryNavButtons />)
    await visit('settings')
    await visit('tags')

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(useNavigationStore.getState().currentView).toBe('settings')
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(useNavigationStore.getState().currentView).toBe('journal')
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Forward' }))
    expect(useNavigationStore.getState().currentView).toBe('settings')
  })

  // Back / Forward step over deleted pages, so an arrow whose every entry
  // that way is one has nowhere to go.
  it('disables Back when every earlier entry is a deleted page', async () => {
    await openPage('P1')
    await act(async () => {
      useNavigationStore.setState({ navHistoryBySpace: {} })
      await Promise.resolve()
    })
    await visit('settings')
    render(<HistoryNavButtons />)
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()

    deletePage('P1')

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('disables Forward when every later entry is a deleted page', async () => {
    const user = userEvent.setup()
    render(<HistoryNavButtons />)
    await openPage('P1')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled()

    deletePage('P1')

    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<HistoryNavButtons />)
    await visit('settings')

    expect(await axe(container)).toHaveNoViolations()
  })
})
