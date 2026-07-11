import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { clearEmojiRecents, pushEmojiRecent } from '@/hooks/useEmojiRecents'

import { EmojiPicker } from '../EmojiPicker'

// jsdom/happy-dom collapse the zero-height scroll container to zero virtual
// rows. Use the shared virtualizer mock, but render only a bounded window of
// rows (like the real virtualizer) so the full ~1900-emoji set doesn't mount
// 1900 buttons per render and grind the suite to a halt. The window is wide
// enough to include the first few category headers; tests that need a
// far-down emoji (e.g. rocket) search for it first. `getTotalSize` still
// reflects the full count so the spacer height stays honest.
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: 80 }))

beforeEach(() => {
  localStorage.clear()
  clearEmojiRecents()
  localStorage.clear()
})

afterEach(() => {
  clearEmojiRecents()
  localStorage.clear()
})

describe('<EmojiPicker>', () => {
  it('renders the search input and a skin-tone radiogroup', () => {
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(screen.getByRole('searchbox', { name: /search emoji/i })).toBeInTheDocument()
    const radiogroup = screen.getByRole('radiogroup', { name: /skin tone/i })
    expect(within(radiogroup).getAllByRole('radio')).toHaveLength(6)
  })

  it('renders the categorized grid with group headers', () => {
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(screen.getByRole('grid', { name: /emoji/i })).toBeInTheDocument()
    // The first group appears twice: the inline header row and the sticky pin.
    expect(screen.getAllByText('Smileys & Emotion').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('People & Body')).toBeInTheDocument()
  })

  it('pins the current group as a sticky label, hidden while searching', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(screen.getByTestId('emoji-sticky-group')).toHaveTextContent('Smileys & Emotion')
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'rocket')
    expect(screen.queryByTestId('emoji-sticky-group')).not.toBeInTheDocument()
  })

  it('roves focus across grid cells with arrow keys and selects with Enter', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
    const grid = screen.getByRole('grid', { name: /emoji/i })
    const cells = within(grid).getAllByRole('gridcell')
    // Exactly one cell is tabbable (roving tabindex); it's the first emoji.
    const tabbable = cells.filter((c) => c.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toHaveAttribute('aria-label', 'grinning')

    tabbable[0]?.focus()
    await user.keyboard('{ArrowRight}')
    // Focus moved to the next cell, which is now the sole tabbable one.
    const nowTabbable = within(grid)
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('tabindex') === '0')
    expect(nowTabbable).toHaveLength(1)
    expect(nowTabbable[0]).toHaveFocus()
    // Enter on the focused button selects it natively.
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('fires onSelect with the chosen emoji char', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
    // rocket lives in the Travel group (far down the full set); search to it.
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'rocket')
    await user.click(screen.getByRole('gridcell', { name: 'rocket' }))
    expect(onSelect).toHaveBeenCalledWith('\u{1F680}')
  })

  it('filters the grid by search query', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'rocket')
    expect(screen.getByRole('gridcell', { name: 'rocket' })).toBeInTheDocument()
    expect(screen.queryByRole('gridcell', { name: 'grinning' })).not.toBeInTheDocument()
    // Search results have no category headers.
    expect(screen.queryByText('Smileys & Emotion')).not.toBeInTheDocument()
  })

  it('applies the selected skin tone to a tonable emoji', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
    await user.click(screen.getByRole('radio', { name: /^dark$/i }))
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'thumbsup')
    await user.click(screen.getByRole('gridcell', { name: 'thumbsup' }))
    expect(onSelect).toHaveBeenCalledWith('\u{1F44D}\u{1F3FF}')
  })

  it('does not tone an emoji that lacks skin-tone support', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
    await user.click(screen.getByRole('radio', { name: /^dark$/i }))
    await user.click(screen.getByRole('gridcell', { name: 'grinning' }))
    expect(onSelect).toHaveBeenCalledWith('\u{1F600}')
  })

  it('shows a Frequently Used toolbar when there is history and inserts from it', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    pushEmojiRecent('\u{1F525}')
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
    // #2545: the frequent strip is a labelled toolbar of plain buttons, not an
    // orphaned grid row/gridcell (which would violate aria-required-parent).
    const frequentToolbar = screen.getByRole('toolbar', { name: /frequently used emoji/i })
    const cell = within(frequentToolbar).getByRole('button', { name: '\u{1F525}' })
    await user.click(cell)
    expect(onSelect).toHaveBeenCalledWith('\u{1F525}')
  })

  // #2545: the frequent toolbar exposes a single tab stop and moves focus with
  // Arrow/Home/End, mirroring the tablist + skin-tone radiogroup.
  it('roves focus across frequent-emoji buttons with arrow keys (single tab stop)', async () => {
    const user = userEvent.setup()
    pushEmojiRecent('\u{1F525}')
    pushEmojiRecent('\u{1F600}')
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    const toolbar = screen.getByRole('toolbar', { name: /frequently used emoji/i })
    const buttons = within(toolbar).getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1)

    buttons[0]?.focus()
    await user.keyboard('{ArrowRight}')
    expect(buttons[1]).toHaveFocus()
    expect(
      within(toolbar)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('tabindex') === '0'),
    ).toHaveLength(1)
    await user.keyboard('{Home}')
    expect(buttons[0]).toHaveFocus()
  })

  it('hides the Frequently Used toolbar while searching', async () => {
    const user = userEvent.setup()
    pushEmojiRecent('\u{1F525}')
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(screen.getByRole('toolbar', { name: /frequently used emoji/i })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'rocket')
    expect(
      screen.queryByRole('toolbar', { name: /frequently used emoji/i }),
    ).not.toBeInTheDocument()
  })

  it('renders a category tab per emoji group and jumps the grid on click', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    const tablist = screen.getByRole('tablist', { name: /emoji categories/i })
    // One tab per CLDR group (9), each with a non-empty accessible name + icon.
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs).toHaveLength(9)
    expect(within(tablist).getByRole('tab', { name: 'Smileys & Emotion' })).toBeInTheDocument()
    // Clicking a later category is a no-throw jump (jsdom has no real scroll).
    await user.click(within(tablist).getByRole('tab', { name: 'Flags' }))
  })

  // #2057: the tablist declares role="tablist" (promising arrow-key roving);
  // it must expose a single tab stop and move focus with Arrow/Home/End.
  it('roves focus across category tabs with arrow keys (single tab stop)', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    const tablist = screen.getByRole('tablist', { name: /emoji categories/i })
    const tabs = within(tablist).getAllByRole('tab')
    // Exactly one tab is tabbable (roving tabindex).
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1)

    tabs[0]?.focus()
    expect(tabs[0]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(tabs[1]).toHaveFocus()
    expect(
      within(tablist)
        .getAllByRole('tab')
        .filter((t) => t.getAttribute('tabindex') === '0'),
    ).toHaveLength(1)
    await user.keyboard('{End}')
    expect(tabs.at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(tabs[0]).toHaveFocus()
  })

  // #2057: the skin-tone radiogroup must rove with Arrow/Home/End and keep a
  // single tab stop, mirroring the tablist + emoji grid.
  it('roves focus across skin-tone swatches with arrow keys (single tab stop)', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    const radiogroup = screen.getByRole('radiogroup', { name: /skin tone/i })
    const radios = within(radiogroup).getAllByRole('radio')
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)

    radios[0]?.focus()
    await user.keyboard('{ArrowRight}')
    expect(radios[1]).toHaveFocus()
    expect(
      within(radiogroup)
        .getAllByRole('radio')
        .filter((r) => r.getAttribute('tabindex') === '0'),
    ).toHaveLength(1)
    await user.keyboard('{End}')
    expect(radios.at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(radios[0]).toHaveFocus()
  })

  // #2057: interactive controls on coarse pointers must hit the 44px floor.
  it('applies coarse-pointer touch-target size classes to tabs, swatches, and emoji cells', () => {
    pushEmojiRecent('\u{1F525}')
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    const tab = within(screen.getByRole('tablist', { name: /emoji categories/i })).getAllByRole(
      'tab',
    )[0]
    expect(tab?.className).toContain('[@media(pointer:coarse)]:size-11')
    expect(tab?.className).toContain('touch-target')

    const radio = within(screen.getByRole('radiogroup', { name: /skin tone/i })).getAllByRole(
      'radio',
    )[0]
    expect(radio?.className).toContain('[@media(pointer:coarse)]:size-11')
    expect(radio?.className).toContain('touch-target')

    const cell = within(screen.getByRole('grid', { name: /emoji/i })).getAllByRole('gridcell')[0]
    expect(cell?.className).toContain('[@media(pointer:coarse)]:size-11')
    expect(cell?.className).toContain('touch-target')
  })

  it('hides the category strip while searching', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(screen.getByRole('tablist', { name: /emoji categories/i })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'rocket')
    expect(screen.queryByRole('tablist', { name: /emoji categories/i })).not.toBeInTheDocument()
  })

  it('shows a "no results" message for a query that matches nothing', async () => {
    const user = userEvent.setup()
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'zzzzznotanemojizzzz')
    expect(screen.getByTestId('emoji-no-results')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    // The grid is virtualized: `useVirtualizer`'s layout effects
    // (`getVirtualItems` / `measureElement`) commit AFTER the first paint, so
    // the gridcell buttons mount one tick later. Auditing `container`
    // synchronously races that commit — under full-suite worker contention axe
    // can begin traversing the tree while the virtualizer is still inserting
    // rows, and axe-core throws mid-walk (the intermittent STACK_TRACE_ERROR,
    // which surfaces as an audit failure rather than a real violation). Wait
    // for the grid's content to settle (first emoji cell present) before
    // auditing the now-stable DOM.
    await screen.findByRole('gridcell', { name: 'grinning' })
    expect(await axe(container)).toHaveNoViolations()
  })

  // #2545: the showFrequent branch only renders when recents exist. The prior
  // axe test rendered with an empty history, so the frequent strip's ARIA was
  // never audited — which is exactly where the orphaned role="row"/"gridcell"
  // (aria-required-parent) violation hid. Seed recents so the branch is covered.
  it('has no axe violations with a seeded Frequently Used toolbar', async () => {
    pushEmojiRecent('\u{1F525}')
    const { container } = render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    // Ensure the frequent toolbar rendered before auditing.
    screen.getByRole('toolbar', { name: /frequently used emoji/i })
    await screen.findByRole('gridcell', { name: 'grinning' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
