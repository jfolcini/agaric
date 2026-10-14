// @vitest-environment jsdom
// Accent-dot inline-style assertion (`style.backgroundColor`
// containing `var(--accent-…)`) requires jsdom — happy-dom's CSS parser
// drops `var()` values, leaving the style empty.

/**
 * Tests for SpaceSwitcher (Phase 1 + Phase 6).
 *
 * Validates:
 *  - Renders current space name from the store
 *  - Mounting issues no `list_spaces` IPC (boot already hydrated the store)
 *  - Options render in alphabetical order (server-sorted by list_spaces)
 *  - Selecting an option calls `setCurrentSpace` with the right id
 *  - "Manage spaces…" and "Create another space" open Settings › Spaces
 *  - a11y compliance via axe audit
 *
 * Radix Select is mocked globally via `src/test-setup.ts` (native
 * `<select>` shim) so `userEvent.selectOptions()` works in jsdom.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SpaceSwitcher } from '@/components/layout/SpaceSwitcher'
import type { SpaceRow } from '@/lib/bindings'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

// Boot hydrates the space store, so mounting must not call `commands.listSpaces`.
// The spy resolves an empty list so a regression fails the call-count assertion
// rather than throwing inside the component.
const mockedListSpaces = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'ok' as const, data: [] as unknown[] })),
)

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listSpaces: () => mockedListSpaces(),
    },
  }
})

// Per-file override of `@/components/ui/select`. The shared mock
// (src/__tests__/mocks/ui-select.tsx) renders `SelectTrigger` as
// `null`, which is fine for capturing props onto the native `<select>`
// SelectContent emits, but it also drops the trigger's children — so
// The "Space:" prefix span (rendered as a sibling of
// `<SelectValue>` inside the trigger) is invisible to test queries.
//
// This override delegates everything to the shared mock and only
// rewraps `SelectTrigger`: it forwards `props` (sans `children`) to
// the original trigger so the prop-capture chain that backs the native
// `<select>`'s `aria-label`, `value`, etc. keeps working, while ALSO
// rendering the trigger's children into a sibling `<div>` so tests can
// assert on the prefix text.
vi.mock('@/components/ui/select', async () => {
  const actual = await import('@/__tests__/mocks/ui-select')
  const React = await import('react')
  const OriginalTrigger = actual.SelectTrigger
  const SelectTrigger = ({
    children,
    ...props
  }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(OriginalTrigger, props),
      React.createElement('div', { 'data-slot': 'select-trigger-children' }, children),
    )
  return { ...actual, SelectTrigger }
})

const PERSONAL: SpaceRow = { id: 'SPACE_AAAA', name: 'Personal', accent_color: null }
const WORK: SpaceRow = { id: 'SPACE_ZZZZ', name: 'Work', accent_color: null }

/** Put the store in the state boot leaves it in: spaces loaded, first one active. */
function seedSpaces(spaces: SpaceRow[]): void {
  useSpaceStore.setState({
    currentSpaceId: spaces[0]?.id ?? null,
    availableSpaces: spaces,
    isReady: true,
  })
}

