import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { clearEmojiRecents, pushEmojiRecent } from '@/hooks/useEmojiRecents'

import { EmojiPicker } from '../EmojiPicker'

// jsdom/happy-dom collapse the zero-height scroll container to zero virtual
// rows; mirror the PageBrowser/AgendaResults mock so every row renders and
// content/role queries see the full grid.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const sizes = Array.from({ length: opts.count }, (_, i) => opts.estimateSize(i))
    let start = 0
    const items = sizes.map((size, index) => {
      const item = { index, key: index, start, size, end: start + size }
      start += size
      return item
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => start,
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
      measureElement: vi.fn(),
    }
  },
}))

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
    expect(screen.getByText('Smileys & Emotion')).toBeInTheDocument()
    expect(screen.getByText('Gestures & Body')).toBeInTheDocument()
  })

  it('fires onSelect with the chosen emoji char', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<EmojiPicker onSelect={onSelect} autoFocusSearch={false} />)
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
    expect(await axe(container)).toHaveNoViolations()
  })
})
