/**
 * Suggestion popup renderer factory.
 *
 * Creates one floating popup per open picker, anchored to the trigger and
 * kept still while the query grows (`suggestion-placement.ts`). Uses
 * ReactRenderer from @tiptap/react to render outside the main tree.
 */

import { autoUpdate } from '@floating-ui/dom'
import type { Editor } from '@tiptap/core'
import type { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'

import {
  chooseSuggestionSide,
  placeSuggestionPopup,
  type SuggestionAnchor,
  type SuggestionSide,
} from '@/editor/suggestion-placement'
import {
  SUGGESTION_LISTBOX_ID,
  SuggestionList,
  type SuggestionListRef,
} from '@/editor/SuggestionList'
import type { PickerItem } from '@/editor/SuggestionList'
import { applySafePosition } from '@/lib/floating-position'
import { t } from '@/lib/i18n'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'

/**
 * #1102 — WCAG editable-combobox wiring.
 *
 * The picker listbox is portaled to `document.body` and never holds focus;
 * focus stays in the ProseMirror contenteditable. So the combobox semantics
 * (role + expanded + controls + activedescendant) must live on the focused
 * contenteditable (`editor.view.dom`), not on the listbox.
 *
 * We mutate `editor.view.dom` attributes DIRECTLY rather than going through
 * `editorProps.attributes` (which would churn the whole view on every keystroke)
 * and WITHOUT any `instanceof` on ProseMirror types (module-copy footgun — a
 * second @tiptap/pm/state copy makes `instanceof` silently false; see project
 * memory). The base `role="textbox"` is restored on exit. `aria-multiline`
 * belongs to a textbox alone (`aria-allowed-attr`), so it is off while the
 * contenteditable is a combobox.
 */
function openCombobox(dom: HTMLElement, listboxId: string): void {
  dom.setAttribute('role', 'combobox')
  dom.removeAttribute('aria-multiline')
  dom.setAttribute('aria-expanded', 'true')
  dom.setAttribute('aria-controls', listboxId)
  dom.setAttribute('aria-autocomplete', 'list')
}

/**
 * #1102 — keep `aria-activedescendant` on the focused contenteditable in sync
 * with the highlighted option as arrow navigation moves it. Removing the
 * attribute when there is no active option avoids pointing at a stale id.
 */
function setActiveDescendant(dom: HTMLElement, id: string | null): void {
  if (id) dom.setAttribute('aria-activedescendant', id)
  else dom.removeAttribute('aria-activedescendant')
}

/**
 * #1102 — tear down the combobox semantics and restore the contenteditable's
 * resting multiline `role="textbox"` (the value set in `use-roving-editor.ts`
 * `EDITOR_PROPS` and `PageSourceBuffer`). Called on every exit path (onExit,
 * Escape, outside click).
 */
function closeCombobox(dom: HTMLElement): void {
  dom.setAttribute('role', 'textbox')
  dom.setAttribute('aria-multiline', 'true')
  dom.removeAttribute('aria-expanded')
  dom.removeAttribute('aria-controls')
  dom.removeAttribute('aria-autocomplete')
  dom.removeAttribute('aria-activedescendant')
}

/**
 * Coarse pointers get a wider edge padding and a 60vh height cap, matching
 * the design system's touch rules.
 */
const DESKTOP_PADDING = 8
const COARSE_PADDING = 16
const COARSE_MAX_HEIGHT_RATIO = 0.6
const GAP = 4
/** The list's own cap (`max-h` in `SuggestionList`) plus its footer and border. */
const PREFERRED_HEIGHT = 340

interface AnchorProps {
  editor: Editor
  range: { from: number; to: number }
  clientRect?: (() => DOMRect | null) | null
}

/**
 * The trigger's left edge, and the lines from the trigger to the caret: the
 * popup sits beside those lines, so typing never moves it sideways and a query
 * that wraps pushes it clear of the new line.
 */
function anchorFor(props: AnchorProps): SuggestionAnchor | null {
  try {
    const from = props.editor.view.coordsAtPos(props.range.from)
    const to = props.editor.view.coordsAtPos(props.range.to)
    return {
      left: from.left,
      top: Math.min(from.top, to.top),
      bottom: Math.max(from.bottom, to.bottom),
    }
  } catch {
    logger.debug('SuggestionRenderer', 'coordsAtPos fallback to clientRect')
  }
  // The plugin's rect is its decoration, which spans the trigger and query.
  const rect = props.clientRect?.()
  return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null
}

/** The part of the viewport a fixed popup can use: above an on-screen keyboard. */
function usableViewport(): { width: number; height: number } {
  const { clientWidth, clientHeight } = document.documentElement
  const vv = window.visualViewport
  const height = vv ? Math.min(clientHeight, vv.offsetTop + vv.height) : clientHeight
  return { width: clientWidth, height }
}

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/**
 * Place `el` beside `anchor` on `side`. Below, its top edge is pinned; above,
 * its bottom edge (CSS `bottom`), so results growing or shrinking never move
 * the edge next to the line.
 */
function placePopup(el: HTMLElement, anchor: SuggestionAnchor, side: SuggestionSide): void {
  const coarse = isCoarsePointer()
  const viewport = usableViewport()
  const placed = placeSuggestionPopup({
    anchor,
    side,
    viewport,
    popupWidth: el.offsetWidth,
    gap: GAP,
    padding: coarse ? COARSE_PADDING : DESKTOP_PADDING,
  })
  if (!placed) {
    el.style.bottom = ''
    applySafePosition(el, null)
    return
  }
  const cap = coarse ? window.innerHeight * COARSE_MAX_HEIGHT_RATIO : Infinity
  Object.assign(el.style, {
    left: `${placed.left}px`,
    top: side === 'below' ? `${placed.edge}px` : '',
    bottom: side === 'above' ? `${document.documentElement.clientHeight - placed.edge}px` : '',
    maxHeight: `${Math.min(placed.maxHeight, cap)}px`,
    overflowY: 'auto',
  })
}

/**
 * Remove all orphaned `.suggestion-popup` elements from `document.body`.
 * Called as a safety net during mount/unmount to prevent DOM accumulation
 * when the normal `onExit()` lifecycle is bypassed (B-77).
 */
export function cleanupOrphanedPopups(): number {
  const orphans = document.querySelectorAll('.suggestion-popup')
  const count = orphans.length
  for (const el of orphans) el.remove()
  if (count > 0) {
    logger.warn('SuggestionRenderer', 'cleaned up orphaned popups', { count })
  }
  return count
}

export function createSuggestionRenderer(
  label?: string,
  pluginKey?: PluginKey,
  triggerChar?: string,
) {
  let renderer: ReactRenderer<SuggestionListRef> | null = null
  let popup: HTMLDivElement | null = null
  let outsideClickHandler: ((e: PointerEvent) => void) | null = null
  let editorRef: Editor | null = null
  let deferredRegistrationId: number | null = null
  // One open picker: the latest props anchor it, its side is fixed at the
  // first placement, and the last fetched items stay on screen while the
  // plugin fetches the next ones (it sends `items: []` with `loading`).
  let latest: AnchorProps | null = null
  let side: SuggestionSide | null = null
  let shownItems: PickerItem[] = []
  let stopAutoUpdate: (() => void) | null = null

  /** Re-place for a layout change (scroll, resize, the editor moving), not per keystroke. */
  function reposition() {
    if (!popup || !latest) return
    const anchor = anchorFor(latest)
    if (!anchor) return
    const padding = isCoarsePointer() ? COARSE_PADDING : DESKTOP_PADDING
    side ??= chooseSuggestionSide(anchor, usableViewport().height, PREFERRED_HEIGHT, GAP, padding)
    placePopup(popup, anchor, side)
  }

  /** Show the popup once it has results; plays the entry animation once. */
  function reveal() {
    if (!popup || popup.dataset['open'] !== undefined) return
    popup.style.visibility = ''
    popup.dataset['open'] = ''
  }

  /**
   * #1102 — restore the contenteditable's resting `role="textbox"` and drop the
   * combobox attrs. Guards against a destroyed/absent view so it is safe to call
   * from any teardown path. Idempotent.
   */
  function teardownCombobox() {
    const dom = editorRef?.view?.dom
    if (dom instanceof HTMLElement) closeCombobox(dom)
  }

  function cleanupListener() {
    if (deferredRegistrationId !== null) {
      cancelAnimationFrame(deferredRegistrationId)
      deferredRegistrationId = null
    }
    stopAutoUpdate?.()
    stopAutoUpdate = null
    if (outsideClickHandler) {
      document.removeEventListener('pointerdown', outsideClickHandler, true)
      outsideClickHandler = null
    }
  }

  /**
   * #727 — deactivate the Suggestion plugin by dispatching its `{ exit: true }`
   * meta, the same signal the B-77 mount/unmount layers and the outside-click
   * handler use. Without it the plugin stays ACTIVE after the renderer/popup are
   * torn down: continued typing keeps extending the query against a null
   * renderer (the `onUpdate` "plugin state desync" warn this file anticipates).
   * Guards a destroyed/absent view exactly like the outside-click path. No
   * `instanceof` on PM types — duck-typed via the captured `editorRef`/`pluginKey`
   * refs (module-copy footgun; see project memory).
   */
  function dispatchExitMeta() {
    if (!editorRef || !pluginKey) return
    if (editorRef.view.isDestroyed) {
      logger.warn('SuggestionRenderer', 'skipping exit dispatch — view destroyed', { label })
      return
    }
    try {
      const { tr } = editorRef.state
      tr.setMeta(pluginKey, { exit: true })
      tr.setMeta('addToHistory', false)
      editorRef.view.dispatch(tr)
    } catch (err) {
      logger.warn('SuggestionRenderer', 'failed to dispatch exit meta', { label }, err)
    }
  }

  /**
   * Close the popup through one idempotent teardown path.
   *
   * Escape and outside-click must dispatch the Suggestion plugin's exit meta
   * before releasing any captured state. That dispatch can synchronously call
   * `onExit()`, so this function deliberately tolerates re-entry: after the
   * optional dispatch, it snapshots and clears the renderer/popup references
   * before invoking their teardown methods. The outer call then observes null
   * state after a synchronous nested `onExit()` and becomes a harmless no-op.
   *
   * `editorRef` is only cleared when `dispatchExit` is false (i.e. this call
   * IS the actual `onExit()`), never by the Escape/outside-click callers
   * themselves. On a successful dispatch, the plugin synchronously re-enters
   * via `onExit()` (`dispatchExit: false`), which clears it there. On a
   * failed dispatch (`dispatchExitMeta()` catches internally and returns
   * without re-entering), `editorRef` must survive so a second Escape or
   * outside-click can retry the dispatch — matching the pre-refactor
   * behaviour where only `onExit()` ever nulled `editorRef`.
   */
  function closePopup({ dispatchExit }: { dispatchExit: boolean }): void {
    if (dispatchExit) dispatchExitMeta()

    // Restore combobox semantics while the captured editor is still available.
    teardownCombobox()
    cleanupListener()

    // Clear shared state before calling external teardown hooks so any nested
    // lifecycle callback cannot destroy/remove the same objects twice.
    const rendererToDestroy = renderer
    const popupToRemove = popup
    renderer = null
    popup = null
    latest = null
    side = null
    shownItems = []
    if (!dispatchExit) editorRef = null

    rendererToDestroy?.destroy()
    popupToRemove?.remove()
  }

  return {
    onStart(props: SuggestionProps) {
      logger.debug('SuggestionRenderer', 'onStart', { label, query: props.query })

      editorRef = props.editor

      // Clean up any previous popup to prevent DOM accumulation
      cleanupListener()
      if (renderer) renderer.destroy()
      if (popup) {
        popup.remove()
        popup = null
      }

      // #1102 — promote the focused contenteditable to a combobox and point its
      // `aria-controls` at the (stable-id) listbox the React renderer mounts.
      // `onActiveDescendantChange` mirrors the highlighted option id back onto
      // the contenteditable so the active row is announced as arrows move it.
      const comboboxDom = props.editor?.view?.dom
      const onActiveDescendantChange = (id: string | null) => {
        const dom = editorRef?.view?.dom
        if (dom instanceof HTMLElement) setActiveDescendant(dom, id)
      }
      if (comboboxDom instanceof HTMLElement) {
        openCombobox(comboboxDom, SUGGESTION_LISTBOX_ID)
      }

      renderer = new ReactRenderer(SuggestionList, {
        props: {
          ...props,
          label,
          triggerChar,
          listboxId: SUGGESTION_LISTBOX_ID,
          onActiveDescendantChange,
        },
        editor: props.editor,
      })

      popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      popup.dataset['testid'] = 'suggestion-popup'
      popup.setAttribute('data-editor-portal', '')
      popup.setAttribute('role', 'region')
      popup.setAttribute('aria-label', label ?? t('editor.suggestion.fallback'))
      // Off-screen and hidden until placed and given its first results, so
      // it never shows at (0,0) or as a "no results" flash.
      Object.assign(popup.style, {
        position: 'fixed',
        zIndex: '50',
        visibility: 'hidden',
      })
      applySafePosition(popup, null)
      document.body.append(popup)
      popup.append(renderer.element)
      latest = props
      shownItems = props.items
      if (!props.loading) reveal()
      reposition()
      const editorDom = props.editor?.view?.dom
      if (editorDom instanceof HTMLElement) {
        stopAutoUpdate = autoUpdate(editorDom, popup, reposition)
      }

      // Dismiss popup on outside click (capture phase, like BlockContextMenu).
      // Defer listener registration by one frame to avoid catching pointer events
      // From the same event loop tick that triggered the popup (fix).
      outsideClickHandler = (e: PointerEvent) => {
        if (popup && !popup.contains(e.target as Node)) {
          logger.warn('SuggestionRenderer', 'outside click — deactivating plugin', { label })
          // Deactivate the Suggestion plugin so it doesn't stay stuck
          // active with a null renderer (B-77 fix layer 1).
          closePopup({ dispatchExit: true })
        }
      }
      deferredRegistrationId = requestAnimationFrame(() => {
        deferredRegistrationId = null
        // Guard: popup may have been destroyed by onExit before the frame fires
        if (popup && outsideClickHandler) {
          document.addEventListener('pointerdown', outsideClickHandler, true)
        }
      })
    },

    onUpdate(props: SuggestionProps) {
      if (!renderer) {
        logger.warn(
          'SuggestionRenderer',
          'onUpdate called with null renderer — plugin state desync',
          { label, query: props.query },
        )
        return
      }
      latest = props
      if (props.loading) {
        renderer.updateProps({ ...props, items: shownItems })
        return
      }
      shownItems = props.items
      renderer.updateProps(props)
      reveal()
    },

    onKeyDown({ event }: SuggestionKeyDownProps) {
      const closeKey = getShortcutKeys('suggestionClose').toLowerCase()
      if (event.key.toLowerCase() === closeKey) {
        // #727 — deactivate the plugin FIRST. Previously this path destroyed the
        // renderer + popup but never dispatched `{ exit: true }`, so the
        // Suggestion plugin stayed ACTIVE: continued typing extended the query
        // against a null renderer (the `onUpdate` desync warn). Mirror the
        // outside-click path's exit dispatch.
        closePopup({ dispatchExit: true })
        return true
      }
      // Space: let it pass through to the editor so it's inserted as text
      // in the query (e.g. [[multi word page]]). Without this, the shared
      // useListKeyboardNavigation hook would treat Space as item selection.
      const passKey = getShortcutKeys('suggestionPassSpace').toLowerCase()
      if ((event.key === ' ' && passKey === 'space') || event.key.toLowerCase() === passKey) {
        return false
      }
      // Tab: autocomplete with the currently highlighted item (same as Enter)
      const autocompleteKey = getShortcutKeys('suggestionAutocomplete').toLowerCase()
      if (event.key.toLowerCase() === autocompleteKey) {
        const syntheticEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        return renderer?.ref?.onKeyDown?.({ event: syntheticEnter }) ?? false
      }
      if (!renderer) {
        logger.warn('SuggestionRenderer', 'onKeyDown called with null renderer', {
          label,
          key: event.key,
        })
        return false
      }
      return renderer.ref?.onKeyDown?.({ event }) ?? false
    },

    onExit() {
      logger.debug('SuggestionRenderer', 'onExit', { label })
      closePopup({ dispatchExit: false })
    },
  }
}
