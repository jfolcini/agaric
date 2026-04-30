/**
 * useBlockActions — context-backed registry of per-block action callbacks.
 *
 * BlockTree drilled 14 callbacks down through BlockListRenderer →
 * SortableBlockWrapper → SortableBlock and ultimately into
 * BlockGutterControls / BlockInlineControls / BlockContextMenu /
 * EditableBlock. Every layer in that chain just forwarded the same
 * functions verbatim, which made every signature change a multi-file
 * mechanical edit and obscured what each layer actually used (MAINT-118).
 *
 * `BlockActionsProvider` publishes the bag of callbacks once (at the
 * BlockTree boundary). Any descendant in the chain reads what it needs
 * via `useBlockActions()` instead of accepting a long list of props.
 *
 * Outside a provider (e.g. isolated component tests that pass callbacks
 * directly), the hook returns an empty object — consumers fall back to
 * any explicit prop or behave as if no callback was wired up. This keeps
 * existing test fixtures working while letting new code skip the boilerplate.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext } from 'react'

/**
 * Per-block action callbacks consumed by SortableBlock's subcomponents.
 *
 * Every entry is optional and explicitly nullable so callers can pass
 * either an omitted key or `undefined` when wiring partial subsets
 * (the codebase runs with `exactOptionalPropertyTypes`). Components
 * that read from this context use truthiness checks
 * (e.g. `actions.onDelete && ...`) to gate UI affordances, matching
 * the pre-context "is the prop set?" behaviour.
 */
export interface BlockActions {
  onNavigate?: ((id: string) => void) | undefined
  onDelete?: ((blockId: string) => void) | undefined
  onIndent?: ((blockId: string) => void) | undefined
  onDedent?: ((blockId: string) => void) | undefined
  onMoveUp?: ((blockId: string) => void) | undefined
  onMoveDown?: ((blockId: string) => void) | undefined
  onMerge?: ((blockId: string) => void) | undefined
  onToggleTodo?: ((blockId: string) => void) | undefined
  onTogglePriority?: ((blockId: string) => void) | undefined
  onToggleCollapse?: ((blockId: string) => void) | undefined
  onShowHistory?: ((blockId: string) => void) | undefined
  onShowProperties?: ((blockId: string) => void) | undefined
  onZoomIn?: ((blockId: string) => void) | undefined
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

const BlockActionsContext = createContext<BlockActions | null>(null)

interface ProviderProps {
  /** The action bag to publish to descendants. */
  value: BlockActions
  children: ReactNode
}

/**
 * Publish the action bag to descendants. The `value` reference should be
 * memoised by the caller so subscribers don't re-render unnecessarily.
 */
export function BlockActionsProvider({ value, children }: ProviderProps): ReactElement {
  return <BlockActionsContext.Provider value={value}>{children}</BlockActionsContext.Provider>
}

/**
 * Read the published action bag. Returns an empty object when used
 * outside a `BlockActionsProvider`, so component code can safely call
 * `actions.onDelete?.(id)` or `if (actions.onZoomIn) ...` without
 * additional null-checks for the registry itself.
 */
export function useBlockActions(): BlockActions {
  return useContext(BlockActionsContext) ?? EMPTY_ACTIONS
}

/** Stable empty object so consumers get a referentially-stable fallback. */
const EMPTY_ACTIONS: BlockActions = Object.freeze({})
