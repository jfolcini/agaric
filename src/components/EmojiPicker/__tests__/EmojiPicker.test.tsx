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

  it('shows a Recents row when there is history and inserts from it', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    pushEmojiRecent('\u{1F525}')
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
    const recentsRow = screen.getByRole('row', { name: /recently used emoji/i })
    const cell = within(recentsRow).getByRole('gridcell', { name: '\u{1F525}' })
    await user.click(cell)
    expect(onSelect).toHaveBeenCalledWith('\u{1F525}')
  })

  it('hides the Recents row while searching', async () => {
    const user = userEvent.setup()
    pushEmojiRecent('\u{1F525}')
    render(<EmojiPicker onSelect={vi.fn()} autoFocusSearch={false} />)
    expect(screen.getByRole('row', { name: /recently used emoji/i })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: /search emoji/i }), 'rocket')
    expect(screen.queryByRole('row', { name: /recently used emoji/i })).not.toBeInTheDocument()
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
})
