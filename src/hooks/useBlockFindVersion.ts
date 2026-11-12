/**
 * useBlockFindVersion — when in-page find over block text must run again
 * (#6557). Find counts the page store's blocks, so the count goes stale when a
 * mounted tree's blocks change, a tree mounts or unmounts, or a page or tag
 * title it shows changes. Each bumps the returned version, once per frame.
 *
 * Rows also hydrate, mount and change as the user scrolls and edits; while
 * find holds block matches (`hasBlockMatches`), a DOM change calls `repaint`.
 * Before that, a DOM change that brings a tree's rows into the container
 * bumps the version too: find may have run before the rows rendered.
 */

import { useEffect, useState } from 'react'

import {
  mountedTreeStores,
  subscribeBlockCommandTargets,
  treeStoresIn,
} from '@/stores/block-command-bus'
import { useResolveStore } from '@/stores/resolve'

export function useBlockFindVersion({
  open,
  container,
  hasBlockMatches,
  repaint,
  onTitlesChanged,
}: {
  open: boolean
  container: HTMLElement | null
  hasBlockMatches: () => boolean
  repaint: () => void
  onTitlesChanged: () => void
}): number {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!open) return
    let frame = 0
    const bump = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setVersion((v) => v + 1)
      })
    }
    let unsubscribeStores: Array<() => void> = []
    const watchStores = () => {
      for (const unsubscribe of unsubscribeStores) unsubscribe()
      unsubscribeStores = mountedTreeStores().map((store) =>
        store.subscribe((next, prev) => {
          if (next.blocks !== prev.blocks) bump()
        }),
      )
    }
    watchStores()
    const unsubscribeTrees = subscribeBlockCommandTargets(() => {
      watchStores()
      bump()
    })
    const unsubscribeTitles = useResolveStore.subscribe((next, prev) => {
      if (next.version === prev.version) return
      onTitlesChanged()
      bump()
    })
    return () => {
      cancelAnimationFrame(frame)
      unsubscribeTrees()
      unsubscribeTitles()
      for (const unsubscribe of unsubscribeStores) unsubscribe()
    }
  }, [open, onTitlesChanged])

  useEffect(() => {
    if (!open || !container) return
    let frame = 0
    const observer = new MutationObserver(() => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (hasBlockMatches()) repaint()
        else if (treeStoresIn(container).length > 0) setVersion((v) => v + 1)
      })
    })
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [open, container, hasBlockMatches, repaint])

  return version
}
