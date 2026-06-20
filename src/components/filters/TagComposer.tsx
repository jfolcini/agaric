/**
 * TagComposer — a nested boolean tag-query builder (#1426).
 *
 * Surfaces the backend's full nested tag-expression capability, now reachable
 * over IPC via `query_by_tag_expr` / `queryByTagExpr` (#1472): groups combine
 * their children with an `All` (And) / `Any` (Or) combinator, every node (leaf
 * or group) can be negated (`Not`), and groups nest arbitrarily — so a user can
 * compose `(A AND B) OR (NOT C)`.
 *
 * The component is a thin controlled view over a {@link TagBuilderGroup} tree:
 * every edit dispatches a callback; the parent panel compiles the tree to a
 * {@link TagExpr} with `compileTagExpr` (`@/lib/tagExpr`) and runs it through
 * `queryByTagExpr`. What the user sees is exactly the tree the resolver
 * evaluates — no flattening or dropped structure.
 */

import { Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchInput } from '@/components/ui/search-input'
import {
  type TagBuilderGroup,
  type TagBuilderLeaf,
  type TagBuilderOp,
  addChild,
  emptyTagBuilder,
  makeGroup,
  makePrefixLeaf,
  makeTagLeaf,
  removeNode,
  setGroupOp,
  toggleNegated,
} from '@/lib/tagExpr'
import { listTagsByPrefix } from '@/lib/tauri'
import { cn } from '@/lib/utils'

export interface TagComposerCallbacks {
  /** Append a resolved tag leaf to the group `groupId`. */
  onAddTag: (groupId: number, tagId: string, name: string) => void
  /** Append a prefix leaf to the group `groupId`. */
  onAddPrefix: (groupId: number, prefix: string) => void
  /** Append a fresh empty sub-group to the group `groupId`. */
  onAddGroup: (groupId: number) => void
  /** Remove the node `nodeId` from anywhere in the tree. */
  onRemoveNode: (nodeId: number) => void
  /** Set the All/Any combinator of the group `groupId`. */
  onSetOp: (groupId: number, op: TagBuilderOp) => void
  /** Toggle the `Not` flag of any node `nodeId`. */
  onToggleNegated: (nodeId: number) => void
}

/**
 * Owns the composer's root group tree + all of its edit callbacks (#1426).
 * `root` is `null` while the composer is closed (so the panel runs its flat
 * simple-mode default).
 */
export function useTagComposerState(): {
  root: TagBuilderGroup | null
  callbacks: TagComposerCallbacks
  toggle: () => void
} {
  const [root, setRoot] = useState<TagBuilderGroup | null>(null)

  const onAddTag = useCallback((groupId: number, tagId: string, name: string) => {
    setRoot((r) => (r ? addChild(r, groupId, makeTagLeaf(tagId, name)) : r))
  }, [])
  const onAddPrefix = useCallback((groupId: number, prefix: string) => {
    setRoot((r) => (r ? addChild(r, groupId, makePrefixLeaf(prefix)) : r))
  }, [])
  const onAddGroup = useCallback((groupId: number) => {
    setRoot((r) => (r ? addChild(r, groupId, makeGroup('and')) : r))
  }, [])
  const onRemoveNode = useCallback((nodeId: number) => {
    setRoot((r) => (r ? removeNode(r, nodeId) : r))
  }, [])
  const onSetOp = useCallback((groupId: number, op: TagBuilderOp) => {
    setRoot((r) => (r ? setGroupOp(r, groupId, op) : r))
  }, [])
  const onToggleNegated = useCallback((nodeId: number) => {
    setRoot((r) => (r ? toggleNegated(r, nodeId) : r))
  }, [])
  const toggle = useCallback(() => {
    setRoot((r) => (r == null ? emptyTagBuilder() : null))
  }, [])

  const callbacks = useMemo<TagComposerCallbacks>(
    () => ({ onAddTag, onAddPrefix, onAddGroup, onRemoveNode, onSetOp, onToggleNegated }),
    [onAddTag, onAddPrefix, onAddGroup, onRemoveNode, onSetOp, onToggleNegated],
  )

  return { root, callbacks, toggle }
}

