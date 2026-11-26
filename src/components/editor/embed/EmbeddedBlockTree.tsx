/**
 * `EmbeddedBlockTree` — the subtree renderer behind `{{embed …}}` (#4550).
 *
 * Read-only unless the enclosing container has been unlocked, in which case
 * the FOCUSED row — and only that row — renders the host tree's editable row
 * instead (see `embed-row-editor-context.ts`). It still mounts no editor of
 * its own: the host tree's single roving instance roves in.
 *
 * ## Why this is not a nested `BlockTree`
 *
 * `BlockTree` is not re-entrant, for three concrete reasons: it mounts a
 * `DndContext` + `SortableContext` (nested DnD is a project of its own), it
 * registers document-level keyboard listeners whose ownership gates
 * (`storeOwnsBlock`) were designed for SIBLING trees rather than nested ones,
 * and it lazily constructs a ~50-extension TipTap `Editor` per mount — one
 * per embed is not acceptable.
 *
 * So this is a presentational renderer: it reuses `buildFlatTree`'s output
 * and `useRichContent` (the same rich-content path `StaticBlock` uses) and
 * mounts **no editor, no DnD, no document listeners**. It IS re-entrant by
 * construction — an embedded row whose content is itself an `{{embed …}}`
 * token renders another `EmbedContainer`, bounded by `EmbedChainContext`.
 * Structurally that is the same move as `StaticBlock` → `StaticQueryBlock` →
 * `QueryResult`, one level deeper.
 *
 * ## Accessibility
 *
 * A flat `<ul>` of `<li>`s carrying `aria-level` / `aria-setsize` /
 * `aria-posinset`, which is *exactly* the host outline's own shape
 * (`BlockListRenderer` + `SortableBlockWrapper`) — not a `role="tree"`, and
 * not an isolated `role="treeitem"`, because the host outline is not an ARIA
 * tree and a lone `treeitem` under a plain list is itself a violation.
 *
 * The levels are HOST-relative: `baseAriaLevel` is the level of the row the
 * embed sits in, the container occupies the next level, and a re-based row at
 * depth `d` is announced at `baseAriaLevel + 1 + d`. See `host-row-aria.ts`.
 */

import type React from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockProperties } from '@/components/block-tree/use-block-properties'
import { useBlockResolvers } from '@/components/block-tree/use-block-resolvers'
import { BlockMetadataRow } from '@/components/editor/BlockInlineControls'
import { useEmbedRenderer } from '@/components/editor/embed/embed-renderer'
import { useEmbedRowEditor } from '@/components/editor/embed/embed-row-editor-context'
import { ListMarker } from '@/components/editor/ListMarker'
import { TaskMarkerButton } from '@/components/editor/TaskMarkerButton'
import { useRichContent } from '@/components/editor/useRichContent'
import { BatchPropertiesProvider } from '@/hooks/useBatchPropertyRows'
import { useScopedBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { type InlineProperty, useExtraBlockProperties } from '@/hooks/useExtraBlockProperties'
import { useListStyles } from '@/hooks/useListStyles'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { parseEmbedToken } from '@/lib/embed-token'
import { computeListOrdinals } from '@/lib/list-ordinals'
import { contentShowsListMarker, type ListStyle } from '@/lib/list-style'
import { computeSiblingAriaProps } from '@/lib/outline-aria'
import type { FlatBlock } from '@/lib/tree-utils'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'

export interface EmbeddedBlockTreeProps {
  /**
   * The embedded rows, ALREADY re-based so the shallowest row is depth 0.
   * See `selectEmbeddedRows`.
   */
  rows: readonly FlatBlock[]
  /**
   * `aria-level` of the host row this embed is rendered inside; `0` when
   * there is no host row (a standalone render).
   */
  baseAriaLevel: number
  /** Navigate to a block-ref chip's target. */
  onNavigate?: ((id: string) => void) | undefined
  /**
   * #4550 phase 2 — this embed has been unlocked, so a row the user clicks
   * takes the HOST tree's roving editor and writes through the SOURCE page's
   * store. Locked (the default) renders exactly what phase 1 rendered.
   */
  unlocked?: boolean | undefined
}

export function EmbeddedBlockTree({
  rows,
  baseAriaLevel,
  onNavigate,
  unlocked = false,
}: EmbeddedBlockTreeProps): React.ReactElement {
  const { t } = useTranslation()
  // The host tree's property batch holds the HOST page's rows, so the embed
  // reads its own rows' properties in one batch of its own (#6747).
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows])
  const ownedIds = useMemo(() => new Set(rowIds), [rowIds])
  const { invalidationKey } = useScopedBlockPropertyEvents({
    ownsBlock: (blockId) => ownedIds.has(blockId),
  })

  if (rows.length === 0) {
    return (
      <p className="embed-empty px-3 py-1 text-sm text-muted-foreground italic">
        {t('embed.emptySource')}
      </p>
    )
  }

  return (
    <BatchPropertiesProvider blockIds={rowIds} invalidationKey={invalidationKey}>
      <EmbeddedRowList
        rows={rows}
        baseAriaLevel={baseAriaLevel}
        onNavigate={onNavigate}
        unlocked={unlocked}
      />
    </BatchPropertiesProvider>
  )
}

