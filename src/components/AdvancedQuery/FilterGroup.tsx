/**
 * FilterGroup — the recursive nested-boolean filter builder (#1280 D3).
 *
 * Renders one `BuilderGroupNode` from the advanced-query store: an And/Or
 * combinator toggle ("All" / "Any"), a NOT toggle, its ordered children (filter
 * leaves rendered as removable {@link FilterPill} chips, sub-groups rendered by
 * recursing into this same component), and the add affordances — "+ Filter"
 * (reusing the shared {@link AddFilterPopover}) and "+ Group". Each child carries
 * a per-child remove control and nested groups indent visually.
 *
 * The component is a thin, controlled view over the store: every edit dispatches
 * a store action keyed by the node's {@link BuilderPath} (a list of child indices
 * from the root). The compiled wire shape is produced by
 * `builderTreeToFilterExpr` in the store and fed to `useAdvancedQuery` by the
 * parent view — this component never touches the engine.
 */

import { FolderPlus } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { pageFilterSummary } from '@/components/PageBrowser/PageBrowserFilterRow'
import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import type { FilterPrimitive } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import type {
  BuilderGroupNode,
  BuilderLeafNode,
  BuilderNode,
  BuilderPath,
} from '@/stores/advancedQuery'

import { AddFilterPopover } from '../PageBrowser/AddFilterPopover'

/** Append `index` to `path` (a child address relative to a parent path). */
function childPath(path: BuilderPath, index: number): BuilderPath {
  return [...path, index]
}

export interface FilterGroupCallbacks {
  /** Append a leaf primitive as a child of the group at `path`. */
  onAddLeaf: (path: BuilderPath, primitive: FilterPrimitive) => void
  /** Append a fresh empty sub-group as a child of the group at `path`. */
  onAddGroup: (path: BuilderPath) => void
  /** Remove the node at `path` (never called for the root). */
  onRemoveNode: (path: BuilderPath) => void
  /** Set the And/Or combinator of the group at `path`. */
  onSetGroupOp: (path: BuilderPath, op: 'And' | 'Or') => void
  /** Flip the `negated` flag of the node at `path`. */
  onToggleNegate: (path: BuilderPath) => void
}

interface FilterGroupProps extends FilterGroupCallbacks {
  /** The group node to render. */
  node: BuilderGroupNode
  /** This node's path from the root (the root group is `[]`). */
  path: BuilderPath
  /** Nesting depth (0 = root). Drives the visual indent and the root affordances. */
  depth: number
}