/** All/Any combinator — a 2-way segmented radiogroup over a group's `op`. */
function OpToggle({
  op,
  onSetOp,
}: {
  op: TagBuilderOp
  onSetOp: (op: TagBuilderOp) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const options: { value: TagBuilderOp; label: string }[] = [
    { value: 'and', label: t('tagFilter.composer.opAnd') },
    { value: 'or', label: t('tagFilter.composer.opOr') },
  ]
  return (
    <div
      className="inline-flex rounded-md border"
      role="radiogroup"
      aria-label={t('tagFilter.composer.opLabel')}
    >
      {options.map(({ value, label }) => {
        const selected = op === value
        return (
          <button
            key={value}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a real radio <input> can't render as a flush segmented-toggle button; the radiogroup/radio/aria-checked semantics are explicit and accessible
            role="radio"
            aria-checked={selected}
            aria-label={label}
            onClick={() => onSetOp(value)}
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

/** A tag or prefix leaf rendered as a removable pill with a NOT toggle. */
function LeafChip({
  leaf,
  onRemoveNode,
  onToggleNegated,
}: {
  leaf: TagBuilderLeaf
  onRemoveNode: (id: number) => void
  onToggleNegated: (id: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const label =
    leaf.kind === 'tag'
      ? leaf.name
      : t('tagFilter.composer.prefixLeafLabel', { prefix: leaf.prefix })
  return (
    <li className="inline-flex items-center gap-1" data-testid="tag-composer-leaf">
      <button
        type="button"
        aria-pressed={leaf.negated}
        aria-label={t('tagFilter.composer.negateLeaf', { label })}
        onClick={() => onToggleNegated(leaf.id)}
        className={cn(
          'h-6 rounded-md border px-1.5 text-xs font-medium focus-ring-visible',
          leaf.negated
            ? 'bg-destructive/15 text-destructive border-destructive/40'
            : 'bg-background text-muted-foreground hover:bg-accent',
        )}
      >
        {t('tagFilter.composer.notLabel')}
      </button>
      <FilterPill
        label={label}
        onRemove={() => onRemoveNode(leaf.id)}
        removeAriaLabel={t('tagFilter.composer.removeLeaf', { label })}
        groupAriaLabel={label}
      />
    </li>
  )
}

/** Typeahead popover that resolves a tag prefix and adds tag/prefix leaves. */
function AddTagPopover({
  onAddTag,
  onAddPrefix,
}: {
  onAddTag: (tagId: string, name: string) => void
  onAddPrefix: (prefix: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ tag_id: string; name: string; usage_count: number }[]>(
    [],
  )

  async function search(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) {
      setMatches([])
      return
    }
    try {
      const tags = await listTagsByPrefix({ prefix: trimmed })
      setMatches(
        tags.map((tg) => ({ tag_id: tg.tag_id, name: tg.name, usage_count: tg.usage_count })),
      )
    } catch {
      setMatches([])
    }
  }

  function reset(): void {
    setQuery('')
    setMatches([])
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t('tagFilter.composer.addTag')}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('tagFilter.composer.addTag')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-2" align="start">
        <div className="flex items-center gap-2">
          <SearchInput
            value={query}
            onChange={(e) => {
              const v = e.target.value
              setQuery(v)
              void search(v)
            }}
            placeholder={t('tagFilter.composer.searchPlaceholder')}
            aria-label={t('tagFilter.composer.searchLabel')}
            className="flex-1"
          />
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>

        {/* Add the typed text as a prefix leaf. */}
        {query.trim().length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full justify-start"
            onClick={() => {
              onAddPrefix(query.trim())
              reset()
            }}
          >
            {t('tagFilter.composer.addPrefixOption', { prefix: query.trim() })}
          </Button>
        )}

        {/* Resolved tag matches. */}
        {matches.length > 0 && (
          <ul className="m-0 max-h-48 list-none space-y-0.5 overflow-y-auto p-0">
            {matches.map((tag) => (
              <li key={tag.tag_id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-full justify-between"
                  onClick={() => {
                    onAddTag(tag.tag_id, tag.name)
                    reset()
                  }}
                >
                  <span className="truncate">{tag.name}</span>
                  <span className="text-muted-foreground">({tag.usage_count})</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A recursive group node: combinator + NOT + children (leaves and sub-groups). */
function GroupNode({
  group,
  isRoot,
  callbacks,
}: {
  group: TagBuilderGroup
  isRoot: boolean
  callbacks: TagComposerCallbacks
}): React.ReactElement {
  const { t } = useTranslation()
  const { onAddTag, onAddPrefix, onAddGroup, onRemoveNode, onSetOp, onToggleNegated } = callbacks

  return (
    <div
      className="tag-composer-group flex flex-col gap-2 rounded-md border p-2"
      data-testid="tag-composer-group"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> would impose form semantics and break the inline builder layout; role=group is the correct grouping primitive for this composite control
      role="group"
      aria-label={isRoot ? t('tagFilter.composer.rootLabel') : t('tagFilter.composer.groupLabel')}
    >
      {/* Group header: NOT toggle + combinator. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={group.negated}
          aria-label={t('tagFilter.composer.negateGroup')}
          onClick={() => onToggleNegated(group.id)}
          className={cn(
            'h-7 rounded-md border px-2 text-xs font-medium focus-ring-visible',
            group.negated
              ? 'bg-destructive/15 text-destructive border-destructive/40'
              : 'bg-background text-muted-foreground hover:bg-accent',
          )}
        >
          {t('tagFilter.composer.notLabel')}
        </button>
        <span className="text-xs text-muted-foreground">{t('tagFilter.composer.opLabel')}</span>
        <OpToggle op={group.op} onSetOp={(op) => onSetOp(group.id, op)} />
        {!isRoot && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            aria-label={t('tagFilter.composer.removeGroup')}
            onClick={() => onRemoveNode(group.id)}
          >
            {t('tagFilter.composer.removeGroupButton')}
          </Button>
        )}
      </div>

      {/* Children — leaves + sub-groups in order. */}
      {group.children.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground" data-testid="tag-composer-empty">
          {t('tagFilter.composer.emptyGroup')}
        </p>
      ) : (
        <ul className="m-0 flex flex-col gap-2 list-none p-0">
          {group.children.map((child) => (
            <li key={child.id}>
              {child.kind === 'group' ? (
                <GroupNode group={child} isRoot={false} callbacks={callbacks} />
              ) : (
                <ul className="m-0 flex flex-wrap gap-2 list-none p-0">
                  <LeafChip
                    leaf={child}
                    onRemoveNode={onRemoveNode}
                    onToggleNegated={onToggleNegated}
                  />
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Add affordances. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <AddTagPopover
          onAddTag={(tagId, name) => onAddTag(group.id, tagId, name)}
          onAddPrefix={(prefix) => onAddPrefix(group.id, prefix)}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t('tagFilter.composer.addGroup')}
          onClick={() => onAddGroup(group.id)}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('tagFilter.composer.addGroup')}
        </Button>
      </div>
    </div>
  )
}

interface TagComposerProps {
  /** The root group to render. */
  root: TagBuilderGroup
  /** Edit callbacks (from {@link useTagComposerState}). */
  callbacks: TagComposerCallbacks
}

export function TagComposer({ root, callbacks }: TagComposerProps): React.ReactElement {
  return <GroupNode group={root} isRoot callbacks={callbacks} />
}