function EmbeddedRowList({
  rows,
  baseAriaLevel,
  onNavigate,
  unlocked,
}: Required<Pick<EmbeddedBlockTreeProps, 'rows' | 'baseAriaLevel'>> & {
  onNavigate?: ((id: string) => void) | undefined
  unlocked: boolean
}): React.ReactElement {
  const siblingAria = useMemo(() => computeSiblingAriaProps(rows), [rows])
  const blockProperties = useExtraBlockProperties(rows)
  const listStyles = useListStyles(rows)
  // Ordinals count a run of same-depth siblings that show a marker, as the
  // host outline's do (`BlockListRenderer`).
  const ordinals = useMemo(() => {
    const content = new Map(rows.map((row) => [row.id, row.content ?? '']))
    const styleOf = (id: string): ListStyle => {
      const style = listStyles.get(id) ?? 'none'
      return style !== 'none' && contentShowsListMarker(content.get(id) ?? '') ? style : 'none'
    }
    return computeListOrdinals(rows, styleOf)
  }, [rows, listStyles])
  // Inside the SOURCE page's provider: the tick writes through the store of
  // the page that owns the block, which mirrors it to every view of that page.
  const { handleToggleTodo } = useBlockProperties()

  return (
    <ul className="embed-tree list-none m-0 p-0" data-testid="embed-tree">
      {rows.map((row) => {
        const aria = siblingAria.get(row.id)
        return (
          <li
            key={row.id}
            data-embed-block-id={row.id}
            // Host-relative: the container sits one level below the host row,
            // and the re-based depth counts from there.
            aria-level={baseAriaLevel + 1 + row.depth}
            aria-setsize={aria?.setsize}
            aria-posinset={aria?.posinset}
            className="list-none m-0 p-0"
            style={{ paddingLeft: `calc(var(--indent-width) * ${row.depth})` }}
          >
            <EmbeddedRow
              row={row}
              baseAriaLevel={baseAriaLevel + 1 + row.depth}
              onNavigate={onNavigate}
              unlocked={unlocked}
              properties={blockProperties[row.id]}
              listStyle={listStyles.get(row.id) ?? 'none'}
              listOrdinal={ordinals.get(row.id)}
              onToggleTodo={handleToggleTodo}
            />
          </li>
        )
      })}
    </ul>
  )
}

/** The read-only metadata row never calls its edit handlers. */
const NO_EDIT = (): void => {}

