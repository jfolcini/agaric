/**
 * SearchSheetTrigger — the mobile header search button.
 *
 * #135 — verifies the pinned-scope override: a pinned default scope
 * wins over the context-aware `defaultModeForView` default.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { setPinnedSearchScope } from '../../lib/pinned-search-scope'
import { useNavigationStore } from '../../stores/navigation'
import { useSearchSheetStore } from '../../stores/useSearchSheetStore'
import { SearchSheetTrigger } from '../SearchSheetTrigger'

beforeEach(() => {
  localStorage.clear()
  useSearchSheetStore.setState({ open: false, mode: 'in-page', query: '' })
  useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
})

afterEach(() => {
  localStorage.clear()
  useSearchSheetStore.setState({ open: false, mode: 'in-page', query: '' })
})

describe('SearchSheetTrigger', () => {
  it('has no a11y violations', async () => {
    useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
    const { container } = render(<SearchSheetTrigger />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('opens with the context-aware default when no scope is pinned', async () => {
    const user = userEvent.setup()
    // journal → defaultModeForView returns 'in-page'.
    useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
    render(<SearchSheetTrigger />)
    await user.click(screen.getByTestId('search-sheet-trigger'))
    expect(useSearchSheetStore.getState().open).toBe(true)
    expect(useSearchSheetStore.getState().mode).toBe('in-page')
  })

  it('honours a pinned scope over the context-aware default', async () => {
    const user = userEvent.setup()
    // journal would default to 'in-page', but the pin forces 'all-pages'.
    useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
    setPinnedSearchScope('all-pages')
    render(<SearchSheetTrigger />)
    await user.click(screen.getByTestId('search-sheet-trigger'))
    expect(useSearchSheetStore.getState().mode).toBe('all-pages')
  })
})
