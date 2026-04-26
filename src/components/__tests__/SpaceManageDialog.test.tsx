/**
 * Tests for SpaceManageDialog (FEAT-3 Phase 6).
 *
 * Coverage:
 *  - Renders the title, close affordance, and one row per available
 *    space.
 *  - Inline rename round-trips through the `editBlock` IPC mock.
 *  - Accent picker emits `setProperty('accent_color', token)`.
 *  - Delete button is disabled when the space is non-empty (mocked
 *    `listBlocks` returns ≥1 page).
 *  - Delete button is disabled on the last remaining space.
 *  - Delete with confirmation routes through `deleteBlock`; cancel
 *    closes the confirmation; ESC closes the main dialog.
 *  - "Create new space" form opens, posts via the new `createSpace`
 *    IPC, and resets / closes on success.
 *  - Onboarding hint shows on first render with ≤2 spaces; dismissal
 *    sets the localStorage flag; subsequent renders hide it.
 *  - axe(container) passes for default, onboarding-visible, create-form
 *    open, and delete-confirm-open states.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import type { SpaceRow } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'
import { SpaceManageDialog } from '../SpaceManageDialog'

const mockedInvoke = vi.mocked(invoke)

const PERSONAL: SpaceRow = { id: 'SPACE_PERSON_AAAA', name: 'Personal' }
const WORK: SpaceRow = { id: 'SPACE_WORK_ZZZZZZ', name: 'Work' }

const ONBOARDING_KEY = t('space.onboardingSeenKey')

const emptyPage = { items: [], next_cursor: null, has_more: false }
const nonEmptyPage = {
  items: [
    {
      id: 'PG_1',
      block_type: 'page',
      content: 'a page',
      parent_id: null,
      position: 1,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: 'PG_1',
    },
  ],
  next_cursor: null,
  has_more: false,
}

/**
 * Default IPC mock — every space probe returns "empty" so Delete is
 * enabled everywhere by default. Per-test overrides chain
 * `mockImplementation` to specialise behaviour.
 */
function setupDefaultIpcMocks() {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_blocks') return emptyPage
    if (cmd === 'list_spaces') return [PERSONAL, WORK]
    if (cmd === 'edit_block') return null
    if (cmd === 'set_property') return null
    if (cmd === 'delete_block') return { affected_count: 1 }
    if (cmd === 'create_space') return 'SPACE_NEW_ID'
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSpaceStore.setState({
    currentSpaceId: PERSONAL.id,
    availableSpaces: [PERSONAL, WORK],
    isReady: true,
  })
  setupDefaultIpcMocks()
})