/** The And/Or "All"/"Any" segmented toggle for a group's combinator. */
function OpToggle({
  op,
  onSetGroupOp,
  path,
}: {
  op: 'And' | 'Or'
  onSetGroupOp: (path: BuilderPath, op: 'And' | 'Or') => void
  path: BuilderPath
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className="inline-flex rounded-md border"
      role="radiogroup"
      aria-label={t('advancedQuery.builder.opLabel')}
    >
      {(['And', 'Or'] as const).map((value) => {
        const selected = op === value
        const label =
          value === 'And' ? t('advancedQuery.builder.op.and') : t('advancedQuery.builder.op.or')
        const title =
          value === 'And'
            ? t('advancedQuery.builder.op.andTitle')
            : t('advancedQuery.builder.op.orTitle')
        return (
          <button
            key={value}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a real radio <input> can't render as a flush segmented-toggle button; the radiogroup/radio/aria-checked semantics are explicit and accessible
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={title}
            onClick={() => onSetGroupOp(path, value)}
            className={cn(
              'h-7 px-2.5 text-xs first:rounded-l-md last:rounded-r-md focus-ring-visible',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** A single leaf chip with its NOT toggle and remove control. */
function LeafChip({
  node,
  path,
  onRemoveNode,
  onToggleNegate,
}: {
  node: BuilderLeafNode
  path: BuilderPath
  onRemoveNode: (path: BuilderPath) => void
  onToggleNegate: (path: BuilderPath) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const label = pageFilterSummary(node.primitive, t)
  const kind = t('advancedQuery.builder.kindLeaf')
  return (
    <li className="inline-flex items-center gap-1" data-testid="filter-group-leaf">
      <NegateToggle negated={node.negated} kind={kind} onClick={() => onToggleNegate(path)} />
      <FilterPill
        label={label}
        onRemove={() => onRemoveNode(path)}
        removeAriaLabel={t('advancedQuery.builder.removeNode', { kind })}
        groupAriaLabel={label}
      />
    </li>
  )
}

/** The NOT toggle shared by leaves and groups. */
function NegateToggle({
  negated,
  kind,
  onClick,
}: {
  negated: boolean
  kind: string
  onClick: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-pressed={negated}
      aria-label={t('advancedQuery.builder.negate')}
      title={
        negated
          ? t('advancedQuery.builder.negateOnTitle', { kind })
          : t('advancedQuery.builder.negateTitle', { kind })
      }
      onClick={onClick}
      className={cn(
        'h-7 rounded-md border px-1.5 text-[10px] font-semibold uppercase leading-none focus-ring-visible',
        negated
          ? 'border-destructive bg-destructive text-white'
          : 'bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {t('advancedQuery.builder.negate')}
    </button>
  )
}

export function FilterGroup({
  node,
  path,
  depth,
  onAddLeaf,
  onAddGroup,
  onRemoveNode,
  onSetGroupOp,
  onToggleNegate,
}: FilterGroupProps): React.ReactElement {
  const { t } = useTranslation()
  const isRoot = depth === 0
  const kind = t('advancedQuery.builder.kindGroup')

  return (
    <div
      className={cn(
        'filter-group flex flex-col gap-2 rounded-md border p-2',
        depth > 0 && 'ml-3 border-l-2 bg-muted/30',
      )}
      data-testid="filter-group"
      data-depth={depth}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset>/<details> would impose form/disclosure semantics and break the inline builder layout; role=group is the correct grouping primitive for this composite control
      role="group"
      aria-label={
        isRoot ? t('advancedQuery.builder.rootLabel') : t('advancedQuery.builder.groupLabel')
      }
    >
      {/* Group header — combinator + NOT (+ remove for non-root). */}
      <div className="flex flex-wrap items-center gap-2">
        <NegateToggle negated={node.negated} kind={kind} onClick={() => onToggleNegate(path)} />
        <OpToggle op={node.op} onSetGroupOp={onSetGroupOp} path={path} />
        {!isRoot && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onRemoveNode(path)}
            aria-label={t('advancedQuery.builder.removeNode', { kind })}
          >
            {t('advancedQuery.builder.removeNode', { kind })}
          </Button>
        )}
      </div>

      {/* Children — leaves and nested groups, intermixed in order. */}
      {node.children.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground" data-testid="filter-group-empty">
          {t('advancedQuery.builder.emptyGroup')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 list-none m-0 p-0">
          {node.children.map((child: BuilderNode, index) => {
            const cp = childPath(path, index)
            if (child.kind === 'leaf') {
              return (
                <LeafChip
                  key={child.id}
                  node={child}
                  path={cp}
                  onRemoveNode={onRemoveNode}
                  onToggleNegate={onToggleNegate}
                />
              )
            }
            return (
              <li key={child.id} className="contents">
                <FilterGroup
                  node={child}
                  path={cp}
                  depth={depth + 1}
                  onAddLeaf={onAddLeaf}
                  onAddGroup={onAddGroup}
                  onRemoveNode={onRemoveNode}
                  onSetGroupOp={onSetGroupOp}
                  onToggleNegate={onToggleNegate}
                />
              </li>
            )
          })}
        </ul>
      )}

      {/* Add affordances. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <AddFilterPopover
          onAddFilter={(primitive) => onAddLeaf(path, primitive)}
          hidePagesFacets
          showAdvancedFacets
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onAddGroup(path)}
          aria-label={t('advancedQuery.builder.addGroup')}
        >
          <FolderPlus className="h-3 w-3" aria-hidden="true" />
          {t('advancedQuery.builder.addGroup')}
        </Button>
      </div>
    </div>
  )
}