beforeEach(() => {
  useSpaceStore.setState({
    currentSpaceId: null,
    availableSpaces: [],
    isReady: false,
  })
  useNavigationStore.setState({ currentView: 'journal', pendingSettingsTab: null })
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SpaceSwitcher', () => {
  it('renders the current space without re-fetching list_spaces on mount', async () => {
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    expect(select).toHaveValue(PERSONAL.id)
    // Let any mount effect settle before asserting nothing was issued.
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockedListSpaces).toHaveBeenCalledTimes(0)
  })

  it('renders both seeded spaces in alphabetical order', async () => {
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

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
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    await user.selectOptions(select, WORK.id)

    expect(useSpaceStore.getState().currentSpaceId).toBe(WORK.id)
  })

  // "Manage spaces…" lands on Settings › Spaces (#5362) instead of
  // switching space.
  it('opens Settings on the Spaces tab when Manage spaces is selected', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher onNavigate={onNavigate} />)

    const manageOption = screen.getByRole('option', { name: /Manage spaces/ })
    expect(manageOption).not.toBeDisabled()

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    await user.selectOptions(select, '__manage__')

    const navigation = useNavigationStore.getState()
    expect(navigation.currentView).toBe('settings')
    expect(navigation.pendingSettingsTab).toBe('spaces')
    expect(onNavigate).toHaveBeenCalledTimes(1)
    // The sentinel must NOT switch space — `currentSpaceId` is still
    // the alphabetical fallback (Personal).
    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
  })

  it('has no a11y violations', async () => {
    seedSpaces([PERSONAL, WORK])

    const { container } = render(<SpaceSwitcher />)

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  // ── shortcut hint tooltip on the trigger ──
  it('renders a shortcut-hint tooltip on the trigger', async () => {
    const user = userEvent.setup()
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

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

  // Each non-disabled SelectItem must carry a digit-hotkey
  // hint chip (`Ctrl+1`, `Ctrl+2`, … on Linux/Windows; `⌘1`, `⌘2`, … on
  // macOS) so the shortcut is discoverable without consulting the
  // keyboard cheat-sheet. The chip is rendered for the first nine
  // spaces in alphabetical order; the disabled "Manage spaces…"
  // placeholder must NOT carry a chip — it isn't bound to a hotkey
  // And its row is owned by.
  it('renders a hint chip on each space row in alphabetical order', async () => {
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    // jsdom's UA does not match macOS, so `isMac()` returns false and
    // the chip text is the spelled-out modifier (`Ctrl+N`). This keeps
    // the assertion deterministic across platforms running the test
    // suite.
    const select = screen.getByRole('combobox', { name: /Switch space/ })
    const options = select.querySelectorAll('option')
    // 2 spaces + 1 Manage placeholder.
    expect(options).toHaveLength(3)
    // Alphabetical order: Personal first, Work second. The native
    // `<option>` rows that Radix's BubbleSelect emits mirror only the
    // `<SelectPrimitive.ItemText>` content — the digit-hint chip is
    // intentionally rendered via `SelectItem`'s `endContent` slot
    // (outside ItemText) so it stays scoped to the visible dropdown
    // rows and does not leak into the trigger label or the bubbled
    // option text. Asserting on the data-testid'd chip elements below
    // is the right way to verify chip presence.
    expect(options[0]?.textContent).toContain('Personal')
    expect(options[1]?.textContent).toContain('Work')
    // The disabled Manage placeholder must stay chip-free
    // owns it and it isn't a hotkey target.
    const manageOption = screen.getByRole('option', { name: /Manage spaces/ })
    expect(manageOption.textContent).not.toMatch(/Ctrl\+\d/)
    // Belt-and-braces: the data-testid'd chip elements are exactly two
    // (one per space) and not attached to the placeholder, and each
    // carries the spelled-out modifier text (`Ctrl+N`) on non-macOS.
    const chips = document.querySelectorAll('[data-testid^="space-hotkey-hint-"]')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.getAttribute('data-testid')).toBe('space-hotkey-hint-1')
    expect(chips[0]?.textContent).toBe('Ctrl+1')
    expect(chips[1]?.getAttribute('data-testid')).toBe('space-hotkey-hint-2')
    expect(chips[1]?.textContent).toBe('Ctrl+2')
  })

  // ── trigger replaces "Space:" prefix with an accent dot ──
  //
  // The static "Space:" text prefix was reclaiming ~50px in
  // A sidebar that's already narrow. replaces it with an 8px
  // colour-identity dot that mirrors `SpaceTopStripe` and
  // `SpaceAccentBadge`. The dot is decorative — `aria-hidden` + the
  // existing `aria-label="Switch space"` on `SelectTrigger` is the
  // accessible name. The four cases below pin the new behaviour
  // (presence + colour + fallback) AND the regression carve-out
  // (no "Space:" text in the trigger anymore, `aria-label` still set).
  it('renders an accent-coloured dot before the active space name', async () => {
    seedSpaces([{ ...PERSONAL, accent_color: 'accent-emerald' }, WORK])

    render(<SpaceSwitcher />)

    const dot = await screen.findByTestId('space-switcher-accent-dot')
    expect(dot).toBeInTheDocument()
    // `accentVar('accent-emerald')` resolves to `var(--accent-emerald, var(--accent-current))`
    // — assert on `style.backgroundColor` rather than computed colour
    // because jsdom doesn't resolve CSS custom properties.
    expect((dot as HTMLElement).style.backgroundColor).toContain('var(--accent-emerald')
    // The dot is decorative; its `aria-hidden` keeps screen readers on
    // the trigger's existing `aria-label="Switch space"`.
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })

  it("dot's colour follows the active space when the user switches", async () => {
    seedSpaces([
      { ...PERSONAL, accent_color: 'accent-emerald' },
      { ...WORK, accent_color: 'accent-violet' },
    ])

    render(<SpaceSwitcher />)

    // Initially Personal is active → emerald dot.
    let dot = (await screen.findByTestId('space-switcher-accent-dot')) as HTMLElement
    expect(dot.style.backgroundColor).toContain('var(--accent-emerald')

    // Switch to Work via the store (the test environment uses the
    // ui-select shared mock which exposes the underlying native
    // `<select>` for direct programmatic switches; cleaner than
    // simulating a click through the Radix portal here).
    useSpaceStore.getState().setCurrentSpace(WORK.id)
    await waitFor(() => {
      const next = screen.getByTestId('space-switcher-accent-dot') as HTMLElement
      expect(next.style.backgroundColor).toContain('var(--accent-violet')
    })

    dot = screen.getByTestId('space-switcher-accent-dot') as HTMLElement
    expect(dot.style.backgroundColor).not.toContain('accent-emerald')
  })

  it('falls back to var(--accent-current) when accent_color is null', async () => {
    // Mirrors the SpaceAccentBadge fallback test — a synced peer with
    // a null accent_color must still produce a non-blank dot.
    seedSpaces([{ ...PERSONAL, accent_color: null }])

    render(<SpaceSwitcher />)

    const dot = (await screen.findByTestId('space-switcher-accent-dot')) as HTMLElement
    expect(dot.style.backgroundColor).toContain('var(--accent-current')
  })

  it('does NOT render the legacy "Space:" prefix in the trigger', async () => {
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    // The per-file mock override renders SelectTrigger's children
    // into a sibling `<div data-slot="select-trigger-children">`.
    // Removes the prefix; the trigger should no longer carry
    // "Space:" text anywhere.
    const triggerChildren = document.querySelector('[data-slot="select-trigger-children"]')
    expect(triggerChildren).not.toBeNull()
    expect(triggerChildren?.textContent ?? '').not.toContain('Space:')
  })

  it('keeps the trigger\'s aria-label="Switch space" (a11y guard)', async () => {
    // The dot is decorative + `aria-hidden`. The accessible name on
    // the trigger must still be the i18n `space.switch` string so SR
    // users hear "Switch space" rather than the bare option text.
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    const trigger = screen.getByRole('combobox', { name: /Switch space/ })
    expect(trigger).toBeInTheDocument()
  })

  // ── single-space "Create another space…" hint ──
  // When the user has only one space, the SpaceSwitcher dropdown is a
  // no-op (nothing else to switch to). A "Create another space…" hint
  // is rendered inside the dropdown — under the lone space row — so
  // the manage flow is discoverable without scanning past the row to
  // the "Manage spaces…" sentinel. #2281 — it is now a real SelectItem
  // (CREATE_SENTINEL) so it joins Radix Select's roving focus and is
  // keyboard-reachable; selecting it opens Settings › Spaces, as the
  // MANAGE_SENTINEL route does, without switching space.
  it('renders the create-another-space hint as an option when there is only one space', async () => {
    seedSpaces([PERSONAL])

    render(<SpaceSwitcher />)
    expect(useSpaceStore.getState().availableSpaces).toHaveLength(1)

    // Now a SelectItem → native <option> in the test mock, so it is
    // exposed with the `option` role and joins the listbox roving focus.
    const hint = screen.getByRole('option', { name: /Create another space/ })
    expect(hint).toBeInTheDocument()
    expect(hint).toHaveValue('__create__')
  })

  it('does NOT render the create-another-space hint when there is more than one space', async () => {
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)
    expect(useSpaceStore.getState().availableSpaces).toHaveLength(2)

    expect(screen.queryByRole('option', { name: /Create another space/ })).not.toBeInTheDocument()
  })

  it('opens Settings on the Spaces tab when the create-another-space hint is selected', async () => {
    const user = userEvent.setup()
    seedSpaces([PERSONAL])

    render(<SpaceSwitcher />)

    const select = screen.getByRole('combobox', { name: /Switch space/ })
    await user.selectOptions(select, '__create__')

    // Selecting the CREATE sentinel must NOT switch space (currentSpaceId
    // stays at the alphabetical fallback) — it lands on Settings › Spaces,
    // as MANAGE_SENTINEL does.
    expect(useSpaceStore.getState().currentSpaceId).toBe(PERSONAL.id)
    const navigation = useNavigationStore.getState()
    expect(navigation.currentView).toBe('settings')
    expect(navigation.pendingSettingsTab).toBe('spaces')
  })

  // ── tooltip lists the first 5 space digit mappings ──
  // The trigger tooltip used to surface only the generic
  // "Tip: Ctrl+1..9" hint. Once the dropdown closed, the user had to
  // Re-open it to see what each digit mapped to. stacks the hint
  // above a list of `Ctrl+N name` rows for the first five spaces so the
  // mappings stay discoverable on hover.
  it('lists the first 5 space digit mappings in the trigger tooltip', async () => {
    const user = userEvent.setup()
    seedSpaces([PERSONAL, WORK])

    render(<SpaceSwitcher />)

    const tooltipTrigger = document.querySelector(
      '[data-slot="tooltip-trigger"]',
    ) as HTMLElement | null
    expect(tooltipTrigger).not.toBeNull()
    await user.hover(tooltipTrigger as HTMLElement)

    // Both space mappings should surface inside the tooltip — Personal
    // first (alphabetical), Work second. jsdom's UA is not macOS so
    // `isMac()` returns false and the chord text is the spelled-out
    // modifier (`Ctrl+N`).
    await waitFor(
      async () => {
        const personalHint = await screen.findAllByText(/Ctrl\+1\s+Personal/)
        expect(personalHint.length).toBeGreaterThanOrEqual(1)
        // The tooltip surface is inverted: a fixed `text-muted-foreground` is
        // unreadable on it, so the dim rows use opacity instead.
        for (const row of personalHint) {
          expect(row.classList.contains('opacity-90')).toBe(true)
          expect(row.classList.contains('text-muted-foreground')).toBe(false)
        }
        const workHint = await screen.findAllByText(/Ctrl\+2\s+Work/)
        expect(workHint.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000 },
    )
  })
})