describe('SpaceManageDialog', () => {
  it('renders title, description, and one row per available space', async () => {
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    expect(await screen.findByText(t('space.manageDialogTitle'))).toBeInTheDocument()
    expect(screen.getByText(t('space.manageDialogDescription'))).toBeInTheDocument()

    // Each space surfaces an editable input prefilled with its name.
    const personalInput = screen.getByDisplayValue(PERSONAL.name)
    const workInput = screen.getByDisplayValue(WORK.name)
    expect(personalInput).toBeInTheDocument()
    expect(workInput).toBeInTheDocument()
  })

  it('inline rename routes through the editBlock IPC and refreshes spaces', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    const personalInput = await screen.findByDisplayValue(PERSONAL.name)
    await user.clear(personalInput)
    await user.type(personalInput, 'Home{Enter}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: PERSONAL.id, toText: 'Home' }),
      )
    })
    // After a successful rename the dialog calls
    // `refreshAvailableSpaces` which re-issues `list_spaces`.
    await waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'list_spaces')).toBe(true)
    })
  })

  // FEAT-3p6 — IPC error-path coverage. When a write IPC rejects, the
  // dialog must not silently swallow the failure: the user-visible
  // surface (toast / banner / aria-live region) must fire so the user
  // knows the rename / accent / delete / create did NOT take effect.
  // Per AGENTS.md "no silent .catch(() => {}) blocks" — see
  // `prek run` ipc-error-path-coverage hook for the enforcement.
  it('surfaces an error to the user when an IPC write rejects', async () => {
    const user = userEvent.setup()
    // Specialise: edit_block rejects, everything else default-empty.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      if (cmd === 'edit_block') throw new Error('IPC offline')
      if (cmd === 'set_property') return null
      return null
    })

    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    const personalInput = await screen.findByDisplayValue(PERSONAL.name)
    await user.clear(personalInput)
    await user.type(personalInput, 'Home{Enter}')

    // Sonner is globally mocked (`src/__tests__/mocks/sonner.ts`), so
    // `toast.error` is a `vi.fn()` rather than a DOM-mounted toast.
    // Assert the mock was called with the i18n-keyed copy — that
    // proves the rejection path didn't silently swallow the failure.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.renameFailed'))
    })
    // The dialog stays open (the rejection is recoverable — user can
    // retry). The fallback restores the original name in the input.
    expect(screen.getByText(t('space.manageDialogTitle'))).toBeInTheDocument()
  })

  it('clicking an accent swatch emits setProperty(accent_color, token)', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    // First per-row swatch group (Personal). The row aria-group lookup
    // is unambiguous: each row has its own group.
    const groups = await screen.findAllByRole('group', {
      name: t('space.accentColorLabel'),
    })
    // groups[0] — Personal row swatches; groups[1] — Work row swatches.
    const swatch = within(groups[0] as HTMLElement).getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'violet' }),
    })
    await user.click(swatch)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: PERSONAL.id,
          key: 'accent_color',
          valueText: 'accent-violet',
        }),
      )
    })
  })

  it('disables the delete button when the space has at least one page', async () => {
    // Probe returns a non-empty page → Delete must be disabled.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return nonEmptyPage
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      return null
    })

    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    // Both Delete buttons are disabled because the probe returns one
    // page for every space. We assert there are no enabled delete
    // buttons in the dialog.
    await waitFor(() => {
      const deleteButtons = screen.getAllByRole('button', {
        name: t('space.deleteSpaceLabel'),
      })
      expect(deleteButtons).toHaveLength(2)
      for (const btn of deleteButtons) {
        expect(btn).toBeDisabled()
      }
    })
  })

  it('disables the delete button on the only remaining space', async () => {
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL],
      isReady: true,
    })

    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: t('space.deleteSpaceLabel') })
      expect(btn).toBeDisabled()
    })
  })

  it('confirms before delete; confirm routes through deleteBlock; cancel closes confirmation', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    // The per-row emptiness probe (`list_blocks`) is async — Delete
    // starts disabled (`isEmpty === null`) and only flips to enabled
    // once the probe resolves with an empty page. Wait for that
    // transition before clicking.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', {
        name: t('space.deleteSpaceLabel'),
      })
      expect(buttons.length).toBeGreaterThanOrEqual(2)
      for (const btn of buttons) expect(btn).not.toBeDisabled()
    })
    const deleteBtns = screen.getAllByRole('button', {
      name: t('space.deleteSpaceLabel'),
    })
    await user.click(deleteBtns[0] as HTMLElement)

    // Confirmation alert dialog is mounted.
    expect(
      await screen.findByText(t('space.deleteConfirmTitle', { name: PERSONAL.name })),
    ).toBeInTheDocument()

    // Cancel — confirmation closes, no deleteBlock call.
    await user.click(screen.getByRole('button', { name: t('space.cancelLabel') }))
    await waitFor(() => {
      expect(
        screen.queryByText(t('space.deleteConfirmTitle', { name: PERSONAL.name })),
      ).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())

    // Re-open the confirmation, then confirm.
    await user.click(deleteBtns[0] as HTMLElement)
    await screen.findByText(t('space.deleteConfirmTitle', { name: PERSONAL.name }))
    await user.click(screen.getByRole('button', { name: t('action.delete') }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'delete_block',
        expect.objectContaining({ blockId: PERSONAL.id }),
      )
    })
  })

  it('ESC on the main dialog calls onOpenChange(false)', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<SpaceManageDialog open={true} onOpenChange={onOpenChange} />)

    await screen.findByText(t('space.manageDialogTitle'))
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('opens an inline create form, posts via createSpace, and closes on success', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    // Footer button opens the form.
    const openCreateBtn = await screen.findByRole('button', {
      name: t('space.createSpaceLabel'),
    })
    await user.click(openCreateBtn)

    const nameInput = screen.getByPlaceholderText(t('space.newSpacePlaceholder'))
    await user.type(nameInput, 'Side Project')

    // Pick an accent (the create form has its own swatch group, which is
    // the third group on the page after the two row groups).
    const groups = screen.getAllByRole('group', { name: t('space.accentColorLabel') })
    const formSwatches = groups[groups.length - 1] as HTMLElement
    await user.click(
      within(formSwatches).getByRole('button', {
        name: t('space.accentSwatchLabel', { color: 'blue' }),
      }),
    )

    await user.click(screen.getByRole('button', { name: t('space.createSpaceCta') }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_space',
        expect.objectContaining({ name: 'Side Project', accentColor: 'accent-blue' }),
      )
    })

    // After success the form collapses back to the "Create new space"
    // primary button. The previously-shown text input must not be in
    // the DOM.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(t('space.newSpacePlaceholder'))).not.toBeInTheDocument()
    })
  })

  it('shows the onboarding hint on first render with two spaces and hides it after dismissal', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    expect(await screen.findByText(t('space.onboardingTitle'))).toBeInTheDocument()
    expect(screen.getByText(t('space.onboardingBody'))).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('space.onboardingDismiss') }))

    // localStorage flag must be set so the hint never reappears in
    // future sessions.
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe('true')
    // Hint unmounts immediately on dismiss.
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  it('does not show the onboarding hint when the localStorage flag is already set', async () => {
    localStorage.setItem(ONBOARDING_KEY, 'true')
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    await screen.findByText(t('space.manageDialogTitle'))
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  it('does not show the onboarding hint when more than two spaces exist', async () => {
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL, WORK, { id: 'SPACE_3', name: 'Side' }],
      isReady: true,
    })
    render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    await screen.findByText(t('space.manageDialogTitle'))
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  // Accessibility audits — four states matter visually:
  //  1. default open
  //  2. onboarding banner visible
  //  3. create-form expanded
  //  4. delete-confirm AlertDialog open
  it('has no a11y violations (default)', async () => {
    localStorage.setItem(ONBOARDING_KEY, 'true')
    const { container } = render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)
    await screen.findByText(t('space.manageDialogTitle'))
    // Settle async list_blocks probes before the audit runs so the
    // tree is stable when axe walks it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations (onboarding visible)', async () => {
    const { container } = render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)
    await screen.findByText(t('space.onboardingTitle'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations (create form open)', async () => {
    const user = userEvent.setup()
    localStorage.setItem(ONBOARDING_KEY, 'true')
    const { container } = render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    await user.click(await screen.findByRole('button', { name: t('space.createSpaceLabel') }))
    await screen.findByPlaceholderText(t('space.newSpacePlaceholder'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no a11y violations (delete confirmation open)', async () => {
    const user = userEvent.setup()
    localStorage.setItem(ONBOARDING_KEY, 'true')
    const { container } = render(<SpaceManageDialog open={true} onOpenChange={() => {}} />)

    // Wait for the emptiness probe to settle so Delete is enabled
    // before we click it.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', {
        name: t('space.deleteSpaceLabel'),
      })
      for (const btn of buttons) expect(btn).not.toBeDisabled()
    })
    const deleteBtns = screen.getAllByRole('button', {
      name: t('space.deleteSpaceLabel'),
    })
    await user.click(deleteBtns[0] as HTMLElement)
    await screen.findByText(t('space.deleteConfirmTitle', { name: PERSONAL.name }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
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
