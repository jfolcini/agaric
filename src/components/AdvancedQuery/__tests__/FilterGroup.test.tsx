import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { FilterGroup } from '@/components/AdvancedQuery/FilterGroup'
import type { BuilderGroupNode } from '@/stores/advancedQuery'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const TARGET = '00000000000000000000PAGE02'

const root: BuilderGroupNode = {
  kind: 'group',
  id: 0,
  op: 'And',
  negated: false,
  children: [
    { kind: 'leaf', id: 1, primitive: { type: 'LinksTo', target: TARGET }, negated: false },
  ],
}

function cacheTitle(title: string) {
  useResolveStore.setState({
    cache: new Map([[keyFor(null, TARGET), { title, deleted: false, resolved: true }]]),
    version: useResolveStore.getState().version + 1,
  })
}

beforeEach(() => {
  useSpaceStore.setState({ currentSpaceId: null })
  cacheTitle('Old title')
})

describe('FilterGroup', () => {
  it("follows a leaf's target title when the resolve cache changes it", async () => {
    const { container } = render(
      <FilterGroup
        node={root}
        path={[]}
        depth={0}
        onAddLeaf={vi.fn()}
        onAddGroup={vi.fn()}
        onRemoveNode={vi.fn()}
        onSetGroupOp={vi.fn()}
        onToggleNegate={vi.fn()}
      />,
    )
    const leaf = screen.getByTestId('filter-group-leaf')
    expect(leaf).toHaveTextContent('Old title')

    act(() => cacheTitle('New title'))

    expect(leaf).toHaveTextContent('New title')
    expect(await axe(container)).toHaveNoViolations()
  })
})
