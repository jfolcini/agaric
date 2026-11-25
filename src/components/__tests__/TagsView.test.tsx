/**
 * Tests for the `TagsView` component — extracted from the inline `tags`
 * branch of `ViewDispatcher` (#1649).
 *
 * Pins the composition contract: TagsView renders the tag browser
 * (`TagList`) and forwards its `onTagClick` prop through to it.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TagsView } from '@/components/TagsView'

// TagList is mocked: this test pins composition + wiring, not its internals
// (which have their own suite).
vi.mock('@/components/TagList', () => ({
  TagList: ({ onTagClick }: { onTagClick: (id: string, name: string) => void }) => (
    <button type="button" data-testid="tag-list-mock" onClick={() => onTagClick('T1', 'work')}>
      tag-list
    </button>
  ),
}))

describe('TagsView', () => {
  it('renders TagList', () => {
    render(<TagsView onTagClick={vi.fn()} />)
    expect(screen.getByTestId('tag-list-mock')).toBeInTheDocument()
  })

  it('forwards onTagClick through to TagList', async () => {
    const onTagClick = vi.fn()
    render(<TagsView onTagClick={onTagClick} />)
    screen.getByTestId('tag-list-mock').click()
    expect(onTagClick).toHaveBeenCalledWith('T1', 'work')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TagsView onTagClick={vi.fn()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
