/**
 * Tests for the `TagsView` component — extracted from the inline `tags`
 * branch of `ViewDispatcher` (#1649).
 *
 * Pins the composition contract: TagsView renders the tag browser
 * (`TagList`) and the tag-filter panel (`TagFilterPanel`), forwards its
 * `onTagClick` prop through to `TagList`, and sources the section divider
 * label from i18n rather than a hardcoded literal.
 */

import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TagsView } from '@/components/TagsView'
import { t } from '@/lib/i18n'

// Sub-components are mocked: this test pins composition + wiring, not the
// internals of TagList / TagFilterPanel (which have their own suites).
// The mock renders what TagList shows under its list as if the space has a tag;
// TagList.test.tsx pins that it shows it only then.
vi.mock('@/components/TagList', () => ({
  TagList: ({
    onTagClick,
    children,
  }: {
    onTagClick: (id: string, name: string) => void
    children: ReactNode
  }) => (
    <>
      <button type="button" data-testid="tag-list-mock" onClick={() => onTagClick('T1', 'work')}>
        tag-list
      </button>
      {children}
    </>
  ),
}))
vi.mock('@/components/filters/TagFilterPanel', () => ({
  TagFilterPanel: () => <div data-testid="tag-filter-panel-mock">tag-filter</div>,
}))

describe('TagsView', () => {
  it('composes TagList and TagFilterPanel', () => {
    render(<TagsView onTagClick={vi.fn()} />)
    expect(screen.getByTestId('tag-list-mock')).toBeInTheDocument()
    expect(screen.getByTestId('tag-filter-panel-mock')).toBeInTheDocument()
  })

  it('renders the section divider label from i18n', () => {
    render(<TagsView onTagClick={vi.fn()} />)
    expect(screen.getByText(t('tagFilter.sectionLabel'))).toBeInTheDocument()
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
