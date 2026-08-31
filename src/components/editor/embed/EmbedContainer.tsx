/**
 * `EmbedContainer` — the block-level `{{embed …}}` render (#4550, phase 1).
 *
 * Read-only, by design rather than by timidity. `AGENTS.md` invariant #4 is
 * one roving TipTap instance per mounted `BlockTree`, and focus is GLOBAL
 * (`useBlockStore` holds `focusedBlockId` app-wide). `storeOwnsBlock` /
 * `addOwnedBlockListener` keep N trees from racing conflicting IPCs on one
 * chord — but those gates were designed and tested for SIBLING trees. An
 * embed makes them NESTED: focus would sit in a store mounted inside the
 * store that owns the host page, and every document-level chord would fire
 * against the embedded page's store from the host page's keyboard context.
 * That is provable, but it must be proven, and it is not what stands between
 * users and this feature's value. Edit-in-place is phase 2.
 *
 * The container renders in every degraded state — never nothing. The host
 * block's content still holds the token, so a silent disappearance leaves an
 * empty, unexplained row on the host page.
 *
 * ## Where this sits in the DOM
 *
 * Inside the host row's `<li>` (published by `SortableBlockWrapper`, which
 * already carries `aria-level` / `aria-setsize` / `aria-posinset` /
 * `aria-expanded` for that row) as a `role="group"` with one tab stop. Half
 * of that is the model `StaticQueryBlock` already uses — a passive outer
 * container whose densely interactive inner subtree owns its own focus — but
 * only half: the query card is deliberately ZERO tab stops. Unlike a query
 * card, an embed has a container-level action set (open source, collapse)
 * that must be reachable without entering the subtree, hence `tabIndex={0}`
 * with Enter = open source and Space = toggle collapse.
 */

import { ChevronDown, ChevronRight, ExternalLink, RotateCcw, Repeat } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  EmbedChainContext,
  extendEmbedChain,
  useEmbedChain,
} from '@/components/editor/embed/embed-chain'
import {
  EmbedRendererContext,
  type EmbedRenderer,
  type EmbedRenderProps,
} from '@/components/editor/embed/embed-renderer'
import { embedAncestors, selectEmbeddedRows } from '@/components/editor/embed/embed-rows'
import { EmbeddedBlockTree } from '@/components/editor/embed/EmbeddedBlockTree'
import { useEmbedTarget } from '@/components/editor/embed/use-embed-target'
import { normalizeBlockRefTitle } from '@/lib/block-title'
import { EMBED_MOUNT_LIMIT, MAX_EMBED_DEPTH } from '@/lib/embed-token'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'
import {
  PageBlockStoreProvider,
  usePageBlockStore,
  usePageBlockStoreApi,
  usePageBlockStoreOptional,
} from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'

/**
 * Props live in `embed-renderer.ts` — see that module for why the type does
 * not live here. Re-exported under the historical name for call sites.
 */
export type EmbedContainerProps = EmbedRenderProps

/**
 * Publishes ITSELF as the nested-embed renderer, then runs the cycle / depth
 * gate.
 *
 * The self-publish is what breaks the `EmbedContainer ⇄ EmbeddedBlockTree`
 * module cycle: the tree reads this component out of context instead of
 * importing it (see `embed-renderer.ts`). The value is this module's own
 * function binding — constant for the process — so the extra provider costs
 * nothing and never invalidates a consumer.
 */
export function EmbedContainer(props: EmbedContainerProps): React.ReactElement {
  return (
    <EmbedRendererContext.Provider value={renderNestedEmbed}>
      <EmbedGate {...props} />
    </EmbedRendererContext.Provider>
  )
}

/**
 * Module-level and therefore reference-stable for the life of the process:
 * the context value never changes, so publishing it invalidates nothing, and
 * the element it returns always has the same component type.
 */
const renderNestedEmbed: EmbedRenderer = (props) => <EmbedContainer {...props} />

/**
 * The cycle / depth gate. Both checks run BEFORE anything resolves or mounts
 * a store, so a loop costs one render, not an IPC storm.
 */
