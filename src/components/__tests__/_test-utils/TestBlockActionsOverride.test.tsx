/**
 * Tests for the `TestBlockActionsOverride` wrapper (PEND-30 D-1).
 *
 * The wrapper publishes action / resolver bags through
 * `BlockActionsContext` / `BlockResolversContext` so SortableBlock and
 * its descendants can read them without prop drilling.
 *
 * These tests verify that:
 *  - `useBlockActions()` reads the wrapper's `actions` value.
 *  - `useBlockResolvers()` reads the wrapper's `resolvers` value.
 *  - Omitting both still publishes an empty actions bag and `null` resolvers
 *    (matches outside-of-provider behaviour for resolvers).
 *  - A consumer rendered without any `BlockActionsProvider` wrapper sees
 *    the no-op fallback (`useBlockActions()` returns the frozen empty
 *    object; `useBlockResolvers()` returns `null`) — this is the
 *    documented behaviour the production code relies on for graceful
 *    degradation.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  type BlockActions,
  BlockActionsProvider,
  useBlockActions,
} from '../../../hooks/useBlockActions'
import { type BlockResolvers, useBlockResolvers } from '../../../hooks/useBlockResolvers'
import { TestBlockActionsOverride } from './TestBlockActionsOverride'

function ActionsProbe(): React.ReactElement {
  const actions = useBlockActions()
  return (
    <button
      type="button"
      data-testid="probe"
      data-has-on-delete={actions.onDelete ? 'yes' : 'no'}
      onClick={() => actions.onDelete?.('BLOCK_X')}
    >
      probe
    </button>
  )
}

function ResolversProbe(): React.ReactElement {
  const resolvers = useBlockResolvers()
  return (
    <div
      data-testid="resolver-probe"
      data-has-resolvers={resolvers ? 'yes' : 'no'}
      data-title={resolvers?.resolveBlockTitle('BLOCK_1') ?? ''}
    />
  )
}

describe('TestBlockActionsOverride', () => {
  it('publishes the actions bag through BlockActionsContext', () => {
    const onDelete = vi.fn()
    render(
      <TestBlockActionsOverride actions={{ onDelete }}>
        <ActionsProbe />
      </TestBlockActionsOverride>,
    )
    const probe = screen.getByTestId('probe')
    expect(probe.dataset['hasOnDelete']).toBe('yes')
    probe.click()
    expect(onDelete).toHaveBeenCalledWith('BLOCK_X')
  })

  it('publishes the resolvers bag through BlockResolversContext', () => {
    const resolvers: BlockResolvers = {
      resolveBlockTitle: (id) => `title-of-${id}`,
      resolveTagName: () => '',
      resolveBlockStatus: () => 'active',
      resolveTagStatus: () => 'active',
    }
    render(
      <TestBlockActionsOverride resolvers={resolvers}>
        <ResolversProbe />
      </TestBlockActionsOverride>,
    )
    const probe = screen.getByTestId('resolver-probe')
    expect(probe.dataset['hasResolvers']).toBe('yes')
    expect(probe.dataset['title']).toBe('title-of-BLOCK_1')
  })

  it('publishes an empty actions bag when `actions` is omitted', () => {
    render(
      <TestBlockActionsOverride>
        <ActionsProbe />
      </TestBlockActionsOverride>,
    )
    expect(screen.getByTestId('probe').dataset['hasOnDelete']).toBe('no')
  })

  it('does not publish a resolver context when `resolvers` is omitted', () => {
    render(
      <TestBlockActionsOverride>
        <ResolversProbe />
      </TestBlockActionsOverride>,
    )
    expect(screen.getByTestId('resolver-probe').dataset['hasResolvers']).toBe('no')
  })

  it('falls back to the empty bag / null when no provider wraps the consumer (regression)', () => {
    // Mounting either probe directly (no provider) must not throw and
    // must observe the no-op fallback — production code relies on this
    // for the "no callbacks wired up yet" rendering path.
    render(<ActionsProbe />)
    expect(screen.getByTestId('probe').dataset['hasOnDelete']).toBe('no')
  })

  it('action overrides take effect even when nested under another provider', () => {
    // Nested providers — the inner `TestBlockActionsOverride` must win
    // over the outer one for descendants below it.
    const outerOnDelete = vi.fn()
    const innerOnDelete = vi.fn()
    const outer: BlockActions = { onDelete: outerOnDelete }
    render(
      <BlockActionsProvider value={outer}>
        <TestBlockActionsOverride actions={{ onDelete: innerOnDelete }}>
          <ActionsProbe />
        </TestBlockActionsOverride>
      </BlockActionsProvider>,
    )
    screen.getByTestId('probe').click()
    expect(innerOnDelete).toHaveBeenCalledOnce()
    expect(outerOnDelete).not.toHaveBeenCalled()
  })
})
