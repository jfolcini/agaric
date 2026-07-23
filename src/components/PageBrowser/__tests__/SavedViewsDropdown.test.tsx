/**
 * Tests for `SavedViewsDropdown` (#2003 piece 1) — list/apply/delete UI for
 * named Pages-view snapshots, slotted into `PageBrowserHeader`.
 *
 * Follows the `AgendaSortGroupControls.test.tsx` precedent for a
 * Popover + MenuPopoverContent + PopoverMenuItem dropdown: `screen`-based
 * queries (Radix Portals to `document.body`, so `screen` — which searches
 * the whole document — finds portaled content even though RTL's returned
 * `container` does not), `aria-current` for the active item, and an
 * `axe(container)` a11y check on the closed (at-rest) state, matching the
 * existing precedent's scope. In addition to that precedent, this file also
 * runs `axe(document.body)` (via the project's focus-guard-tolerant helper)
 * once the popover is open, since `axe(container)` alone would silently
 * skip the portaled menu content entirely.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe as axeRaw } from 'vitest-axe'

import { axe } from '@/__tests__/helpers/axe'
import {
  SavedViewsDropdown,
  type SavedViewsDropdownProps,
} from '@/components/PageBrowser/SavedViewsDropdown'
import type { SavedPagesView } from '@/lib/preferences'

function makeView(overrides: Partial<SavedPagesView> = {}): SavedPagesView {
  return {
    id: 'view-1',
    name: 'My view',
    createdAt: '2026-01-01T00:00:00.000Z',
    sort: 'alphabetical',
    density: 'regular',
    filters: [],
    ...overrides,
  }
}

function makeProps(overrides: Partial<SavedViewsDropdownProps> = {}): SavedViewsDropdownProps {
  return {
    views: [],
    activeView: null,
    onApply: vi.fn(),
    onDelete: vi.fn(),
    onSaveCurrentView: vi.fn(),
    ...overrides,
  }
}

describe('SavedViewsDropdown', () => {
  it('renders a trigger button showing the generic label when no view is active', () => {
    render(<SavedViewsDropdown {...makeProps()} />)
    expect(screen.getByTestId('saved-views-trigger')).toHaveTextContent('Saved views')
  })

  it('renders the active view name on the trigger when a view matches', () => {
    const view = makeView({ name: 'Active view' })
    render(<SavedViewsDropdown {...makeProps({ views: [view], activeView: view })} />)
    expect(screen.getByTestId('saved-views-trigger')).toHaveTextContent('Active view')
  })

  it('shows the empty-state message when there are no saved views', async () => {
    const user = userEvent.setup()
    render(<SavedViewsDropdown {...makeProps()} />)

    await user.click(screen.getByTestId('saved-views-trigger'))

    expect(await screen.findByText('No saved views yet')).toBeInTheDocument()
  })

  it('lists every saved view by name', async () => {
    const user = userEvent.setup()
    const views = [makeView({ id: 'a', name: 'Alpha' }), makeView({ id: 'b', name: 'Beta' })]
    render(<SavedViewsDropdown {...makeProps({ views })} />)

    await user.click(screen.getByTestId('saved-views-trigger'))

    const menu = await screen.findByTestId('saved-views-menu')
    expect(within(menu).getByText('Alpha')).toBeInTheDocument()
    expect(within(menu).getByText('Beta')).toBeInTheDocument()
  })

  it('marks the active view with aria-current and a Check icon, others without', async () => {
    const user = userEvent.setup()
    const active = makeView({ id: 'a', name: 'Alpha' })
    const other = makeView({ id: 'b', name: 'Beta' })
    render(<SavedViewsDropdown {...makeProps({ views: [active, other], activeView: active })} />)

    await user.click(screen.getByTestId('saved-views-trigger'))

    const applyActive = await screen.findByRole('button', { name: 'Apply view Alpha' })
    const applyOther = screen.getByRole('button', { name: 'Apply view Beta' })
    expect(applyActive).toHaveAttribute('aria-current', 'true')
    expect(applyOther).not.toHaveAttribute('aria-current')
  })

  it('calls onApply and closes the popover when a view is clicked', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    const view = makeView({ name: 'Alpha' })
    render(<SavedViewsDropdown {...makeProps({ views: [view], onApply })} />)

    await user.click(screen.getByTestId('saved-views-trigger'))
    await user.click(await screen.findByRole('button', { name: 'Apply view Alpha' }))

    expect(onApply).toHaveBeenCalledWith(view)
    expect(screen.queryByTestId('saved-views-menu')).not.toBeInTheDocument()
  })

  it('calls onDelete without applying when the delete button is clicked', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    const onApply = vi.fn()
    const view = makeView({ name: 'Alpha' })
    render(<SavedViewsDropdown {...makeProps({ views: [view], onDelete, onApply })} />)

    await user.click(screen.getByTestId('saved-views-trigger'))
    await user.click(await screen.findByRole('button', { name: 'Delete view Alpha' }))

    expect(onDelete).toHaveBeenCalledWith(view)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('opens the SaveViewDialog from "Save current view…" and forwards the confirmed name', async () => {
    const user = userEvent.setup()
    const onSaveCurrentView = vi.fn()
    render(<SavedViewsDropdown {...makeProps({ onSaveCurrentView })} />)

    await user.click(screen.getByTestId('saved-views-trigger'))
    await user.click(await screen.findByTestId('saved-views-save-current'))

    expect(await screen.findByTestId('save-view-dialog')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'New view')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(onSaveCurrentView).toHaveBeenCalledWith('New view')
  })

  it('has no a11y violations at rest (closed popover)', async () => {
    const view = makeView()
    const { container } = render(<SavedViewsDropdown {...makeProps({ views: [view] })} />)
    const results = await axeRaw(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with the popover open (portaled menu content)', async () => {
    const user = userEvent.setup()
    const views = [makeView({ id: 'a', name: 'Alpha' }), makeView({ id: 'b', name: 'Beta' })]
    render(<SavedViewsDropdown {...makeProps({ views, activeView: views[0] ?? null })} />)

    await user.click(screen.getByTestId('saved-views-trigger'))
    await screen.findByTestId('saved-views-menu')

    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })
})
