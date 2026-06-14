/**
 * Suggestion popup renderer factory.
 *
 * Creates a floating popup that positions itself below the trigger
 * character using clientRect from the Suggestion plugin. Uses
 * ReactRenderer from @tiptap/react to render outside the main tree.
 */

import { computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import type { Editor } from '@tiptap/core'
import type { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'

import { applySafePosition } from '../lib/floating-position'
import { getShortcutKeys } from '../lib/keyboard-config'
import { logger } from '../lib/logger'
import { SUGGESTION_LISTBOX_ID, SuggestionList, type SuggestionListRef } from './SuggestionList'

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
 * memory). The base `role="textbox"` is restored on exit.
 */
function openCombobox(dom: HTMLElement, listboxId: string): void {
  dom.setAttribute('role', 'combobox')
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
 * resting `role="textbox"` (the value set in `use-roving-editor.ts`
 * `EDITOR_PROPS`). Called on every exit path (onExit, Escape, outside click).
 */
function closeCombobox(dom: HTMLElement): void {
  dom.setAttribute('role', 'textbox')
  dom.removeAttribute('aria-expanded')
  dom.removeAttribute('aria-controls')
  dom.removeAttribute('aria-autocomplete')
  dom.removeAttribute('aria-activedescendant')
}

/**
 * Mobile / touch viewports get a larger flip+shift padding (16px) plus a
 * `size()` middleware that caps the popup height at 60vh. Desktop keeps the
 * original 8px padding and natural sizing (UX-273). Detection is via
 * `(pointer: coarse)` so it matches the rest of the design system's
 * touch-target rules.
 */
const DESKTOP_PADDING = 8
const COARSE_PADDING = 16
const COARSE_MAX_HEIGHT_RATIO = 0.6

async function updatePosition(
  el: HTMLElement,
  props: {
    editor: Editor
    range: { from: number; to: number }
    clientRect?: (() => DOMRect | null) | null
  },
): Promise<void> {
  if (!el) return

  // Wait for the editor view to flush its DOM update so coordsAtPos returns fresh values
  await new Promise((resolve) => requestAnimationFrame(resolve))

  // Try cursor position first (more accurate — follows the end of typed text)
  let rect: DOMRect | null = null
  try {
    const coords = props.editor.view.coordsAtPos(props.range.to)
    if (coords) {
      rect = new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top)
    }
  } catch {
    logger.debug('SuggestionRenderer', 'coordsAtPos fallback to clientRect')
  }

  // Fallback to trigger clientRect
  if (!rect && props.clientRect) {
    rect = props.clientRect()
  }

  if (!rect) return

  const virtualEl = {
    getBoundingClientRect: () => rect,
  }

  // Mobile/touch viewports get a larger padding so popups don't clip near
  // the bottom of narrow viewports, plus a `size()` middleware that caps
  // the popup at 60vh. Desktop behavior is unchanged (UX-273).
  const isCoarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  const padding = isCoarsePointer ? COARSE_PADDING : DESKTOP_PADDING
  const middleware = [offset(4), flip({ padding }), shift({ padding })]
  if (isCoarsePointer) {
    middleware.push(
      size({
        padding,
        apply({ availableHeight, elements }) {
          const cap = window.innerHeight * COARSE_MAX_HEIGHT_RATIO
          const maxH = Math.max(0, Math.min(availableHeight, cap))
          Object.assign(elements.floating.style, {
            maxHeight: `${maxH}px`,
            overflowY: 'auto',
          })
        },
      }),
    )
  }

  const { x, y } = await computePosition(virtualEl, el, {
    placement: 'bottom-start',
    middleware,
  })

  // MAINT-175: shared helper applies coordinates; `position: 'fixed'` and
  // `zIndex: '50'` are set during initial popup creation in `onStart`.
  applySafePosition(el, { x, y })
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
  // PEND-27 P7: pending rAF id used to coalesce `onUpdate` position
  // recomputes. The popup must track the cursor, but if the user types
  // multiple characters within a single frame we only need one
  // `computePosition` per frame. Cancelled in every teardown path so the
  // rAF callback never runs against a destroyed popup.
  let pendingPositionFrame: number | null = null

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
    if (pendingPositionFrame !== null) {
      cancelAnimationFrame(pendingPositionFrame)
      pendingPositionFrame = null
    }
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
      popup.setAttribute('aria-label', label ?? 'Suggestions')
      // Start off-screen to avoid flash at (0,0) before positioning settles.
      // MAINT-175: shared helper for the off-screen fallback.
      Object.assign(popup.style, {
        position: 'fixed',
        zIndex: '50',
      })
      applySafePosition(popup, null)
      document.body.appendChild(popup)
      popup.appendChild(renderer.element)
      const popupRef = popup
      updatePosition(popup, props).catch((err: unknown) => {
        logger.warn('SuggestionRenderer', 'Position update failed', { label }, err)
        // MAINT-175: keep popup off-screen on failure rather than at the
        // last computed coordinates, which would orphan it mid-page.
        applySafePosition(popupRef, null)
      })

      // Dismiss popup on outside click (capture phase, like BlockContextMenu).
      // Defer listener registration by one frame to avoid catching pointer events
      // from the same event loop tick that triggered the popup (BUG-2 fix).
      outsideClickHandler = (e: PointerEvent) => {
        if (popup && !popup.contains(e.target as Node)) {
          logger.warn('SuggestionRenderer', 'outside click — deactivating plugin', { label })
          // Deactivate the Suggestion plugin so it doesn't stay stuck
          // active with a null renderer (B-77 fix layer 1).
          dispatchExitMeta()
          // #1102 — restore textbox semantics before we drop the references.
          teardownCombobox()
          cleanupListener()
          renderer?.destroy()
          renderer = null
          popup?.remove()
          popup = null
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
      renderer.updateProps(props)
      if (!popup) return
      // PEND-27 P7: coalesce per-frame so burst typing (>1 keystroke per
      // frame) collapses to a single `computePosition` call. Cancel any
      // previously-scheduled frame before scheduling a new one.
      if (pendingPositionFrame !== null) {
        cancelAnimationFrame(pendingPositionFrame)
      }
      const popupRef = popup
      pendingPositionFrame = requestAnimationFrame(() => {
        pendingPositionFrame = null
        // The popup may have been destroyed between scheduling and now
        // (teardown paths null `popup` and call `cancelAnimationFrame`,
        // but defend against any stragglers).
        if (!popup) return
        updatePosition(popupRef, props).catch((err: unknown) => {
          logger.warn('SuggestionRenderer', 'Position update failed', { label }, err)
          // MAINT-175: keep popup off-screen on failure rather than at the
          // last computed coordinates, which would orphan it mid-page.
          applySafePosition(popupRef, null)
        })
      })
    },

    onKeyDown({ event }: SuggestionKeyDownProps) {
      const closeKey = getShortcutKeys('suggestionClose').toLowerCase()
      if (event.key.toLowerCase() === closeKey) {
        // #727 — deactivate the plugin FIRST. Previously this path destroyed the
        // renderer + popup but never dispatched `{ exit: true }`, so the
        // Suggestion plugin stayed ACTIVE: continued typing extended the query
        // against a null renderer (the `onUpdate` desync warn). Mirror the
        // outside-click path's exit dispatch.
        dispatchExitMeta()
        // #1102 — Escape closes the picker; restore textbox semantics.
        teardownCombobox()
        cleanupListener()
        renderer?.destroy()
        renderer = null
        popup?.remove()
        popup = null
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
      // #1102 — restore textbox semantics on the contenteditable BEFORE we drop
      // `editorRef` (teardownCombobox reads it).
      teardownCombobox()
      cleanupListener()
      renderer?.destroy()
      renderer = null
      popup?.remove()
      popup = null
      editorRef = null
    },
  }
}
