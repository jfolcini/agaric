/**
 * `EmbedContainer` — the block-level `{{embed …}}` render (#4550).
 *
 * **Read-only until the user unlocks this one embed** (phase 2). The default
 * is not timidity, it is `AGENTS.md` invariant #4: one roving TipTap instance
 * per mounted `BlockTree`, with GLOBAL focus (`useBlockStore` holds
 * `focusedBlockId` app-wide). `storeOwnsBlock` / `addOwnedBlockListener` keep
 * N trees from racing conflicting IPCs on one chord, but those gates were
 * designed for SIBLING trees; an embed makes them NESTED, with focus sitting
 * in a store mounted inside the store that owns the host page.
 *
 * What unlocking does, and what it deliberately does not:
 *
 *  - The embed mounts NO editor. The focused row renders the HOST tree's
 *    editable row (`EmbedRowEditorContext`), so the one roving instance roves
 *    into the embed. There is never a second `<EditorContent>`.
 *  - That row sits inside the SOURCE page's `PageBlockStoreProvider` below,
 *    so its debounced commit, blur flush and draft autosave all write to the
 *    page that owns the block — not the host page.
 *  - STRUCTURAL chords stay off. Every one of them is bound to the host
 *    tree's store, which does not hold an embedded block, so `BlockTree` hands
 *    `useBlockKeyboard` a null editor and `useBlockFlush` refuses the flush.
 *    Restructuring someone else's outline from a page that is not theirs is
 *    invisible where it lands; the header says so while unlocked.
 *  - The unlock is component state: session-scoped, never persisted, per
 *    embed. Relocking, or focus leaving the embed, returns it to read-only.
 *  - Unlocking MOVES the focus to the embed's first editable row, which is
 *    what makes the feature keyboard-operable at all: embedded rows carry no
 *    tab stop, and phase 1 deliberately kept arrow-key outline navigation from
 *    descending into an embed, so the toggle is the only way in. **Escape** is
 *    the way out: it relocks and returns focus to the container, this region's
 *    one tab stop, so Tab moves on from there. It SAVES — relocking clears the
 *    focus, and `useEditorBlur` persists on the way out — which is the opposite
 *    of what Escape does in a host row, where it discards and toasts. That is
 *    deliberate: an edit here lands on another page, and silently dropping it
 *    on a keypress the user reached for as "get me out" would be worse than
 *    keeping it. It bails while a suggestion picker is open so the pickers keep
 *    their own Escape. Escape has to be handled in the
 *    CAPTURE phase, because the roving editor holds the INERT callback set
 *    while it sits on an embedded row and `useBlockKeyboard` would otherwise
 *    `preventDefault()` + `stopPropagation()` it along with Tab and the
 *    arrows — which is what would make an unlocked embed a keyboard trap.
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

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Lock,
  LockOpen,
  RotateCcw,
  Repeat,
} from 'lucide-react'
import type React from 'react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  getActiveEmbed,
  releaseActiveEmbed,
  setActiveEmbed,
  subscribeActiveEmbed,
} from '@/components/editor/embed/active-embed'
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
import { useEmbedRowEditor } from '@/components/editor/embed/embed-row-editor-context'
import { embedAncestors, selectEmbeddedRows } from '@/components/editor/embed/embed-rows'
import { EmbeddedBlockTree } from '@/components/editor/embed/EmbeddedBlockTree'
import { useEmbedTarget } from '@/components/editor/embed/use-embed-target'
import { isSuggestionPopupVisible } from '@/editor/use-block-keyboard'
import {
  blockIsRenderedByAMountedTree,
  subscribeBlockCommandTargets,
} from '@/lib/block-command-bus'
import { normalizeBlockRefTitle } from '@/lib/block-title'
import { EMBED_MOUNT_LIMIT, MAX_EMBED_DEPTH, parseEmbedToken } from '@/lib/embed-token'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'
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
  // #4550 phase 2 — the per-embed unlock. Component state, deliberately:
  // session-scoped and never persisted, so a reload, a re-mount, or a second
  // view of the same source page all start locked. Two embeds of one block
  // unlock independently because each holds its own.
  const [unlockRequested, setUnlocked] = useState(false)
  // Identity for the one-editable-embed slot. Two embeds of the same block are
  // indistinguishable by target, page or focus — see `active-embed.ts`.
  const embedInstanceId = useId()
  const blocks = usePageBlockStore((s) => s.blocks)
  const blocksById = usePageBlockStore((s) => s.blocksById)
  const loading = usePageBlockStore((s) => s.loading)

  // Load only when this provider's store has nothing. Each embed mounts its
  // OWN store and issues its OWN `load()` here — adopting into an existing
  // registry slot (`registerPageStore`) does not seed this store from a
  // sibling's live data, so N embeds of one page cost N `load_page_subtree`
  // calls, not one. (An earlier draft of this feature seeded the adopted
  // store at registration time to avoid exactly that; it was removed before
  // shipping because a child's effect runs before its provider's own
  // registration effect, so the seed could never actually beat this `load()`
  // call.) `mirrorToSiblings` (`page-blocks.ts`) is what keeps N stores of
  // one page in sync AFTER each has loaded — it does not reduce the IPC
  // count. Size `EMBED_MOUNT_LIMIT` and any per-page embed cap against N real
  // loads, not one.
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

  // #4550 phase 2 — "blurring returns to read-only". The signal is the GLOBAL
  // focused block, not DOM focusout: swapping a row between its read-only div
  // and the editable one detaches the old node mid-click, and a focusout with
  // a null `relatedTarget` there would relock the embed the user just entered.
  // The `wasInside` latch is what makes this a blur rather than a "focus is
  // elsewhere" test: `setUnlocked` and the focus move below are two different
  // stores, so an effect run that lands between them would see "unlocked with
  // focus outside" and relock the embed on the tick it was opened.
  // A block a mounted `BlockTree` already renders must not become editable
  // here: `isFocused` is `focusedBlockId === block.id` in every tree at once,
  // so focusing it would mount an `EditableBlock` in that tree AND the host
  // tree's editable row inside this embed — two `EditorSurface`s and two
  // `id="editor-<id>"` nodes for one roving instance, the invariant-4
  // violation this design exists to avoid. Reachable both ways the `/embed`
  // picker allows: an embed of a block on the page it sits on, and a journal
  // week where one mounted day embeds another mounted day's block.
  // Where unlocking puts the caret. A row that is itself an embed renders a
  // nested container instead of an editable row, so focusing it would unlock
  // into nothing; skip to the first row that can actually host the editor.
  const firstEditableRowId = useMemo(
    () => rows.find((r) => parseEmbedToken(r.content) == null)?.id ?? null,
    [rows],
  )
  // Keyed on a ROW, not on `targetId`. Every row in an embed comes from the one
  // source-page store, so either answers for a block target — but a PAGE target
  // is never in any store's `blocksById` at all: `buildFlatTree` starts at the
  // page's children, which `selectEmbeddedRows` states itself ("The page block
  // itself is not a row in its own flat tree"). Asking about the page id made
  // this a no-op for exactly the case where the embed's rows ARE another
  // mounted tree's own rows: `/embed` page P from page P, or Monday's page
  // embedding Tuesday's in the journal week.
  const renderedByAMountedTree = useSyncExternalStore(
    subscribeBlockCommandTargets,
    () => firstEditableRowId != null && blockIsRenderedByAMountedTree(firstEditableRowId),
  )
  // DERIVED, not relocked from an effect. The hazard is two `EditableBlock`s
  // for one id in a SINGLE commit, and only a value computed during render is
  // right in the commit that creates it — an effect relocks one render too
  // late. It also answers the focus question by itself: the tree that now owns
  // the block renders the editor for it, so there is nothing stranded to clean
  // up, and a tree unmounting hands the embed back.
  const isActiveEmbed = useSyncExternalStore(
    subscribeActiveEmbed,
    () => getActiveEmbed() === embedInstanceId,
  )
  const unlocked = unlockRequested && !renderedByAMountedTree && isActiveEmbed
  const rowIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows])
  const focusedBlockId = useBlockStore((s) => s.focusedBlockId)
  const setFocused = useBlockStore((s) => s.setFocused)
  const wasInside = useRef(false)
  // Set on pointerdown ANYWHERE inside this embed, and consumed by the effect
  // below. Moving the caret from one unlocked row to another is a click, and a
  // click starts by blurring the editor: `useEditorBlur` step 5 ends in
  // `setFocused(null)` before the row's own `onClick` ever fires. Read as a
  // blur, that null relocked the embed mid-click, and since the rows carry no
  // tab stop and arrow navigation does not descend into an embed, re-unlocking
  // only ever returned the caret to `firstEditableRowId` — so only the first
  // row was reachable. Pointerdown precedes blur, which is what makes this a
  // latch rather than a race.
  const pointerInside = useRef(false)
  const notePointerInside = useCallback(() => {
    pointerInside.current = true
  }, [])
  useEffect(() => {
    if (focusedBlockId != null && rowIds.has(focusedBlockId)) {
      wasInside.current = true
      pointerInside.current = false
      return
    }
    if (!wasInside.current) return
    // Focus is momentarily nowhere because a click inside this embed is still
    // in flight. Stay unlocked and let that click land.
    if (focusedBlockId == null && pointerInside.current) {
      pointerInside.current = false
      return
    }
    wasInside.current = false
    pointerInside.current = false
    releaseActiveEmbed(embedInstanceId)
    setUnlocked(false)
  }, [focusedBlockId, rowIds, embedInstanceId])

  // Unmounting while holding the slot would strand it, leaving every other
  // embed permanently unable to unlock. `releaseActiveEmbed` is a no-op unless
  // this embed still holds it, so a container that lost the slot to a newer
  // one cannot clear that one on the way out.
  useEffect(() => () => releaseActiveEmbed(embedInstanceId), [embedInstanceId])

  // No host tree → no roving editor to rove in; no editable row → nothing to
  // rove ONTO. Either way the control is not offered at all rather than
  // offered dead.
  const canEdit =
    useEmbedRowEditor() != null && firstEditableRowId != null && !renderedByAMountedTree
  const toggleUnlock = useCallback(() => {
    if (unlocked) {
      wasInside.current = false
      releaseActiveEmbed(embedInstanceId)
      setUnlocked(false)
      // Relocking with the editor still roved into a row would strand the
      // global focus on a block no mounted tree owns: the host page's chords
      // stay detached (`storeOwnsBlock` in `BlockTree`) and no row renders an
      // editor, so the keyboard is dead until the user clicks a host row.
      if (focusedBlockId != null && rowIds.has(focusedBlockId)) setFocused(null)
      return
    }
    // Claim the slot BEFORE the focus move: it relocks whichever embed held
    // it, so the row that embed was rendering is gone by the time this one's
    // `setFocused` lands.
    setActiveEmbed(embedInstanceId)
    setUnlocked(true)
    // Unlocking moves the focus INTO the embed. Without it the feature is
    // pointer-only: embedded rows carry no tab stop, and arrow-key outline
    // navigation deliberately does not descend into an embed (phase 1), so a
    // keyboard user who reaches this toggle has no way to reach a row.
    if (firstEditableRowId != null) setFocused(firstEditableRowId)
  }, [unlocked, focusedBlockId, rowIds, setFocused, firstEditableRowId, embedInstanceId])

  const pageLabel = sourcePageTitle || t('block.untitled')

  return (
    <EmbedShell
      label={t('embed.containerLabel', {
        page: pageLabel,
        title: targetTitle || t('block.untitled'),
      })}
      strip={
        unlocked
          ? t('embed.editingPrefix', { page: pageLabel })
          : t('embed.sourcePrefix', { page: pageLabel })
      }
      crumbs={crumbs}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      onOpenSource={onOpenSource}
      testId="embed-container"
      unlocked={unlocked}
      onToggleUnlock={canEdit ? toggleUnlock : null}
      announcement={unlocked ? t('embed.unlockedAnnouncement', { page: pageLabel }) : ''}
      onPointerDownCapture={notePointerInside}
    >
      {loading && rows.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{t('embed.loading')}</p>
      ) : missing ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{t('embed.missingInSource')}</p>
      ) : (
        <EmbedChainContext.Provider value={chainValue}>
          <EmbeddedBlockTree
            rows={rows}
            baseAriaLevel={baseAriaLevel}
            onNavigate={onNavigate}
            unlocked={unlocked}
          />
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
  unlocked = false,
  onToggleUnlock = null,
  announcement = '',
  onPointerDownCapture,
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
  /** #4550 phase 2 — this embed is editable in place right now. */
  unlocked?: boolean
  /** `null` in every state with nothing to edit (loading / deleted / stub). */
  onToggleUnlock?: (() => void) | null
  /** Polite announcement text; empty while locked. */
  announcement?: string
  /**
   * #4550 phase 2 — fires before the blur a click inside an unlocked embed
   * causes, so the container can tell "moving between my rows" from "the user
   * left". Capture phase, because the rows below stop nothing but do own the
   * click that follows.
   */
  onPointerDownCapture?: (() => void) | undefined
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

  const shellRef = useRef<HTMLDivElement>(null)
  // Escape is the way OUT of an unlocked embed, and it has to be handled in
  // the CAPTURE phase: `useBlockKeyboard`'s container listener runs on the way
  // up, and while the roving editor sits on an embedded row it is holding the
  // inert callback set — so it would `preventDefault()` an Escape that does
  // nothing and `stopPropagation()` it, leaving the caret with no key that
  // moves focus. Tab, Shift+Tab and the arrows are swallowed the same way, so
  // without this the region is a keyboard trap: a pointer is the only exit,
  // and `src/lib/editor-preferences.ts` promises the opposite ("Escape exits
  // the block ... so Tab can move focus away again").
  //
  // Escape restructures nothing, so unlike the structural chords it needs no
  // ownership gate. Relocking through `onToggleUnlock` is the same path the
  // toggle takes — it clears the focus off the embedded row — and focus then
  // lands back on the container, which is this region's one tab stop, so Tab
  // works again from there.
  const handleEscapeOut = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!unlocked || e.key !== 'Escape' || onToggleUnlock == null) return
      // The pickers are portaled to `document.body` and never hold focus, so
      // their Escape arrives here — on the contenteditable inside the shell —
      // and React's root capture listener runs before ProseMirror's handler.
      // Without this bail, dismissing a `/`, `[[`, `#` or `::` menu ejected the
      // user from the region and committed the half-typed trigger to the source
      // page. `use-block-keyboard.ts` guards its own Escape the same way.
      if (isSuggestionPopupVisible()) return
      e.preventDefault()
      e.stopPropagation()
      onToggleUnlock()
      shellRef.current?.focus()
    },
    [unlocked, onToggleUnlock],
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
      className={cn(
        'embed-container',
        collapsed && 'embed-collapsed',
        unlocked && 'embed-unlocked',
      )}
      onPointerDownCapture={onPointerDownCapture}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <fieldset>/<optgroup>/<details> all add form or disclosure semantics this read-only region does not have; role="group" carries the accessible name without them
      role="group"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the container-level action set must be reachable without entering the subtree; see the note above and the file docblock
      tabIndex={0}
      // The container — not the tabIndex={-1} collapse button beside it — is
      // the element that actually HAS focus when Space toggles collapse, so
      // the expanded state has to live here for a screen reader's
      // state-change announcement to fire. `undefined` when there is no
      // collapse control at all (loading / deleted / unresolved shells):
      // aria-expanded would otherwise assert a togglability that isn't there.
      // group doesn't formally list aria-expanded among its supported
      // states; axe accepts it, only oxlint's static rule rejects it (same
      // situation as SortableBlockWrapper's listitem aria-expanded).
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- see note above; mirrors the collapse button's own aria-expanded for the element that is actually focusable
      aria-expanded={onToggleCollapse ? !collapsed : undefined}
      ref={shellRef}
      onKeyDown={handleKeyDown}
      onKeyDownCapture={handleEscapeOut}
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
        {onToggleUnlock && (
          // The ONE control in the strip that is its own tab stop. Phase 1
          // gave the whole region a single stop because it was read-only and
          // usually skipped past; an editable region's way IN has to be
          // reachable without first landing on the container and guessing a
          // key. The other two controls stay opted out.
          <button
            type="button"
            className="embed-unlock-toggle shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            aria-pressed={unlocked}
            aria-label={unlocked ? t('embed.lock') : t('embed.unlock')}
            data-testid="embed-unlock-toggle"
            onClick={onToggleUnlock}
          >
            {unlocked ? (
              <LockOpen className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        )}
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
      {/* The unlock is announced, and the restriction that comes with it is
          stated where it applies rather than fired as a toast when a chord is
          swallowed: structural chords are OFF for the whole region, not for
          the one keystroke that hit the wall. */}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {unlocked && !collapsed && (
        <p className="embed-edit-hint px-3 pb-1 text-xs text-muted-foreground">
          {t('embed.editHint')}
        </p>
      )}
      {!collapsed && children}
    </div>
  )
}
