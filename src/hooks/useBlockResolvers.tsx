/**
 * useBlockResolvers — context-backed lookup table for block / tag display
 * data resolved at render time.
 *
 * `resolveBlockTitle`, `resolveTagName`, `resolveBlockStatus`, and
 * `resolveTagStatus` were drilled verbatim from BlockTree all the way
 * down to EditableBlock, mirroring the per-block action chain.
 * `BlockResolversProvider` publishes them once so descendants can call
 * `useBlockResolvers()` instead of accepting four near-identical props
 * (MAINT-118).
 *
 * Outside a provider, the hook returns `null`. Consumers that mix prop
 * + context pass-through use `propX ?? ctx?.x`, preserving the
 * pre-context semantics where an unset callback was simply `undefined`.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext } from 'react'

/**
 * Block-tree display resolvers. All four are required at the provider
 * boundary: components that render references / tags expect a non-null
 * callback to call.
 */
export interface BlockResolvers {
  resolveBlockTitle: (id: string) => string
  resolveTagName: (id: string) => string
  resolveBlockStatus: (id: string) => 'active' | 'deleted'
  resolveTagStatus: (id: string) => 'active' | 'deleted'
}

const BlockResolversContext = createContext<BlockResolvers | null>(null)

interface ProviderProps {
  /** The resolver bag to publish to descendants. */
  value: BlockResolvers
  children: ReactNode
}

/**
 * Publish the resolver bag to descendants. The `value` reference should
 * be memoised by the caller.
 */
export function BlockResolversProvider({ value, children }: ProviderProps): ReactElement {
  return <BlockResolversContext.Provider value={value}>{children}</BlockResolversContext.Provider>
}

/**
 * Read the published resolver bag. Returns `null` when no provider
 * wraps the consumer; callers that accept resolvers as both props and
 * context use `propResolver ?? useBlockResolvers()?.resolveX`.
 */
export function useBlockResolvers(): BlockResolvers | null {
  return useContext(BlockResolversContext)
}
