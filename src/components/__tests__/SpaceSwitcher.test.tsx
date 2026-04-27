/**
 * Tests for SpaceSwitcher (FEAT-3 Phase 1 + Phase 6).
 *
 * Validates:
 *  - Renders current space name from the store
 *  - Mounts trigger `refreshAvailableSpaces` via listSpaces mock
 *  - Options render in alphabetical order (server-sorted by list_spaces)
 *  - Selecting an option calls `setCurrentSpace` with the right id
 *  - "Manage spaces…" is enabled and opens the SpaceManageDialog
 *  - a11y compliance via axe audit
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (native
 * `<select>` shim) so `userEvent.selectOptions()` works in jsdom. The
 * SpaceManageDialog child is stubbed with a render-prop spy so this
 * suite stays focused on the switcher's behaviour — the dialog has its
 * own dedicated test file.
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

// Stub the manage dialog so the switcher tests stay isolated. The stub
// renders a sentinel element only when `open === true` so tests can
// assert the dialog flipped open without exercising the real dialog's
// emptiness-probe IPC, accent picker, etc.
vi.mock('../SpaceManageDialog', () => ({
  SpaceManageDialog: ({ open }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <div data-testid="space-manage-dialog-stub" /> : null,
}))

const mockedListSpaces = vi.mocked(listSpaces)

const PERSONAL: SpaceRow = { id: 'SPACE_AAAA', name: 'Personal', accent_color: null }
const WORK: SpaceRow = { id: 'SPACE_ZZZZ', name: 'Work', accent_color: null }

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

  // FEAT-3 Phase 6 — the "Manage spaces…" entry is no longer a
  // disabled placeholder. It is an enabled SelectItem and selecting it
  // opens `SpaceManageDialog` instead of switching space. The dialog
  // mount itself is asserted via the stub installed at the top of the
  // file.
  it('renders the Manage spaces option as enabled and opens the manage dialog when selected', async () => {
    const user = userEvent.setup()
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    const manageOption = screen.getByRole('option', { name: /Manage spaces/ })
    expect(manageOption).toBeInTheDocument()
    // Phase 6 — must NOT be disabled any more. The disabled placeholder
    // was the Phase 1 stub; the dialog is now real.
    expect(manageOption).not.toBeDisabled()
    // The dialog stub renders nothing when `open === false`.
    expect(screen.queryByTestId('space-manage-dialog-stub')).not.toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    await user.selectOptions(select, '__manage__')

    // The sentinel must NOT switch space — `currentSpaceId` is still
    // the alphabetical fallback (Personal). It must, however, open the
    // SpaceManageDialog.
    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
    expect(screen.getByTestId('space-manage-dialog-stub')).toBeInTheDocument()
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
    // Selecting the Manage sentinel must not switch space — the
    // component short-circuits the sentinel and routes the click to
    // the dialog instead.
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

  // ── UX-9: shortcut hint tooltip on the trigger ──
  it('renders a shortcut-hint tooltip on the trigger (UX-9)', async () => {
    const user = userEvent.setup()
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    // The Tooltip wraps the SelectTrigger via a `<span>` so the hint
    // surfaces even though Radix Select owns the underlying combobox
    // events. The Radix TooltipTrigger writes `data-slot="tooltip-trigger"`
    // onto the cloned span; hovering that span opens the tooltip.
    // Note: the ui-select mock renders SelectTrigger as `null`, so the
    // span is empty in tests — hover events still fire on the span
    // itself, which is all Radix Tooltip needs.
    const tooltipTrigger = document.querySelector(
      '[data-slot="tooltip-trigger"]',
    ) as HTMLElement | null
    expect(tooltipTrigger).not.toBeNull()
    await user.hover(tooltipTrigger as HTMLElement)

    await waitFor(
      async () => {
        const matches = await screen.findAllByText(/Tip: Ctrl\+1.+9/)
        expect(matches.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000 },
    )
  })

  // FEAT-3p11 — each non-disabled SelectItem must carry a digit-hotkey
  // hint chip (`Ctrl+1`, `Ctrl+2`, … on Linux/Windows; `⌘1`, `⌘2`, … on
  // macOS) so the shortcut is discoverable without consulting the
  // keyboard cheat-sheet. The chip is rendered for the first nine
  // spaces in alphabetical order; the disabled "Manage spaces…"
  // placeholder must NOT carry a chip — it isn't bound to a hotkey
  // and its row is owned by FEAT-3p6.
  it('renders a hint chip on each space row in alphabetical order (FEAT-3p11)', async () => {
    mockedListSpaces.mockResolvedValueOnce([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    await waitFor(() => {
      expect(useSpaceStore.getState().isReady).toBe(true)
    })

    // jsdom's UA does not match macOS, so `isMac()` returns false and
    // the chip text is the spelled-out modifier (`Ctrl+N`). This keeps
    // the assertion deterministic across platforms running the test
    // suite.
    const select = screen.getByRole('combobox', { name: /Switch space/ })
    const options = select.querySelectorAll('option')
    // 2 spaces + 1 Manage placeholder.
    expect(options).toHaveLength(3)
    // Alphabetical order: Personal first, Work second.
    expect(options[0]?.textContent).toContain('Personal')
    expect(options[0]?.textContent).toContain('Ctrl+1')
    expect(options[1]?.textContent).toContain('Work')
    expect(options[1]?.textContent).toContain('Ctrl+2')
    // The disabled Manage placeholder must stay chip-free — FEAT-3p6
    // owns it and it isn't a hotkey target.
    const manageOption = screen.getByRole('option', { name: /Manage spaces/ })
    expect(manageOption.textContent).not.toMatch(/Ctrl\+\d/)
    // Belt-and-braces: the data-testid'd chip elements are exactly two
    // (one per space) and not attached to the placeholder.
    const chips = document.querySelectorAll('[data-testid^="space-hotkey-hint-"]')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.getAttribute('data-testid')).toBe('space-hotkey-hint-1')
    expect(chips[1]?.getAttribute('data-testid')).toBe('space-hotkey-hint-2')
  })
})
