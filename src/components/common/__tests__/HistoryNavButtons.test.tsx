import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { HistoryNavButtons } from '@/components/common/HistoryNavButtons'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

async function visit(view: 'settings' | 'tags'): Promise<void> {
  await act(async () => {
    useNavigationStore.getState().setView(view)
    await Promise.resolve()
  })
}

beforeEach(async () => {
  useSpaceStore.setState({ currentSpaceId: null })
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

  it('has no a11y violations', async () => {
    const { container } = render(<HistoryNavButtons />)
    await visit('settings')

    expect(await axe(container)).toHaveNoViolations()
  })
})