function EmbeddedRow({
  row,
  baseAriaLevel,
  onNavigate,
  unlocked,
  properties,
  listStyle,
  listOrdinal,
  onToggleTodo,
}: {
  row: FlatBlock
  baseAriaLevel: number
  onNavigate?: ((id: string) => void) | undefined
  unlocked: boolean
  properties: InlineProperty[] | undefined
  listStyle: ListStyle
  listOrdinal: number | undefined
  onToggleTodo: (blockId: string) => Promise<void>
}): React.ReactElement {
  const { t } = useTranslation()
  const resolvers = useBlockResolvers()
  const content = row.content ?? ''
  // The re-entrancy point. A row that is itself an embed renders another
  // container; `EmbedChainContext` (extended one boundary up, in
  // `EmbedContainer`) is what stops the recursion.
  //
  // The renderer arrives through context rather than a static import, so the
  // module graph stays acyclic — see `embed-renderer.ts`. `null` means no
  // `EmbedContainer` encloses this tree (a standalone render), and a nested
  // token then degrades to the text it is rather than throwing.
  const nested = parseEmbedToken(content)
  const renderNestedEmbed = useEmbedRenderer()
  const renderNested = nested != null && renderNestedEmbed != null

  // #4550 phase 2 — the unlock path. `renderRow` is the HOST tree's editable
  // row (`null` outside a BlockTree), so the single roving instance roves
  // here rather than a second one being mounted; the row is inside the SOURCE
  // page's provider, so its writes land on the page that owns the block.
  const renderRow = useEmbedRowEditor()
  const focusedBlockId = useBlockStore((s) => s.focusedBlockId)
  const setFocused = useBlockStore((s) => s.setFocused)
  const isFocused = focusedBlockId === row.id
  // No `!renderNested` term: the nested-embed branch returns below, so every
  // read of `editable` already runs with `renderNested === false`.
  const editable = unlocked && renderRow != null
  // Only the FOCUSED row swaps to the editable row. Every other row keeps the
  // read-only rendering phase 1 shipped, so unlocking changes one row's DOM,
  // not the whole subtree's.
  const handleRowClick = useCallback(() => setFocused(row.id), [setFocused, row.id])

  const richContent = useRichContent(renderNested ? '' : content, {
    onNavigate,
    resolveBlockTitle: resolvers?.resolveBlockTitle,
    resolveTagName: resolvers?.resolveTagName,
    resolveBlockStatus: resolvers?.resolveBlockStatus,
    resolveTagStatus: resolvers?.resolveTagStatus,
  })

  if (renderNested && nested != null && renderNestedEmbed != null) {
    return renderNestedEmbed({
      hostBlockId: row.id,
      targetId: nested.targetId,
      baseAriaLevel,
      onNavigate,
    })
  }

  if (editable && isFocused) {
    return renderRow({
      blockId: row.id,
      content,
      onNavigate,
      resolveBlockTitle: resolvers?.resolveBlockTitle,
      resolveTagName: resolvers?.resolveTagName,
      resolveBlockStatus: resolvers?.resolveBlockStatus,
      resolveTagStatus: resolvers?.resolveTagStatus,
    })
  }

  return (
    // No handler at all while locked, so the read-only embed stays inert.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a passive surface while unlocked, as `StaticBlock`'s row is: the click mounts the editor, and keyboard users reach the content through the inner chips
    <div
      className={cn(
        'embed-row flex w-full min-h-[1.5rem] items-start rounded-md text-left text-sm',
        editable && 'cursor-text hover:bg-accent/50',
      )}
      data-embed-editable={editable ? 'true' : undefined}
      onClick={editable ? handleRowClick : undefined}
    >
      <EmbeddedRowBody
        row={row}
        properties={properties}
        listStyle={listStyle}
        listOrdinal={listOrdinal}
        onToggleTodo={onToggleTodo}
      >
        {richContent ?? (
          <span className="block-placeholder text-muted-foreground italic">
            {t('block.emptyPlaceholder')}
          </span>
        )}
      </EmbeddedRowBody>
    </div>
  )
}

/**
 * What the block's own row draws around its text (#6747): the task checkbox,
 * the list marker, and the metadata row, its chips read-only.
 */
function EmbeddedRowBody({
  row,
  properties,
  listStyle,
  listOrdinal,
  onToggleTodo,
  children,
}: {
  row: FlatBlock
  properties: InlineProperty[] | undefined
  listStyle: ListStyle
  listOrdinal: number | undefined
  onToggleTodo: (blockId: string) => Promise<void>
  children: React.ReactNode
}): React.ReactElement {
  const content = row.content ?? ''
  const task = row.todo_state || null
  const showsListMarker = listStyle !== 'none' && contentShowsListMarker(content)
  const filteredProperties = useMemo(
    () => (properties ?? []).filter((p) => !INTERNAL_PROPERTY_KEYS.has(p.key)),
    [properties],
  )
  return (
    <>
      {task !== null && (
        // The tick changes no text and no structure, so it needs no unlock.
        <div className="flex min-h-block-line flex-shrink-0 items-center pl-1">
          <TaskMarkerButton blockId={row.id} todoState={task} onToggleTodo={onToggleTodo} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="px-3 py-1">
          {task === null && !showsListMarker && (
            <span className="embed-row-marker" aria-hidden="true" />
          )}
          <ListMarker style={listStyle} ordinal={listOrdinal} content={content} />
          {children}
        </div>
        <BlockMetadataRow
          readOnly
          blockId={row.id}
          priority={row.priority}
          dueDate={row.due_date}
          scheduledDate={row.scheduled_date}
          properties={properties}
          filteredProperties={filteredProperties}
          attachmentCount={0}
          showAttachments={false}
          onToggleAttachments={NO_EDIT}
          onEditProp={NO_EDIT}
          onEditKey={NO_EDIT}
        />
      </div>
    </>
  )
}
