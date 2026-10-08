/**
 * BookmarksSection — the sidebar's collapsible Bookmarks list (#4713).
 *
 * There is ONE bookmark list, the `starred-pages` preference, and this is the
 * sidebar view over it. The page header, the Pages browser rows and its batch
 * toolbar write the same list, so a page bookmarked anywhere appears here.
 * (It used to be a second list — a `pinned` flag on recent pages, writable
 * only from the command palette — which meant the star and this section were
 * different features with the same name.)
 *
 * Titles come from the app-wide resolve cache rather than from the bookmark
 * entry, so a rename is reflected without rewriting storage. That cache is
 * keyed by `(space, id)`, which is also the space filter: a bookmark from
 * another space does not resolve under the active one and is left out. A
 * bookmark the cache has never held — a page created or synced in since the
 * last preload — is resolved on demand, space-scoped, rather than dropped
 * (#5075).
 *
 * Bookmarks are device-local (`localStorage`), so they do not sync. Moving
 * them into the DB is the follow-up #4713 defers.
 *
 * The list shows the stored order, and dragging a row (or Space, arrows,
 * Space) rewrites it (#5359). This is the only surface that shows that order;
 * the Pages browser's Bookmarks group follows its own sort.
 *
 * The disclosure state is a per-client view preference, so it lives in the
 * preferences registry (`PREFERENCES.bookmarksCollapsed`) rather than with
 * the bookmarks themselves.
 */

import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardCode,
  KeyboardSensor,
  type KeyboardSensorOptions,
  PointerSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Bookmark, BookmarkX } from 'lucide-react'
import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MOUSE_DRAG_ACTIVATION_DISTANCE } from '@/components/block-tree/use-block-dnd'
import {
  LONG_PRESS_DELAY,
  LONG_PRESS_MOVE_THRESHOLD,
} from '@/components/block-tree/use-block-touch-long-press'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useStarredPages } from '@/hooks/useStarredPages'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { resolveStoreTitle } from '@/lib/block-title'
import { logger } from '@/lib/logger'
import { getPageDisplayName } from '@/lib/page-display'
import { PREFERENCES, usePreference } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

/** Shared empty set, so a space with nothing asked yet keeps a stable identity. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/**
 * Space picks a bookmark up; Enter is left to the button, so it still opens
 * the page. Enter and Tab still drop one that is already up.
 */
const KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: {
    start: [KeyboardCode.Space],
    cancel: [KeyboardCode.Esc],
    end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
  },
}

interface BookmarkEntry {
  pageId: string
  title: string
}

interface SortableBookmarkProps extends BookmarkEntry {
  onOpen: (pageId: string, title: string) => void
  onRemove: (pageId: string) => void
}

/** One bookmark row. The whole button is the drag handle; the remove action is not. */
function SortableBookmark({ pageId, title, onOpen, onRemove }: SortableBookmarkProps) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pageId })
  const fullTitle = title || t('recent.untitled')
  const label = getPageDisplayName(fullTitle, 'leaf').label

  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'z-10 rounded-md bg-sidebar-accent')}
    >
      <SidebarMenuButton
        ref={setActivatorNodeRef}
        tooltip={fullTitle}
        title={fullTitle}
        {...attributes}
        {...listeners}
        onClick={() => onOpen(pageId, title)}
      >
        <Bookmark />
        <span className="truncate">{label}</span>
      </SidebarMenuButton>
      <SidebarMenuAction
        showOnHover
        aria-label={t('bookmarks.remove', { title: fullTitle })}
        // `SidebarMenuAction` already grows its hit area by
        // `after:-inset-2` (36px) on the mobile breakpoint; -inset-3
        // around the 20px button is the 44px touch target.
        className="[@media(pointer:coarse)]:after:-inset-3"
        onClick={() => onRemove(pageId)}
      >
        <BookmarkX />
      </SidebarMenuAction>
    </SidebarMenuItem>
  )
}

