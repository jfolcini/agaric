import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { FilterGroup } from '@/components/AdvancedQuery/FilterGroup'
import { t } from '@/lib/i18n'
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

function renderRoot() {
  return render(
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
}

describe('FilterGroup', () => {
  // #6895 — the All / Any and NOT explanations open on a tap, not a hover title.
  it('opens what All and Any mean from the ⓘ beside the toggle', async () => {
    const user = userEvent.setup()
    const { container } = renderRoot()

    await user.click(screen.getByRole('button', { name: t('advancedQuery.builder.opInfoLabel') }))

    const help = await screen.findByRole('dialog', {
      name: t('advancedQuery.builder.opInfoLabel'),
    })
    expect(help).toHaveTextContent(t('advancedQuery.builder.op.andTitle'))
    expect(help).toHaveTextContent(t('advancedQuery.builder.op.orTitle'))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('opens what NOT does from the ⓘ beside the group NOT toggle', async () => {
    const user = userEvent.setup()
    renderRoot()

    await user.click(
      screen.getByRole('button', { name: t('advancedQuery.builder.negateInfoLabel') }),
    )

    expect(
      await screen.findByRole('dialog', { name: t('advancedQuery.builder.negateInfoLabel') }),
    ).toHaveTextContent(t('advancedQuery.builder.negateHelp'))
  })

  it("follows a leaf's target title when the resolve cache changes it", async () => {
    const { container } = renderRoot()
    const leaf = screen.getByTestId('filter-group-leaf')
    expect(leaf).toHaveTextContent('Old title')

    act(() => cacheTitle('New title'))

    expect(leaf).toHaveTextContent('New title')
    expect(await axe(container)).toHaveNoViolations()
  })
})
