import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { QueryControlsBarProps } from '../QueryControlsBar'
import { QueryControlsBar } from '../QueryControlsBar'

const noop = (): void => {}

const baseProps: QueryControlsBarProps = {
  fulltext: '',
  onFulltextChange: noop,
  sort: [],
  onSortChange: noop,
  groupBy: null,
  onGroupByChange: noop,
  aggregates: [],
  onAggregatesChange: noop,
}

describe('QueryControlsBar', () => {
  it('re-syncs the full-text input when the committed prop changes (e.g. a space switch)', () => {
    const { rerender } = render(<QueryControlsBar {...baseProps} fulltext="hello" />)
    const input = screen.getByTestId('advanced-query-fulltext') as HTMLInputElement
    expect(input.value).toBe('hello')

    // A space switch resets the committed `fulltext` to the new space's value.
    // Without the sync effect the input would keep showing the stale 'hello'
    // while the query sends nothing — the bug this guards against.
    rerender(<QueryControlsBar {...baseProps} fulltext="" />)
    expect(input.value).toBe('')

    rerender(<QueryControlsBar {...baseProps} fulltext="world" />)
    expect(input.value).toBe('world')
  })
})
