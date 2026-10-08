/**
 * Tests for SpaceManageDialog (Phase 6).
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

import { SpaceManageDialog } from '@/components/SpaceManageDialog'
import { useIsMobile } from '@/hooks/useIsMobile'
import type { SpaceRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// The dialog swaps to a bottom Sheet via `useDialogOrSheet`
// when `useIsMobile()` is true. Mock the hook so each test can pin the
// viewport-state boolean.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedUseIsMobile = vi.mocked(useIsMobile)

const PERSONAL: SpaceRow = { id: 'SPACE_PERSON_AAAA', name: 'Personal', accent_color: null }
const WORK: SpaceRow = { id: 'SPACE_WORK_ZZZZZZ', name: 'Work', accent_color: null }

const ONBOARDING_KEY = t('space.onboardingSeenKey')

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }
const nonEmptyPage = {
  items: [
    {
      id: 'PG_1',
      block_type: 'page',
      content: 'a page',
      parent_id: null,
      position: 1,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: 'PG_1',
    },
  ],
  next_cursor: null,
  has_more: false,
  total_count: null,
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
    if (cmd === 'delete_property') return null
    if (cmd === 'delete_block') return { affected_count: 1 }
    if (cmd === 'create_space') return 'SPACE_NEW_ID'
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // Default to the desktop path so existing test bodies keep their semantics.
  mockedUseIsMobile.mockReturnValue(false)
  useSpaceStore.setState({
    currentSpaceId: PERSONAL.id,
    availableSpaces: [PERSONAL, WORK],
    isReady: true,
  })
  setupDefaultIpcMocks()
})

describe('SpaceManageDialog', () => {
  it('renders title, description, and one row per available space', async () => {
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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

  // IPC error-path coverage. When a write IPC rejects, the
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

    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
          value: expect.objectContaining({ value_text: 'accent-violet' }),
        }),
      )
    })
  })

  // Colour-blind users cannot reliably tell which swatch is
  // selected by ring colour alone, so the selected swatch overlays a
  // <Check> icon as a non-colour signal. This test asserts the icon
  // is present on exactly the selected swatch and absent on the rest.
  it('overlays a Check icon on the currently-selected accent swatch only', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    const groups = await screen.findAllByRole('group', {
      name: t('space.accentColorLabel'),
    })
    const personalGroup = groups[0] as HTMLElement
    const violetBtn = within(personalGroup).getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'violet' }),
    })
    const blueBtn = within(personalGroup).getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'blue' }),
    })

    // Pre-click: nothing is selected on the Personal row (mock seeds
    // `accent_color: null`), so no swatch carries the Check overlay.
    expect(violetBtn.querySelector('svg')).toBeNull()
    expect(blueBtn.querySelector('svg')).toBeNull()

    await user.click(violetBtn)

    // Post-click: only the violet swatch shows the Check icon. Other
    // swatches in the same group stay icon-free.
    await waitFor(() => {
      expect(violetBtn.querySelector('svg')).not.toBeNull()
    })
    expect(blueBtn.querySelector('svg')).toBeNull()

    // The icon is hidden from assistive tech (decorative — selection
    // is already announced via `aria-pressed`).
    const icon = violetBtn.querySelector('svg') as SVGElement
    expect(icon.getAttribute('aria-hidden')).toBe('true')
  })

  // Swatches paint via the CSS custom property tied to the
  // accent token, not a hardcoded Tailwind `bg-*-500` class. This keeps
  // theme switching (Solarized, Dracula, OneDarkPro) honest: the fill
  // follows the active theme's `--accent-*` value automatically.
  it('renders accent swatches with CSS-var inline backgroundColor', async () => {
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    const groups = await screen.findAllByRole('group', {
      name: t('space.accentColorLabel'),
    })
    const personalGroup = groups[0] as HTMLElement
    const swatches = within(personalGroup).getAllByRole('button', {
      name: /accent/i,
    })

    expect(swatches.length).toBeGreaterThan(0)
    for (const btn of swatches) {
      const token = btn.getAttribute('data-accent-token') ?? ''
      expect(token).toMatch(/^accent-/)
      // Inline style drives the swatch fill from the CSS custom property.
      // Read the raw `style` attribute because jsdom does not resolve
      // `var(...)` through the CSSOM `style.backgroundColor` accessor.
      expect(btn.getAttribute('style') ?? '').toContain(`background-color: var(--${token})`)
      // No hardcoded Tailwind `bg-*-500` escape hatch on the className.
      expect(btn.className).not.toMatch(/\bbg-[a-z]+-500\b/)
    }
  })

  it('disables the delete button when the space has at least one page', async () => {
    // Probe returns a non-empty page → Delete must be disabled.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return nonEmptyPage
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      return null
    })

    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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

  // When Delete is disabled because the space contains pages,
  // the only signal was the Tooltip-on-hover. Add an inline help line
  // under the row so the reason is visible at rest. The hint must
  // render only when there is a definite "non-empty" probe result for
  // a non-last space; it must NOT render for empty spaces (Delete is
  // enabled there) or for the last-remaining-space disabled path
  // (already covered by the `deleteLastTooltipDisabled` tooltip).
  it('renders the inline-blocked hint when a non-last space has pages', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return nonEmptyPage
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      return null
    })

    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    // Both rows are non-empty and neither is the last space → both
    // rows render the inline hint paragraph once the probe resolves.
    await waitFor(() => {
      const hints = screen.getAllByTestId('space-delete-blocked-hint')
      expect(hints).toHaveLength(2)
      for (const hint of hints) {
        expect(hint).toHaveTextContent(t('space.deleteSpaceInlineHint'))
      }
    })
  })

  it('does not render the inline-blocked hint when the space is empty', async () => {
    // Default mocks return `emptyPage` for every space → Delete is
    // enabled and the inline hint must NOT mount.
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    // Wait for the emptiness probe to settle and Delete to enable so
    // we are asserting against the post-probe DOM, not the
    // probe-in-flight (`emptiness === null`) state.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', {
        name: t('space.deleteSpaceLabel'),
      })
      expect(buttons.length).toBeGreaterThanOrEqual(2)
      for (const btn of buttons) expect(btn).not.toBeDisabled()
    })
    expect(screen.queryAllByTestId('space-delete-blocked-hint')).toHaveLength(0)
  })

  it('disables the delete button on the only remaining space', async () => {
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL],
      isReady: true,
    })

    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: t('space.deleteSpaceLabel') })
      expect(btn).toBeDisabled()
    })
  })

  it('confirms before delete; confirm routes through deleteBlock; cancel closes confirmation', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
    render(<SpaceManageDialog open onOpenChange={onOpenChange} />)

    await screen.findByText(t('space.manageDialogTitle'))
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('opens an inline create form, posts via createSpace, and closes on success', async () => {
    const user = userEvent.setup()
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
    const formSwatches = groups.at(-1) as HTMLElement
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
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    await screen.findByText(t('space.manageDialogTitle'))
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  it('does not show the onboarding hint when more than two spaces exist', async () => {
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL, WORK, { id: 'SPACE_3', name: 'Side', accent_color: null }],
      isReady: true,
    })
    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    await screen.findByText(t('space.manageDialogTitle'))
    expect(screen.queryByText(t('space.onboardingTitle'))).not.toBeInTheDocument()
  })

  // ── — IPC dedup contract ─────────────
  //
  // The emptiness probe (`list_blocks { spaceId, blockType:'page',
  // limit:1 }`) is owned by the dialog body and keyed by `space.id`,
  // so it fires exactly once per unique `space.id` per open — not once
  // per `SpaceRowEditor` mount.

  it('fires the emptiness probe once per space.id', async () => {
    useSpaceStore.setState({
      currentSpaceId: PERSONAL.id,
      availableSpaces: [PERSONAL, WORK, { id: 'SPACE_3', name: 'Side', accent_color: null }],
      isReady: true,
    })

    render(<SpaceManageDialog open onOpenChange={() => {}} />)

    // The Delete buttons start disabled and only enable once
    // `list_blocks` resolves with an empty page.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', {
        name: t('space.deleteSpaceLabel'),
      })
      expect(buttons).toHaveLength(3)
      for (const btn of buttons) expect(btn).not.toBeDisabled()
    })

    // `list_blocks` fires once per space.id (no batched emptiness
    // probe today).
    const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
    expect(listBlocksCalls).toHaveLength(3)

    // Each space.id appears exactly once in the listBlocks call args
    // — proves dedup is keyed on space.id, not just call count.
    // #2248 — `list_blocks` carries the active-space scope at the IPC boundary.
    const listBlocksSpaceIds = listBlocksCalls.map(
      ([, args]) => (args as { scope: { space_id: string } }).scope.space_id,
    )
    expect(new Set(listBlocksSpaceIds)).toEqual(new Set([PERSONAL.id, WORK.id, 'SPACE_3']))
  })

  it('re-reads emptiness on every open (#5284)', async () => {
    let page: typeof emptyPage | typeof nonEmptyPage = nonEmptyPage
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return page
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      return null
    })
    const deleteButtons = () => screen.getAllByRole('button', { name: t('space.deleteSpaceLabel') })

    const { rerender } = render(<SpaceManageDialog open onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(screen.getAllByTestId('space-delete-blocked-hint')).toHaveLength(2)
    })
    for (const btn of deleteButtons()) expect(btn).toBeDisabled()

    rerender(<SpaceManageDialog open={false} onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(screen.queryByText(t('space.manageDialogTitle'))).not.toBeInTheDocument()
    })
    // While closed, the spaces' pages move out.
    page = emptyPage

    rerender(<SpaceManageDialog open onOpenChange={() => {}} />)
    await waitFor(() => {
      for (const btn of deleteButtons()) expect(btn).not.toBeDisabled()
    })
  })

  it('keeps a probe result that lands after the space list changed (#5284)', async () => {
    const pending: Array<(v: unknown) => void> = []
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return new Promise((resolve) => pending.push(resolve))
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      return null
    })

    render(<SpaceManageDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(pending).toHaveLength(2))

    // A refresh lands while both probes are in flight.
    act(() => {
      useSpaceStore.setState({
        availableSpaces: [PERSONAL, WORK, { id: 'SPACE_3', name: 'Side', accent_color: null }],
      })
    })
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => {
      for (const resolve of pending) resolve(emptyPage)
    })

    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: t('space.deleteSpaceLabel') })
      expect(buttons).toHaveLength(3)
      for (const btn of buttons) expect(btn).not.toBeDisabled()
    })
  })

  // ── B-7 — cancellation guard on the per-space probe IIFEs ───
  //
  // The `void async` IIFEs inside the `useEffect` resolve into
  // `setEmptinessBySpace` calls. Closing the dialog unmounts the
  // content (Radix, no `forceMount`); without the `active` flag those
  // resolutions wrote state on an unmounted
  // component (React 19 strict-mode warning surface). This test
  // exercises the post-unmount resolution path: it must complete
  // cleanly with no React warnings on `console.error` and no logger
  // calls (success path returns early, never reaching the catch).
  it('cancels in-flight emptiness probes on unmount (B-7)', async () => {
    let resolveBlocks!: (v: unknown) => void
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces') return [PERSONAL, WORK]
      if (cmd === 'list_blocks') {
        return new Promise((resolve) => {
          resolveBlocks = resolve
        })
      }
      return null
    })

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { unmount } = render(<SpaceManageDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'list_blocks')).toBe(true)
    })

    // Unmount before the probe resolves — cleanup sets active=false.
    unmount()

    // Resolve the deferred IPC post-unmount and let the microtask
    // chain settle inside `act(async)`.
    await act(async () => {
      resolveBlocks(emptyPage)
    })

    // Cancellation guard short-circuits the success path: no
    // `setEmptinessBySpace` runs, and the catch never fires.
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.any(String),
      'failed to probe space emptiness',
      expect.anything(),
      expect.anything(),
    )
    // No React-level warnings about state updates on an unmounted
    // component slipped through the strict-mode console.error channel.
    expect(consoleErrorSpy).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  // Accessibility audits — four states matter visually:
  //  1. default open
  //  2. onboarding banner visible
  //  3. create-form expanded
  //  4. delete-confirm AlertDialog open
  it('has no a11y violations (default)', async () => {
    localStorage.setItem(ONBOARDING_KEY, 'true')
    const { container } = render(<SpaceManageDialog open onOpenChange={() => {}} />)
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
    const { container } = render(<SpaceManageDialog open onOpenChange={() => {}} />)
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
    const { container } = render(<SpaceManageDialog open onOpenChange={() => {}} />)

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
    const { container } = render(<SpaceManageDialog open onOpenChange={() => {}} />)

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

  // The dialog mounts under both the desktop Dialog path and
  // the mobile Sheet path. Assert on body content (the dialog title +
  // the per-space row inputs) being visible rather than the Dialog /
  // Sheet DOM specifics so the test stays decoupled from the underlying
  // primitive.
  describe('mobile / desktop responsive surfaces', () => {
    it('renders the dialog header and per-space rows on the mobile Sheet path', async () => {
      mockedUseIsMobile.mockReturnValue(true)
      render(<SpaceManageDialog open onOpenChange={() => {}} />)

      expect(await screen.findByText(t('space.manageDialogTitle'))).toBeInTheDocument()
      expect(screen.getByDisplayValue(PERSONAL.name)).toBeInTheDocument()
      expect(screen.getByDisplayValue(WORK.name)).toBeInTheDocument()
    })

    it('renders the dialog header and per-space rows on the desktop Dialog path', async () => {
      mockedUseIsMobile.mockReturnValue(false)
      render(<SpaceManageDialog open onOpenChange={() => {}} />)

      expect(await screen.findByText(t('space.manageDialogTitle'))).toBeInTheDocument()
      expect(screen.getByDisplayValue(PERSONAL.name)).toBeInTheDocument()
      expect(screen.getByDisplayValue(WORK.name)).toBeInTheDocument()
    })
  })
})