function EmbedGate(props: EmbedContainerProps): React.ReactElement {
  const chain = useEmbedChain()
  // True cycles, including the indirect ones: embedding a block embeds its
  // subtree, so an ancestor of an already-rendered embed is a cycle too.
  if (chain.renderedIds.has(props.targetId)) {
    return <EmbedStub variant="cycle" {...props} />
  }
  // Independent of the set: A → B → C → D with no repeated id is not a cycle
  // and the ancestor set will never stop it, but it is still unbounded work.
  if (chain.depth >= MAX_EMBED_DEPTH) {
    return <EmbedStub variant="depth" {...props} />
  }
  return <EmbedResolver {...props} />
}

// ── Stubs ────────────────────────────────────────────────────────────────

/**
 * The inline stub rendered AT THE POSITION WHERE THE LOOP CLOSES. Not a
 * blank, not a toast, not a thrown boundary: the user can only fix a cycle
 * they can see. The text is real text (announced), not a `::before`, and the
 * chip is the ordinary `block-ref-chip` so it reads as the reference it has
 * degraded into.
 */
function EmbedStub({
  variant,
  targetId,
  onNavigate,
}: EmbedContainerProps & { variant: 'cycle' | 'depth' }): React.ReactElement {
  const { t } = useTranslation()
  const title = useResolveStore((s) => s.resolveTitle(targetId))
  return (
    <div
      className="embed-container embed-container-stub"
      data-testid="embed-stub"
      data-embed-stub={variant}
    >
      <p className="embed-stub-text flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{variant === 'cycle' ? t('embed.cycleStub') : t('embed.depthStub')}</span>
        <span className="block-ref-chip">
          <span className="block-ref-chip-label">{title}</span>
        </span>
        {onNavigate && (
          <button
            type="button"
            className="embed-open-source underline underline-offset-2"
            onClick={() => onNavigate(targetId)}
          >
            {t('embed.openSource')}
          </button>
        )}
      </p>
    </div>
  )
}

// ── Resolver ─────────────────────────────────────────────────────────────

function EmbedResolver(props: EmbedContainerProps): React.ReactElement {
  const { hostBlockId, targetId, baseAriaLevel, onNavigate } = props
  const { t } = useTranslation()
  const target = useEmbedTarget(targetId)

  // #4550 — collapse is a list of collapsed HOST BLOCK ids, scoped to the
  // page this embed is rendered ON, under `PREFERENCES.embedCollapse`.
  //
  // Read the host page id HERE, before the source page's provider mounts
  // below: inside that provider `rootParentId` is the SOURCE page, and
  // scoping to it would let collapsing one embed rewrite what every other
  // view of that page shows. (For an embed nested inside another embed the
  // enclosing scope is the outer embed's source page — still stable, still
  // prunable, and still never the `collapsed_ids` key of any page.)
  const hostPageId = usePageBlockStoreOptional((s) => s.rootParentId)
  // `''` is the no-provider fallback store's root. Name the unscoped case
  // explicitly rather than letting `effectiveKey` warn and collapse to the
  // bare key, which would pool every unscoped embed into one entry.
  const collapseKey = hostPageId != null && hostPageId !== '' ? hostPageId : '__unscoped__'
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readPreference(PREFERENCES.embedCollapse, collapseKey).includes(hostBlockId),
  )
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      // Re-read at write time rather than closing over a snapshot: sibling
      // embeds on this page share the entry and each toggles independently.
      const current = readPreference(PREFERENCES.embedCollapse, collapseKey)
      const updated = next
        ? current.includes(hostBlockId)
          ? current
          : [...current, hostBlockId]
        : current.filter((id) => id !== hostBlockId)
      writePreference(PREFERENCES.embedCollapse, updated, collapseKey)
      return next
    })
  }, [collapseKey, hostBlockId])

  const openSource = useCallback(() => {
    onNavigate?.(targetId)
  }, [onNavigate, targetId])

  if (target.status === 'loading') {
    return (
      <EmbedShell
        label={t('embed.loadingLabel')}
        strip={t('embed.loading')}
        collapsed={false}
        onToggleCollapse={null}
        onOpenSource={null}
        testId="embed-loading"
      />
    )
  }

  if (target.status === 'deleted') {
    return (
      <EmbedShell
        label={t('embed.deletedLabel', { title: target.title })}
        strip={t('embed.sourceDeleted')}
        collapsed={false}
        onToggleCollapse={null}
        onOpenSource={null}
        testId="embed-deleted"
        action={<RestoreFromTrashButton />}
      >
        <p className="px-3 py-2 text-sm">
          <span className="block-ref-chip block-ref-deleted">
            <span className="block-ref-chip-label">{target.title}</span>
          </span>
        </p>
      </EmbedShell>
    )
  }

  if (target.status === 'unresolved') {
    return (
      <EmbedShell
        label={t('embed.unresolvedLabel')}
        strip={t('embed.unresolved')}
        collapsed={false}
        onToggleCollapse={null}
        onOpenSource={null}
        testId="embed-unresolved"
      >
        <p className="px-3 py-2 text-sm">
          {/* Non-navigating by construction: a purged target has nowhere to
              go, and a cross-space target must not be reachable at all — the
              locked-in policy is "no live links between spaces, ever". */}
          <span className="block-ref-chip block-ref-deleted" data-testid="embed-broken-chip">
            <span className="block-ref-chip-label">{t('embed.unresolvedChip')}</span>
          </span>
        </p>
      </EmbedShell>
    )
  }

  return (
    <PageBlockStoreProvider pageId={target.sourcePageId}>
      <EmbedBody
        hostBlockId={hostBlockId}
        targetId={targetId}
        baseAriaLevel={baseAriaLevel}
        onNavigate={onNavigate}
        sourcePageId={target.sourcePageId}
        sourcePageTitle={target.sourcePageTitle}
        isPageTarget={target.isPageTarget}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onOpenSource={openSource}
      />
    </PageBlockStoreProvider>
  )
}

