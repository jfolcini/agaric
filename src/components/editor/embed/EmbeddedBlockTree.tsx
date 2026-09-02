/**
 * `EmbeddedBlockTree` — the read-only subtree renderer behind `{{embed …}}`
 * (#4550, phase 1).
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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockResolvers } from '@/components/block-tree/use-block-resolvers'
import { useEmbedRenderer } from '@/components/editor/embed/embed-renderer'
import { useRichContent } from '@/components/editor/useRichContent'
import { parseEmbedToken } from '@/lib/embed-token'
import { computeSiblingAriaProps } from '@/lib/outline-aria'
import type { FlatBlock } from '@/lib/tree-utils'

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
}

export function EmbeddedBlockTree({
  rows,
  baseAriaLevel,
  onNavigate,
}: EmbeddedBlockTreeProps): React.ReactElement {
  const { t } = useTranslation()
  const siblingAria = useMemo(() => computeSiblingAriaProps(rows), [rows])

  if (rows.length === 0) {
    return (
      <p className="embed-empty px-3 py-1 text-sm text-muted-foreground italic">
        {t('embed.emptySource')}
      </p>
    )
  }

  return (
    <ul
      className="embed-tree list-none m-0 p-0 space-y-[var(--block-row-gap)]"
      data-testid="embed-tree"
    >
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
            />
          </li>
        )
      })}
    </ul>
  )
}

function EmbeddedRow({
  row,
  baseAriaLevel,
  onNavigate,
}: {
  row: FlatBlock
  baseAriaLevel: number
  onNavigate?: ((id: string) => void) | undefined
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

  return (
    <div className="embed-row w-full min-h-[1.5rem] rounded-md px-3 py-1 text-left text-sm">
      <span className="embed-row-marker" aria-hidden="true" />
      {richContent ?? (
        <span className="block-placeholder text-muted-foreground italic">
          {t('block.emptyPlaceholder')}
        </span>
      )}
    </div>
  )
}
