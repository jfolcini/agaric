/**
 * HasParentMatchingEditor — the nested mini-builder for the `HasParentMatching`
 * relational leaf (#1478).
 *
 * The `HasParentMatching` primitive's value is itself a nested `FilterExpr`
 * (the predicate the block's PARENT row must satisfy). Rather than invent a
 * second filter UI, this editor REUSES the recursive {@link FilterGroup} builder
 * as a self-contained sub-builder: a local `BuilderGroupNode` held in React
 * state (with its own monotonic id counter, independent of the global
 * `nextAddId`), driven by the same pure tree-edit helpers the per-space store
 * actions use. On Apply it compiles the local tree to a wire `FilterExpr` via
 * `builderTreeToFilterExpr` and hands it back so the parent popover can emit
 * `{ type: 'HasParentMatching', matcher }`.
 *
 * Because the embedded sub-builder carries its own `AddFilterPopover` (which
 * offers the full advanced vocabulary, including `HasParentMatching` again), the
 * parent matcher can nest arbitrarily — the engine bounds the recursion via
 * `FilterExpr::MAX_DEPTH`.
 *
 * Import-cycle note: this editor does NOT import `FilterGroup` directly. Doing so
 * would close the cycle `FilterGroup → AddFilterPopover → HasParentMatchingEditor
 * → FilterGroup` (the `import-cycles` guard counts static AND dynamic edges).
 * Instead the recursive sub-builder is supplied via the `renderBuilder` render
 * prop — `FilterGroup` injects a closure that renders itself, so the recursion
 * happens at runtime, not through an import edge.
 */

import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { FilterExpr, FilterPrimitive } from '@/lib/tauri'
import {
  addGroupToTree,
  addLeafToTree,
  type BuilderGroupNode,
  type BuilderPath,
  builderTreeToFilterExpr,
  makeEmptyRoot,
  removeNodeFromTree,
  setGroupOpInTree,
  toggleNegateInTree,
} from '@/stores/advancedQuery'

/**
 * The props the injected sub-builder closure is called with — the exact subset of
 * `FilterGroupProps` this editor drives. Kept structural (not an import of
 * `FilterGroup`'s prop type) so this module has no edge into `FilterGroup.tsx`.
 */
export interface HasParentBuilderProps {
  node: BuilderGroupNode
  path: BuilderPath
  depth: number
  onAddLeaf: (path: BuilderPath, primitive: FilterPrimitive) => void
  onAddGroup: (path: BuilderPath) => void
  onRemoveNode: (path: BuilderPath) => void
  onSetGroupOp: (path: BuilderPath, op: 'And' | 'Or') => void
  onToggleNegate: (path: BuilderPath) => void
}

export interface HasParentMatchingEditorProps {
  /** Apply: hands back the compiled matcher so the parent emits the leaf. */
  onApply: (matcher: FilterExpr) => void
  /** Back: dismiss the editor without emitting. */
  onBack: () => void
  /**
   * Renders the recursive sub-builder. Injected by `FilterGroup` (a closure that
   * renders `FilterGroup` itself) so this editor never imports `FilterGroup` —
   * breaking the import cycle while keeping the nested-builder UX identical.
   */
  renderBuilder: (props: HasParentBuilderProps) => React.ReactNode
}

export function HasParentMatchingEditor({
  onApply,
  onBack,
  renderBuilder,
}: HasParentMatchingEditorProps): React.ReactElement {
  const { t } = useTranslation()
  // Local, self-contained matcher tree. Seeded with a root `And` group whose id
  // is 0 (children start at the local counter's first issue, 1).
  const [tree, setTree] = useState<BuilderGroupNode>(() => makeEmptyRoot(0))
  // Local monotonic id counter, independent of the global store's `nextAddId`
  // (matcher node ids only need uniqueness WITHIN this sub-tree; they compile
  // away). Starts at 0; each add issues `++`.
  const nextId = useRef(0)

  const handleAddLeaf = useCallback((path: BuilderPath, primitive: FilterPrimitive) => {
    nextId.current += 1
    setTree((prev) => addLeafToTree(prev, path, primitive, nextId.current))
  }, [])
  const handleAddGroup = useCallback((path: BuilderPath) => {
    nextId.current += 1
    setTree((prev) => addGroupToTree(prev, path, nextId.current))
  }, [])
  const handleRemoveNode = useCallback((path: BuilderPath) => {
    setTree((prev) => removeNodeFromTree(prev, path))
  }, [])
  const handleSetGroupOp = useCallback((path: BuilderPath, op: 'And' | 'Or') => {
    setTree((prev) => setGroupOpInTree(prev, path, op))
  }, [])
  const handleToggleNegate = useCallback((path: BuilderPath) => {
    setTree((prev) => toggleNegateInTree(prev, path))
  }, [])

  // Gate Apply on a non-empty matcher: an empty `And{[]}` parent matcher is the
  // TRUE expression ("parent exists"), which is a no-op the user almost never
  // means; require at least one condition so the affordance can't silently emit
  // a vacuous leaf.
  const canApply = tree.children.length > 0

  const handleApply = useCallback(() => {
    if (tree.children.length === 0) return
    onApply(builderTreeToFilterExpr(tree))
  }, [tree, onApply])

  return (
    <div className="flex flex-col gap-2" data-testid="has-parent-matching-editor">
      <span className="px-1 text-xs font-medium">
        {t('pageBrowser.filter.hasParentMatchingLabel')}
      </span>
      <span className="px-1 text-xs text-muted-foreground">
        {t('pageBrowser.filter.hasParentMatchingHint')}
      </span>
      {renderBuilder({
        node: tree,
        path: [],
        depth: 0,
        onAddLeaf: handleAddLeaf,
        onAddGroup: handleAddGroup,
        onRemoveNode: handleRemoveNode,
        onSetGroupOp: handleSetGroupOp,
        onToggleNegate: handleToggleNegate,
      })}
      {!canApply && (
        <span className="px-1 text-xs text-muted-foreground" data-testid="has-parent-empty-hint">
          {t('pageBrowser.filter.hasParentMatchingEmpty')}
        </span>
      )}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {t('pageBrowser.filter.back')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleApply}
          disabled={!canApply}
          aria-disabled={!canApply}
        >
          {t('pageBrowser.filter.apply')}
        </Button>
      </div>
    </div>
  )
}