function RestoreFromTrashButton(): React.ReactElement {
  const { t } = useTranslation()
  const setView = useNavigationStore((s) => s.setView)
  return (
    <button
      type="button"
      className="embed-header-action inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
      tabIndex={-1}
      onClick={() => setView('trash')}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      {t('embed.restore')}
    </button>
  )
}

// ── Body ─────────────────────────────────────────────────────────────────

interface EmbedBodyProps extends EmbedContainerProps {
  sourcePageId: string
  sourcePageTitle: string
  isPageTarget: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onOpenSource: () => void
}

function EmbedBody({
  targetId,
  baseAriaLevel,
  onNavigate,
  sourcePageId,
  sourcePageTitle,
  isPageTarget,
  collapsed,
  onToggleCollapse,
  onOpenSource,
}: EmbedBodyProps): React.ReactElement {
  const { t } = useTranslation()
  const store = usePageBlockStoreApi()
  const blocks = usePageBlockStore((s) => s.blocks)
  const blocksById = usePageBlockStore((s) => s.blocksById)
  const loading = usePageBlockStore((s) => s.loading)

  // Load only when this provider's store has nothing. A store adopted into an
  // existing registry slot is SEEDED from the page's live data at
  // registration (`registerPageStore`), so N embeds of one page cost one
  // `load_page_subtree`, not N — and an embed of a page already open in a tab
  // costs none at all.
  useEffect(() => {
    if (store.getState().blocks.length === 0) void store.getState().load()
  }, [store])

  const { rows, hiddenCount, missing } = useMemo(
    () => selectEmbeddedRows(blocks, targetId, sourcePageId, EMBED_MOUNT_LIMIT),
    [blocks, targetId, sourcePageId],
  )

  const ancestors = useMemo(
    () => (isPageTarget ? [] : embedAncestors(blocksById, targetId, sourcePageId)),
    [blocksById, targetId, sourcePageId, isPageTarget],
  )

  const targetTitle = useMemo(() => {
    if (isPageTarget) return sourcePageTitle
    const row = blocksById.get(targetId)
    return row ? normalizeBlockRefTitle(row.content ?? '') : ''
  }, [blocksById, targetId, isPageTarget, sourcePageTitle])

  const parentChain = useEmbedChain()
  const chainValue = useMemo(
    () =>
      extendEmbedChain(
        parentChain,
        targetId,
        rows.map((r) => r.id),
      ),
    [parentChain, targetId, rows],
  )

  const crumbs = useMemo(
    () => [
      sourcePageTitle || t('block.untitled'),
      ...ancestors.map((a) => normalizeBlockRefTitle(a.content ?? '') || t('block.untitled')),
    ],
    [sourcePageTitle, ancestors, t],
  )

  return (
    <EmbedShell
      label={t('embed.containerLabel', {
        page: sourcePageTitle || t('block.untitled'),
        title: targetTitle || t('block.untitled'),
      })}
      strip={t('embed.sourcePrefix', { page: sourcePageTitle || t('block.untitled') })}
      crumbs={crumbs}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      onOpenSource={onOpenSource}
      testId="embed-container"
    >
      {loading && rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{t('embed.loading')}</p>
      ) : missing ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{t('embed.missingInSource')}</p>
      ) : (
        <EmbedChainContext.Provider value={chainValue}>
          <EmbeddedBlockTree rows={rows} baseAriaLevel={baseAriaLevel} onNavigate={onNavigate} />
        </EmbedChainContext.Provider>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="embed-mount-boundary m-1 w-[calc(100%-0.5rem)] rounded-lg border border-dashed border-border bg-transparent p-1.5 text-xs text-muted-foreground hover:bg-accent"
          onClick={onOpenSource}
        >
          {t('embed.showAllInSource', { count: hiddenCount })}
        </button>
      )}
    </EmbedShell>
  )
}

