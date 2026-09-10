/**
 * BlockRefPeek — the floating preview a `((ULID))` chip opens (#4551).
 *
 * The chip is a title and nothing else (`docs/features/tags-and-links.md`),
 * capped to one 60-char line at the resolve-store seed. The peek is what
 * answers the question the chip cannot: the target's FULL content, where it
 * lives, and how many other blocks point at it — without leaving the page.
 *
 * One instance per page container (`PageEditor`, and `DaySection` because it
 * mounts `LinkedReferences` outside one). Activation lives in
 * `useBlockRefPeek`; this file is the payload and the render. Positioning
 * mirrors `LinkPreviewTooltip`: `computePosition` + `flip` + `shift`, with the
 * `cancelled` guard so a superseded placement never lands.
 *
 * Payload — four existing commands, no new one:
 *   1. `batchResolve` is the space/liveness GATE, exactly as
 *      `use-block-navigate-to-link` and `use-embed-target` use it. `getBlock`
 *      carries a soft-delete predicate and nothing else, so it happily returns
 *      a row from another space (#3306); rendering that row's content here
 *      would be the loudest possible version of the leak that fix closed.
 *   2. `getBlock(refId)` — the content the chip does not show, plus `page_id`.
 *   3. `getBlock(page_id)` — the breadcrumb's page title. ONE hop, not the
 *      full ancestor chain: `BlockZoomBar`'s trail is a memo over the
 *      in-memory flat list, which does not contain a cross-page target's
 *      ancestors, and there is no ancestor-path command.
 *   4. `countBacklinksBatch` — the reference count. `PageId` is `= BlockId`
 *      and the SQL is target-agnostic, so a block id needs no new signature.
 *
 * Cached in the read-path TanStack client keyed on `(space, refId)` with a
 * short `staleTime`. Deliberately NOT the resolve store: that store is
 * seeded by every normalising writer in the app and churning its `version`
 * from a hover would re-render every chip on the page.
 */

import { computePosition, flip, shift } from '@floating-ui/dom'
import { useQuery } from '@tanstack/react-query'
import { Copy, ExternalLink, Trash2 } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { renderRichContent } from '@/components/RichContentRenderer'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useBlockRefPeek } from '@/hooks/useBlockRefPeek'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { resolveStoreTitle } from '@/lib/block-title'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import { toSpaceScope } from '@/lib/space-scope'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

/** Long enough that a re-hover is instant, short enough that an edit shows. */
const PEEK_STALE_MS = 30_000
const PEEK_GC_MS = 5 * 60_000

type PeekTarget =
  /** Purged, never existed, or in another space — all one render. */
  | { status: 'unresolved' }
  /** The lookup itself failed. Kept apart from `unresolved`: telling a user
   *  to switch space because the IPC was down sends them hunting for a block
   *  that is right where they left it. */
  | { status: 'error' }
  | { status: 'deleted'; title: string }
  | {
      status: 'ready'
      title: string
      content: string
      pageTitle: string | null
      refCount: number
    }

async function fetchPeekTarget(refId: string, spaceId: string): Promise<PeekTarget> {
  const scope = toSpaceScope(spaceId)
  try {
    const resolved = unwrap(await commands.batchResolve([refId], scope))
    const row = resolved.find((r) => r.id === refId)
    if (!row) return { status: 'unresolved' }
    const title = resolveStoreTitle(row.block_type, row.title)
    if (row.deleted) return { status: 'deleted', title }

    const block = unwrap(await commands.getBlock(refId))
    // A page is its own store root; `page_id` is the materializer-maintained
    // owning-page column, with `parent_id` covering a top-level block on a
    // page that predates it.
    const pageId = block.block_type === 'page' ? null : (block.page_id ?? block.parent_id ?? null)

    const [pageTitle, counts] = await Promise.all([
      pageId === null
        ? Promise.resolve(null)
        : commands
            .getBlock(pageId)
            .then(unwrap)
            .then((page) => resolveStoreTitle(page.block_type, page.content)),
      commands.countBacklinksBatch([refId], scope).then(unwrap),
    ])

    return {
      status: 'ready',
      title,
      content: block.content ?? '',
      pageTitle,
      refCount: counts[refId] ?? 0,
    }
  } catch (err) {
    // Never throw into the render: the chip stays exactly as it was and the
    // peek says it could not resolve the target.
    logger.warn('BlockRefPeek', 'failed to load peek target', { refId }, err)
    return { status: 'error' }
  }
}

interface BlockRefPeekProps {
  container: HTMLElement | null
}