export function BookmarksSection(): ReactElement {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = usePreference(PREFERENCES.bookmarksCollapsed)

  const { starredIds, toggle, move } = useStarredPages()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // Re-resolve when the cache lands new titles, a rename edits one, or a
  // space switch flushes the previous space's entries.
  const resolveVersion = useResolveStore((s) => s.version)
  /**
   * The bookmark ids this section has asked the backend about and had an
   * answer for — whether or not the answer contained them — and the space they
   * were asked in.
   *
   * An id the answer left out (another space's, or purged) belongs here so the
   * ask is not repeated: the store write that follows an answer bumps
   * `resolveVersion`, which recomputes the pending set below, which would
   * re-fire the resolve effect for that id forever.
   *
   * Scoped to the space because switching AWAY flushes that space's cache
   * (`clearAllForSpace`, `useAppSpaceLifecycle`) while this component stays
   * mounted and keeps the set. Coming back, those ids are uncached AND already
   * recorded as asked, so they would be neither rendered nor pending — the
   * false empty state this whole change exists to remove.
   */
  const [asked, setAsked] = useState<{ space: string | null; ids: ReadonlySet<string> }>(() => ({
    space: null,
    ids: EMPTY_IDS,
  }))
  const askedIds = asked.space === currentSpaceId ? asked.ids : EMPTY_IDS

  /**
   * The one pass over the bookmark list: what this space can render, and what
   * it still has to ask about.
   *
   * `pendingIds` are the starred ids the cache does not hold and that have not
   * been looked up. `preload` scans on boot, on a space switch and on
   * `sync:complete` only, so a page bookmarked in the session it was created
   * in — or synced in from another device — is in neither list, and dropping
   * it left the section claiming the user had no bookmarks at all (#5075).
   */
  const { bookmarks, pendingKey } = useMemo(() => {
    const resolve = useResolveStore.getState()
    const resolved: BookmarkEntry[] = []
    const pending: string[] = []
    for (const id of starredIds) {
      if (resolve.isResolved(id)) {
        // A trashed page stays starred (a restore lists it again) but is not
        // listed: every click on it would only toast "in the trash" (#5293).
        if (resolve.resolveStatus(id) === 'active') {
          resolved.push({ pageId: id, title: resolve.resolveTitle(id) })
        }
      } else if (!askedIds.has(id)) pending.push(id)
    }
    // A string, not the array: the effect below re-runs on identity, and this
    // memo recomputes on every `resolveVersion` bump — a page-picker keystroke
    // (#753) included. A fresh array each time would cancel an in-flight
    // lookup and re-issue it per keystroke. ULIDs carry no spaces.
    return { bookmarks: resolved, pendingKey: pending.join(' ') }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `resolveVersion` IS the dependency; the store is read imperatively so the memo does not re-run per unrelated cache write
  }, [starredIds, resolveVersion, askedIds])

  useEffect(() => {
    const pendingIds = pendingKey === '' ? [] : pendingKey.split(' ')
    // Fail closed while the space store hydrates, as `preload` does: an
    // unscoped resolve would serve another space's title here.
    if (pendingIds.length === 0 || currentSpaceId == null) return
    let cancelled = false
    void (async () => {
      try {
        // Space-scoped, so a bookmark from another space drops out of the
        // response and stays hidden — the barrier the cache lookup gives the
        // already-resolved ids.
        const rows = unwrap(
          await commands.batchResolve(pendingIds, { kind: 'active', space_id: currentSpaceId }),
        )
        if (cancelled) return
        // Marked before the store write so one render sees both.
        setAsked((prev) => {
          const ids = new Set(prev.space === currentSpaceId ? prev.ids : EMPTY_IDS)
          for (const id of pendingIds) ids.add(id)
          return { space: currentSpaceId, ids }
        })
        useResolveStore.getState().batchSet(
          rows.map((r) => ({
            id: r.id,
            title: resolveStoreTitle(r.block_type, r.title),
            deleted: r.deleted,
          })),
        )
      } catch (err) {
        // Deliberately still pending: an id we never got an answer for must not
        // count towards the empty state.
        logger.warn('BookmarksSection', 'Failed to resolve bookmarked pages', undefined, err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pendingKey, currentSpaceId])

  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const { isMobile, setOpenMobile } = useSidebar()

  // The block tree's pointer sensors (`use-block-dnd.ts`): on a coarse pointer
  // the drag waits for the long-press hold, so a swipe still scrolls the
  // drawer; on a fine one it waits for 8px of travel, so a click still opens
  // the page.
  const isTouch = useIsTouch()
  const sensors = useSensors(
    useSensor(isTouch ? TouchSensor : PointerSensor, {
      activationConstraint: isTouch
        ? { delay: LONG_PRESS_DELAY, tolerance: LONG_PRESS_MOVE_THRESHOLD }
        : { distance: MOUSE_DRAG_ACTIVATION_DISTANCE },
    }),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  )

  // dnd-kit's default announcements read the id, which here is a ULID (#2943).
  const dndAccessibility = useMemo(() => {
    const titleOf = (id: UniqueIdentifier): string =>
      bookmarks.find((b) => b.pageId === id)?.title || t('recent.untitled')
    const announcements: Announcements = {
      onDragStart: ({ active }) => t('dnd.pickedUp', { block: titleOf(active.id) }),
      onDragOver: ({ active, over }) =>
        over
          ? t('dnd.movedOver', { block: titleOf(active.id), target: titleOf(over.id) })
          : t('dnd.movedOutside', { block: titleOf(active.id) }),
      onDragEnd: ({ active, over }) =>
        over
          ? t('dnd.dropped', { block: titleOf(active.id), target: titleOf(over.id) })
          : t('dnd.droppedOutside', { block: titleOf(active.id) }),
      onDragCancel: ({ active }) => t('dnd.cancelled', { block: titleOf(active.id) }),
    }
    return {
      announcements,
      screenReaderInstructions: { draggable: t('bookmarks.reorderInstructions') },
    }
  }, [bookmarks, t])

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) move(String(active.id), String(over.id))
  }

  const openBookmark = (pageId: string, title: string) => {
    navigateToPage(pageId, title)
    if (isMobile) setOpenMobile(false)
  }

  return (
    <SidebarGroup data-testid="sidebar-bookmarks">
      {/*
       * Unlike a static `SidebarGroupLabel`, this header has to
       * disclose, so it borrows the app's disclosure header and
       * takes the group-label metrics (h-8 / px-2 / text-xs). Hidden in the
       * icon rail for the same reason `SidebarGroupLabel` is: there is no
       * room for a text header there.
       */}
      <CollapsiblePanelHeader
        isCollapsed={collapsed}
        onToggle={() => setCollapsed((prev) => !prev)}
        testId="sidebar-bookmarks-toggle"
        className="h-8 px-2 py-0 text-xs font-medium group-data-[collapsible=icon]:hidden"
      >
        {t('bookmarks.title')}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <SidebarGroupContent>
          {bookmarks.length === 0 ? (
            // Claim emptiness only when it is true: every bookmark has been
            // looked up, and none of them belong to this space. While one is
            // still pending this would tell a user with bookmarks that they
            // have none.
            // The hint has no icon-rail layout, and the rail already hides
            // the header that explains it.
            pendingKey === '' ? (
              <p className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                {t('bookmarks.emptyHint')}
              </p>
            ) : null
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              accessibility={dndAccessibility}
            >
              <SortableContext
                items={bookmarks.map((b) => b.pageId)}
                strategy={verticalListSortingStrategy}
              >
                <SidebarMenu aria-label={t('bookmarks.title')}>
                  {bookmarks.map((page) => (
                    <SortableBookmark
                      key={page.pageId}
                      pageId={page.pageId}
                      title={page.title}
                      onOpen={openBookmark}
                      onRemove={toggle}
                    />
                  ))}
                </SidebarMenu>
              </SortableContext>
            </DndContext>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  )
}
