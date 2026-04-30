/**
 * Tests for PageLink component.
 *
 * Covers: rendering, navigation on click, stopPropagation, custom children,
 * custom className, and a11y audit.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useNavigationStore } from '../../stores/navigation'
import { selectPageStack, useTabsStore } from '../../stores/tabs'
import { PageLink } from '../PageLink'

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
})

describe('PageLink', () => {
  it('renders the title as button text', () => {
    render(<PageLink pageId="P1" title="My Page" />)
    expect(screen.getByRole('link', { name: 'My Page' })).toBeInTheDocument()
  })

  it('renders custom children instead of title', () => {
    render(
      <PageLink pageId="P1" title="My Page">
        <span>Custom Label</span>
      </PageLink>,
    )
    expect(screen.getByText('Custom Label')).toBeInTheDocument()
    expect(screen.queryByText('My Page')).not.toBeInTheDocument()
  })

  it('navigates to page on click', async () => {
    const user = userEvent.setup()
    render(<PageLink pageId="P1" title="My Page" />)

    await user.click(screen.getByRole('link', { name: 'My Page' }))

    const state = useNavigationStore.getState()
    const pageStack = selectPageStack(useTabsStore.getState())
    expect(state.currentView).toBe('page-editor')
    expect(pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
  })

  it('navigates to page on Enter key', async () => {
    const user = userEvent.setup()
    render(<PageLink pageId="P1" title="My Page" />)

    screen.getByRole('link', { name: 'My Page' }).focus()
    await user.keyboard('{Enter}')

    const state = useNavigationStore.getState()
    const pageStack = selectPageStack(useTabsStore.getState())
    expect(state.currentView).toBe('page-editor')
    expect(pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
  })

  it('navigates to page on Space key', async () => {
    const user = userEvent.setup()
    render(<PageLink pageId="P1" title="My Page" />)

    screen.getByRole('link', { name: 'My Page' }).focus()
    await user.keyboard(' ')

    const state = useNavigationStore.getState()
    const pageStack = selectPageStack(useTabsStore.getState())
    expect(state.currentView).toBe('page-editor')
    expect(pageStack).toEqual([{ pageId: 'P1', title: 'My Page' }])
  })

  it('stops event propagation on click', async () => {
    const parentClick = vi.fn()
    const user = userEvent.setup()
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test wrapper to verify stopPropagation
      <div onClick={parentClick} onKeyDown={() => {}}>
        <PageLink pageId="P1" title="My Page" />
      </div>,
    )

    await user.click(screen.getByRole('link', { name: 'My Page' }))

    expect(parentClick).not.toHaveBeenCalled()
  })

  it('applies custom className', () => {
    render(<PageLink pageId="P1" title="My Page" className="text-xs" />)
    const link = screen.getByRole('link', { name: 'My Page' })
    expect(link).toHaveClass('text-xs')
    expect(link).toHaveClass('hover:underline')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PageLink pageId="P1" title="My Page" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