// ── Shell ────────────────────────────────────────────────────────────────

/**
 * The visual container shared by every state: left rail, low-contrast ground,
 * header strip with breadcrumb + actions, and the one tab stop.
 */
function EmbedShell({
  label,
  strip,
  crumbs,
  collapsed,
  onToggleCollapse,
  onOpenSource,
  testId,
  action,
  children,
}: {
  label: string
  strip: string
  crumbs?: string[]
  collapsed: boolean
  onToggleCollapse: (() => void) | null
  onOpenSource: (() => void) | null
  testId: string
  action?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Only the container's own key events — an inner control keeps its own
      // Enter/Space semantics.
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' && onOpenSource) {
        e.preventDefault()
        onOpenSource()
      } else if (e.key === ' ' && onToggleCollapse) {
        e.preventDefault()
        onToggleCollapse()
      }
    },
    [onOpenSource, onToggleCollapse],
  )

  return (
    // The container is exactly ONE tab stop: it carries `tabIndex={0}` and the
    // header controls are `tabIndex={-1}`, reachable with the pointer and,
    // from the keyboard, through the container's own Enter / Space. Giving
    // each header button its own tab stop would put three stops on a
    // read-only region the user is usually skipping past.
    //
    // Deliberately NOT `role="treeitem"`: the host outline is a plain `<ul>`
    // of `<li>`s (see SortableBlockWrapper's note), and an isolated treeitem
    // under a plain list is itself an a11y violation.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the focusable container IS the interactive unit here (Enter = open source, Space = collapse); the handler cannot move to a child without giving the region three tab stops
    <div
      className={cn('embed-container', collapsed && 'embed-collapsed')}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <fieldset>/<optgroup>/<details> all add form or disclosure semantics this read-only region does not have; role="group" carries the accessible name without them
      role="group"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the container-level action set must be reachable without entering the subtree; see the note above and the file docblock
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid={testId}
    >
      <header className="embed-header flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        {onToggleCollapse && (
          <button
            type="button"
            className="embed-collapse-toggle shrink-0 rounded p-0.5 hover:bg-accent"
            tabIndex={-1}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('embed.expand') : t('embed.collapse')}
            onClick={onToggleCollapse}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        )}
        <nav aria-label={t('embed.breadcrumbLabel')} className="min-w-0 flex-1 truncate">
          <span className="embed-strip">{strip}</span>
          {crumbs && crumbs.length > 1 && (
            <span className="embed-crumbs">
              {' '}
              {crumbs
                .slice(1)
                .map((c) => ` › ${c}`)
                .join('')}
            </span>
          )}
        </nav>
        {action}
        {onOpenSource && (
          <button
            type="button"
            className="embed-open-source shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
            tabIndex={-1}
            onClick={onOpenSource}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t('embed.openSource')}
          </button>
        )}
      </header>
      {!collapsed && children}
    </div>
  )
}