export function BlockRefPeek({ container }: BlockRefPeekProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { refId, anchorRect, fromKeyboard, peekRef, close, keepOpen, scheduleClose, activateChip } =
    useBlockRefPeek(container)
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceName = useSpaceStore(
    (s) => s.availableSpaces.find((sp) => sp.id === s.currentSpaceId)?.name ?? null,
  )
  const reducedMotion = usePrefersReducedMotion()
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  const { data } = useQuery(
    {
      queryKey: ['blockRefPeek', spaceId, refId],
      // Both are non-null whenever `enabled` is true.
      queryFn: () => fetchPeekTarget(refId as string, spaceId as string),
      enabled: refId !== null && spaceId !== null,
      staleTime: PEEK_STALE_MS,
      gcTime: PEEK_GC_MS,
    },
    queryClient,
  )

  useEffect(() => {
    const peek = peekRef.current
    if (!anchorRect || !peek) {
      setPosition(null)
      return
    }
    const virtualEl = { getBoundingClientRect: () => anchorRect }
    // Same stale-placement guard as `LinkPreviewTooltip` (#2275): two peeks
    // opened in quick succession leave two promises in flight.
    let cancelled = false
    computePosition(virtualEl, peek, {
      placement: 'bottom-start',
      middleware: [flip(), shift({ padding: 8 })],
    })
      .then(({ x, y }) => {
        if (cancelled) return
        setPosition({ x, y })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        logger.warn('BlockRefPeek', 'computePosition failed, using fallback', { anchorRect }, err)
        setPosition({ x: anchorRect.left, y: anchorRect.bottom + 4 })
      })
    return () => {
      cancelled = true
    }
    // `data` is a dep on purpose: the first commit is the spinner, and a peek that
    // was placed below the chip while 40 px tall can grow past the viewport
    // once the payload lands; `flip()` has to see the full box.
  }, [anchorRect, peekRef, data])

  // A keyboard open moves focus INTO the peek; Escape puts it back on the chip.
  useEffect(() => {
    if (refId !== null && fromKeyboard) peekRef.current?.focus()
  }, [refId, fromKeyboard, peekRef])

  if (refId === null || anchorRect === null) return null

  const title =
    data === undefined || data.status === 'unresolved' || data.status === 'error'
      ? null
      : data.title

  return (
    <div
      ref={peekRef}
      data-testid="ref-peek"
      // Keeps the roving editor mounted when the peek takes focus
      // (`EDITOR_PORTAL_SELECTOR`, `@/hooks/useEditorBlur`).
      // Only a keyboard-opened peek takes focus, so only that one needs the
      // editor-blur exemption; on a hover peek the attribute would abort the
      // blur save for a click landing during the close grace.
      data-editor-portal={fromKeyboard ? '' : undefined}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <dialog> is modal (focus trap + inert background), which is wrong for a popover the pointer leaves by moving off it, and its non-modal form needs an imperative show() plus UA styles that fight floating-ui's placement
      role="dialog"
      aria-label={
        title === null ? t('refPeek.dialogLabelUnknown') : t('refPeek.dialogLabel', { title })
      }
      tabIndex={-1}
      onPointerEnter={keepOpen}
      onPointerLeave={scheduleClose}
      className={cn(
        'fixed z-50 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-md border',
        'bg-popover p-3 text-popover-foreground shadow-(--shadow-floating)',
        !reducedMotion && 'animate-in fade-in-0',
      )}
      style={
        position
          ? { left: position.x, top: position.y }
          : { left: anchorRect.left, top: anchorRect.bottom + 4, visibility: 'hidden' }
      }
    >
      {data === undefined ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" className="shrink-0" />
          {t('refPeek.loading')}
        </div>
      ) : data.status === 'unresolved' ? (
        <p className="text-xs text-muted-foreground">{t('refPeek.unresolved')}</p>
      ) : data.status === 'error' ? (
        <p className="text-xs text-muted-foreground">{t('refPeek.error')}</p>
      ) : data.status === 'deleted' ? (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t('refPeek.deleted', { title: data.title })}</span>
        </div>
      ) : (
        <>
          {data.pageTitle !== null && (
            <nav
              aria-label={t('refPeek.breadcrumbLabel')}
              className="truncate text-xs text-muted-foreground"
            >
              {spaceName === null
                ? data.pageTitle
                : t('refPeek.breadcrumb', { space: spaceName, page: data.pageTitle })}
            </nav>
          )}
          {data.content.trim().length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('refPeek.empty')}</p>
          ) : (
            <div className="ref-peek-content text-sm">
              {renderRichContent(data.content, { interactive: false })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs text-muted-foreground">
              {t('refPeek.references', { count: data.refCount })}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="xs" onClick={activateChip}>
                <ExternalLink aria-hidden="true" />
                {t('refPeek.open')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  writeText(`((${refId}))`)
                    .then(() => {
                      notify.success(t('contextMenu.blockRefCopied'))
                      close()
                    })
                    .catch((err: unknown) => {
                      logger.warn('BlockRefPeek', 'copy reference failed', { refId }, err)
                      notify.error(t('contextMenu.copyRefFailed'))
                    })
                }}
              >
                <Copy aria-hidden="true" />
                {t('refPeek.copyReference')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
