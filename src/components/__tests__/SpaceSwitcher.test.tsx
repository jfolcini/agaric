/**
 * Tests for SpaceSwitcher (FEAT-3 Phase 1).
 *
 * Validates:
 *  - Renders current space name from the store
 *  - Mounts trigger `refreshAvailableSpaces` via listSpaces mock
 *  - Options render in alphabetical order (server-sorted by list_spaces)
 *  - Selecting an option calls `setCurrentSpace` with the right id
 *  - "Manage spaces…" is disabled and has the Phase 6 tooltip string
 *  - a11y compliance via axe audit
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (native
 * `<select>` shim) so `userEvent.selectOptions()` works in jsdom.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { SpaceRow } from '../../lib/tauri'
import { listSpaces } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { SpaceSwitcher } from '../SpaceSwitcher'

vi.mock('../../lib/tauri', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    listSpaces: vi.fn(),
  }
})

const mockedListSpaces = vi.mocked(listSpaces)

const PERSONAL: SpaceRow = { id: 'SPACE_AAAA', name: 'Personal' }
const WORK: SpaceRow = { id: 'SPACE_ZZZZ', name: 'Work' }

beforeEach(() => {
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: false,
  })
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SpaceSwitcher', () => {
  it('calls refreshAvailableSpaces on mount and renders the current space', async () => {
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    // `refreshAvailableSpaces` runs in the mount effect; wait for the
    // store to flip `isReady` (and thus `availableSpaces` to populate).
    await waitFor(() => {
      expect(mockedListSpaces).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    expect(select).toBeInTheDocument()
    // With no prior persisted id, reconciliation falls back to the
    // first alphabetical entry (Personal).
    expect(select).toHaveValue(PERSONAL.id)
  })

  it('renders both seeded spaces in alphabetical order', async () => {
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    const options = select.querySelectorAll('option')
    // 2 spaces + 1 "Manage spaces…" sentinel option
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveTextContent('Personal')
    expect(options[0]).toHaveValue(PERSONAL.id)
    expect(options[1]).toHaveTextContent('Work')
    expect(options[1]).toHaveValue(WORK.id)
  })

  it('calls setCurrentSpace with the selected id when the user switches', async () => {
    const user = userEvent.setup()
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    await user.selectOptions(select, WORK.id)

    expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)
  })

  it('renders the Manage spaces placeholder as disabled', async () => {
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    const manageOption = screen.getByRole('option', { name: /Manage spaces/ })
    expect(manageOption).toBeInTheDocument()
    expect(manageOption).toBeDisabled()
    // The option wraps a Radix Tooltip; the trigger element must be in
    // the tree so hover reveals the Phase 6 label. Radix only mounts
    // tooltip content on open, so we assert on the trigger attributes
    // that are always present.
    const tooltipTrigger = document.querySelector('[data-slot="tooltip-trigger"]')
    expect(tooltipTrigger).not.toBeNull()
    expect(tooltipTrigger).toContainElement(manageOption as HTMLElement)
  })

  it('exposes the Phase 6 tooltip label when the trigger is hovered', async () => {
    const user = userEvent.setup()
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    const tooltipTrigger = document.querySelector(
      '[data-slot="tooltip-trigger"]',
    ) as HTMLElement | null
    expect(tooltipTrigger).not.toBeNull()
    if (tooltipTrigger === null) return

    await user.hover(tooltipTrigger)
    // Radix portals TooltipContent to document.body on open and also
    // renders a visually-hidden screen-reader copy — two "Coming in
    // Phase 6" nodes appear in the tree. `findAllByText` accepts both
    // and `length > 0` is the observable signal that the tooltip opened.
    await waitFor(
      async () => {
        const matches = await screen.findAllByText('Coming in Phase 6')
        expect(matches.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000 },
    )
  })

  it('does not update currentSpaceId when the Manage sentinel is selected', async () => {
    const user = userEvent.setup()
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })
    // Reconciliation falls back to Personal.
    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    // Attempt to "switch" to the Manage sentinel — the component must
    // ignore the change (HTML select allows selecting disabled options
    // programmatically). Even if the onChange fires, the component's
    // guard discards the sentinel.
    await user.selectOptions(select, '__manage__')

    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
  })

  it('renders even when listSpaces rejects — store logs warn and stays usable', async () => {
    mockedListSpaces.mockRejectedValueOnce(new Error('fail'))

    render(<SpaceSwitcher />)

    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })
    // No space rows means the combobox still renders but has no real
    // options — the Manage sentinel is still present.
    const select = screen.getByRole('combobox', { name: /Switch space/ })
    expect(select).toBeInTheDocument()
    expect(useSpaceStore.getState().availableSpaces).toEqual([])
  })

  it('has no a11y violations', async () => {
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    const { container } = render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
