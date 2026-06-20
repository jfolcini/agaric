/**
 * TestBlockActionsOverride — test escape hatch for SortableBlock + descendants (D-1).
 *
 * Production code wires per-block action callbacks and reference resolvers
 * via `BlockActionsProvider` / `BlockResolversProvider` at the BlockTree
 * boundary; the rest of the chain (BlockListRenderer → SortableBlockWrapper
 * → SortableBlock → BlockGutterControls / BlockInlineControls /
 * BlockContextMenu / EditableBlock) reads from those contexts.
 *
 * Tests that mount `SortableBlock` standalone used to drill 14 action
 * callbacks + 4 resolvers as props. With the props gone (D-1), tests
 * publish overrides through this wrapper so the same callback gating
 * keeps working without re-introducing the prop chain:
 *
 * ```tsx
 * render(
 *   <TestBlockActionsOverride actions={{ onDelete: vi.fn() }}>
 *     <SortableBlock blockId="X" content="hi" isFocused={false} rovingEditor={...} />
 *   </TestBlockActionsOverride>
 * )
 * ```
 *
 * Both bags are optional. Omitting `actions` publishes an empty object
 * (matches the pre-D-1 "no callbacks wired" behaviour); omitting
 * `resolvers` skips the resolver provider entirely (`useBlockResolvers()`
 * returns `null`, matching production code that calls without resolvers
 * available).
 */

import type { ReactElement, ReactNode } from 'react'

import { type BlockActions, BlockActionsProvider } from '../../../hooks/useBlockActions'
import { type BlockResolvers, BlockResolversProvider } from '../../../hooks/useBlockResolvers'

interface TestBlockActionsOverrideProps {
  /** Action bag published via `BlockActionsProvider`. Defaults to `{}`. */
  actions?: BlockActions
  /** Resolver bag published via `BlockResolversProvider`. Omit to leave the resolver context unset. */
  resolvers?: BlockResolvers
  children: ReactNode
}

/**
 * Wrap children with `BlockActionsProvider` (always) and
 * `BlockResolversProvider` (only when resolvers are supplied) so
 * descendants like `SortableBlock` can read overrides via context.
 */
export function TestBlockActionsOverride({
  actions,
  resolvers,
  children,
}: TestBlockActionsOverrideProps): ReactElement {
  const actionBag = actions ?? EMPTY_ACTIONS
  if (resolvers) {
    return (
      <BlockActionsProvider value={actionBag}>
        <BlockResolversProvider value={resolvers}>{children}</BlockResolversProvider>
      </BlockActionsProvider>
    )
  }
  return <BlockActionsProvider value={actionBag}>{children}</BlockActionsProvider>
}

const EMPTY_ACTIONS: BlockActions = Object.freeze({})
