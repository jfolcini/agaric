/**
 * BlockPropertyEditor — inline edit popup for block properties.
 *
 * MAINT-103: Renders the popup as a React portal anchored to a 0×0 placeholder
 * sibling and positions it with `@floating-ui/dom` (`computePosition` +
 * `autoUpdate`). This mirrors `suggestion-renderer.ts` so the popup escapes
 * `overflow: hidden` ancestors and reflows on scroll/resize. The portal carries
 * `data-editor-portal` so `EDITOR_PORTAL_SELECTORS` (see `useEditorBlur.ts`)
 * recognises it as transient editor UI and does not blur the surrounding block.
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ScrollArea } from '@/components/ui/scroll-area'
import { applySafePosition } from '@/lib/floating-position'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { reportIpcError } from '@/lib/report-ipc-error'
import type { BlockRow } from '@/lib/tauri'
import { setProperty } from '@/lib/tauri'
import { cn } from '@/lib/utils'

export interface BlockPropertyEditorProps {
  blockId: string
  editingProp: { key: string; value: string } | null
  setEditingProp: (prop: { key: string; value: string } | null) => void
  editingKey: { oldKey: string; value: string } | null
  setEditingKey: (keyInfo: { oldKey: string; value: string } | null) => void
  selectOptions: string[] | null
  isRefProp: boolean
  refPages: BlockRow[]
  refSearch: string
  setRefSearch: (search: string) => void
}

/** Placeholder offsets used while the popup is mounted but before the first
 *  `computePosition` call resolves — keeps it off-screen to prevent a flash
 *  at (0, 0). Mirrors the pattern in `suggestion-renderer.ts`. */
const HIDDEN_LEFT = '-9999px'
const HIDDEN_TOP = '-9999px'

export function BlockPropertyEditor({
  blockId,
  editingProp,
  setEditingProp,
  editingKey,
  setEditingKey,
  selectOptions,
  isRefProp,
  refPages,
  refSearch,
  setRefSearch,
}: BlockPropertyEditorProps): React.ReactElement | null {
  const { t } = useTranslation()

  const propAnchorRef = useRef<HTMLSpanElement | null>(null)
  const propPopupRef = useRef<HTMLDivElement | null>(null)
  const keyAnchorRef = useRef<HTMLSpanElement | null>(null)
  const keyPopupRef = useRef<HTMLDivElement | null>(null)
  // PEND-23 H1 — stable id base for select-options listbox so each option
  // can carry a unique `id` referenced by `aria-activedescendant`.
  const selectListboxId = useId()

  // #976 (item 10) — keyboard navigation for the select-options listbox. The
  // listbox previously carried `aria-activedescendant`/`aria-selected` ARIA but
  // ZERO key handlers, so AT users had to Tab through every option (the comment
  // promised it mirrored `TagValuePicker` but omitted its Arrow/Home/End/Enter
  // logic). `activeIndex` is the keyboard-navigated row; it seeds to the
  // selected option (or 0) when the listbox opens and drives
  // `aria-activedescendant`. The option `<button>`s also get
  // `focus-ring-visible` (#976 item 11) so the row is visible while navigating.
  const [activeIndex, setActiveIndex] = useState(-1)
  const selectListRef = useRef<HTMLDivElement | null>(null)

  // Seed/reset the active option whenever the select-options popup opens for a
  // (new) property. Start on the currently-selected value, else the first row.
  useEffect(() => {
    if (!editingProp || !selectOptions) {
      setActiveIndex(-1)
      return
    }
    const selectedIdx = selectOptions.indexOf(editingProp.value)
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0)
  }, [editingProp, selectOptions])

  // Keep the keyboard-active option scrolled into view as the user navigates,
  // mirroring `TagValuePicker.tsx`.
  useEffect(() => {
    if (activeIndex >= 0 && selectListRef.current) {
      const option = selectListRef.current.children[activeIndex] as HTMLElement | undefined
      if (typeof option?.scrollIntoView === 'function') {
        option.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [activeIndex])

  // Commit a select option (shared by click + Enter). Awaits the IPC, reports
  // failures, then closes the popup — identical to the per-option onClick.
  const commitSelectOption = useCallback(
    async (opt: string): Promise<void> => {
      if (!editingProp) return
      try {
        await setProperty({ blockId, key: editingProp.key, valueText: opt })
      } catch (err) {
        reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
          blockId,
          key: editingProp.key,
        })
      }
      setEditingProp(null)
    },
    [blockId, editingProp, setEditingProp, t],
  )

  const handleSelectListboxKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selectOptions || selectOptions.length === 0) return
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((prev) => Math.min(prev + 1, selectOptions.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Home':
          e.preventDefault()
          setActiveIndex(0)
          break
        case 'End':
          e.preventDefault()
          setActiveIndex(selectOptions.length - 1)
          break
        case 'Enter': {
          const opt = selectOptions[activeIndex]
          if (activeIndex >= 0 && opt !== undefined) {
            e.preventDefault()
            void commitSelectOption(opt)
          }
          break
        }
      }
    },
    [selectOptions, activeIndex, commitSelectOption],
  )

  // ── Position + autoUpdate for the value popup ──────────────────────────
  useEffect(() => {
    if (!editingProp) return
    const anchor = propAnchorRef.current
    const popup = propPopupRef.current
    if (!anchor || !popup) {
      logger.warn('BlockPropertyEditor', 'value popup mounted without refs', {
        hasAnchor: anchor !== null,
        hasPopup: popup !== null,
        key: editingProp.key,
      })
      return
    }

    const update = () => {
      if (!anchor.isConnected || !popup.isConnected) {
        logger.warn('BlockPropertyEditor', 'anchor unmounted while value popup open', {
          key: editingProp.key,
          anchorConnected: anchor.isConnected,
          popupConnected: popup.isConnected,
        })
        return
      }
      computePosition(anchor, popup, {
        placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      })
        .then(({ x, y }) => {
          applySafePosition(popup, { x, y })
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockPropertyEditor',
            'value popup computePosition failed',
            { key: editingProp.key },
            err,
          )
          // MAINT-175: push popup off-screen on failure so it doesn't
          // float orphaned mid-page after the anchor scrolls or moves.
          applySafePosition(popup, null)
        })
    }

    return autoUpdate(anchor, popup, update)
  }, [editingProp])

  // ── Outside-click for the value popup ──────────────────────────────────
  useEffect(() => {
    if (!editingProp) return

    const handlePointerDown = (e: PointerEvent) => {
      const popup = propPopupRef.current
      const anchor = propAnchorRef.current
      if (!popup) return
      const target = e.target as Node | null
      if (!target) return
      if (popup.contains(target)) return
      if (anchor?.contains(target)) return
      setEditingProp(null)
    }

    // Escape closes the value popup. Handled at the document level (canonical
    // dialog dismissal) so it works regardless of which inner control — the
    // search input or any of the ref/select option buttons — has focus,
    // without hanging a keyboard listener on the non-interactive grouping
    // element (jsx-a11y/no-noninteractive-element-interactions).
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingProp(null)
    }

    // Defer registration by a frame so the click that opened the popup
    // doesn't immediately close it (mirrors suggestion-renderer.ts).
    let frameId: number | null = null
    frameId = requestAnimationFrame(() => {
      frameId = null
      document.addEventListener('pointerdown', handlePointerDown, true)
    })
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [editingProp, setEditingProp])

  // ── Position + autoUpdate for the key-rename popup ─────────────────────
  useEffect(() => {
    if (!editingKey) return
    const anchor = keyAnchorRef.current
    const popup = keyPopupRef.current
    if (!anchor || !popup) {
      logger.warn('BlockPropertyEditor', 'key popup mounted without refs', {
        hasAnchor: anchor !== null,
        hasPopup: popup !== null,
        oldKey: editingKey.oldKey,
      })
      return
    }

    const update = () => {
      if (!anchor.isConnected || !popup.isConnected) {
        logger.warn('BlockPropertyEditor', 'anchor unmounted while key popup open', {
          oldKey: editingKey.oldKey,
          anchorConnected: anchor.isConnected,
          popupConnected: popup.isConnected,
        })
        return
      }
      computePosition(anchor, popup, {
        placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      })
        .then(({ x, y }) => {
          applySafePosition(popup, { x, y })
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockPropertyEditor',
            'key popup computePosition failed',
            { oldKey: editingKey.oldKey },
            err,
          )
          // MAINT-175: push popup off-screen on failure so it doesn't
          // float orphaned mid-page after the anchor scrolls or moves.
          applySafePosition(popup, null)
        })
    }

    return autoUpdate(anchor, popup, update)
  }, [editingKey])

  // ── Outside-click for the key-rename popup ─────────────────────────────
  useEffect(() => {
    if (!editingKey) return

    const handlePointerDown = (e: PointerEvent) => {
      const popup = keyPopupRef.current
      const anchor = keyAnchorRef.current
      if (!popup) return
      const target = e.target as Node | null
      if (!target) return
      if (popup.contains(target)) return
      if (anchor?.contains(target)) return
      setEditingKey(null)
    }

    let frameId: number | null = null
    frameId = requestAnimationFrame(() => {
      frameId = null
      document.addEventListener('pointerdown', handlePointerDown, true)
    })

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [editingKey, setEditingKey])

  const propPopup = editingProp ? (
    <div
      ref={propPopupRef}
      data-editor-portal=""
      className="rounded-md border bg-popover p-1 shadow-lg max-w-[calc(100vw-2rem)]"
      style={{ position: 'fixed', left: HIDDEN_LEFT, top: HIDDEN_TOP, zIndex: 50 }}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- fixed-position custom popover; native <dialog> brings top-layer/modal semantics and ::backdrop that conflict with this manually-positioned non-modal popup
      role="dialog"
      aria-label={t('block.editProperty')}
    >
      {selectOptions ? (
        // PEND-23 H1 — listbox semantics so screen-reader / keyboard users
        // see a navigable list rather than a stack of generic buttons.
        // Mirrors the in-repo pattern in `TagValuePicker.tsx:172–199`.
        (() => {
          const selectedIdx = selectOptions.indexOf(editingProp.value)
          const optionId = (i: number) => `${selectListboxId}-option-${i}`
          return (
            <div
              ref={selectListRef}
              className="flex flex-col gap-0.5"
              data-testid="select-options-dropdown"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom ARIA listbox of styled <button> options with aria-activedescendant nav; <select>/<datalist> can't render this or support async setProperty handlers
              role="listbox"
              aria-label={t('block.editProperty')}
              // #976 (item 10) — track the KEYBOARD-active row, not just the
              // currently-stored value, so arrow navigation moves the AT focus
              // ring. Falls back to the selected option when no key nav yet.
              aria-activedescendant={
                activeIndex >= 0
                  ? optionId(activeIndex)
                  : selectedIdx >= 0
                    ? optionId(selectedIdx)
                    : undefined
              }
              tabIndex={0}
              // #976 (item 10) — Arrow/Home/End/Enter listbox navigation. Held on
              // the listbox container (it owns `tabIndex={0}` + focus) rather than
              // per-option, mirroring `TagValuePicker.tsx`. Escape is handled at
              // the document level (see the value-popup effect above).
              onKeyDown={handleSelectListboxKeyDown}
            >
              {selectOptions.map((opt, i) => (
                <button
                  key={opt}
                  id={optionId(i)}
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- option in a custom ARIA listbox; this is a <button> click target, native <option> can't host the handler or focus styling
                  role="option"
                  aria-selected={i === selectedIdx}
                  className={cn(
                    // #976 (item 11) — `focus-ring-visible` gives keyboard users a
                    // visible focus indicator while navigating the listbox (the
                    // bg-accent below marks the STORED value, not the nav cursor).
                    'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors focus-ring-visible',
                    i === selectedIdx && 'bg-accent font-medium',
                    // The keyboard-active row gets the accent bg too so the nav
                    // cursor is visible even before the option is committed.
                    i === activeIndex && 'bg-accent',
                  )}
                  onClick={() => void commitSelectOption(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          )
        })()
      ) : isRefProp ? (
        <fieldset
          className="flex flex-col gap-0.5 w-56 border-none p-0 m-0"
          data-testid="ref-picker"
          aria-label={t('block.refPickerLabel')}
        >
          <input
            ref={(el) => {
              el?.focus()
            }}
            type="text"
            className="rounded border px-2 py-1 text-sm w-full"
            aria-label={t('block.searchPages')}
            placeholder={t('block.searchPages')}
            data-testid="ref-search-input"
            value={refSearch}
            onChange={(e) => setRefSearch(e.target.value)}
          />
          <ScrollArea className="max-h-48 flex flex-col gap-0.5">
            {(() => {
              // UX-248 — Unicode-aware fold.
              const filtered = refPages.filter((page) =>
                matchesSearchFolded(page.content || '', refSearch),
              )
              if (filtered.length === 0) {
                return (
                  <div
                    className="px-2 py-1 text-sm text-muted-foreground"
                    data-testid="ref-no-results"
                  >
                    {t('block.noPagesFound')}
                  </div>
                )
              }
              return filtered.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  className={cn(
                    // #976 (item 11) — visible keyboard focus ring on the
                    // ref-picker option buttons, matching the select-options
                    // listbox and the shared app-wide pattern.
                    'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors truncate focus-ring-visible',
                    page.id === editingProp.value && 'bg-accent font-medium',
                  )}
                  onClick={async () => {
                    try {
                      await setProperty({
                        blockId,
                        key: editingProp.key,
                        valueRef: page.id,
                      })
                    } catch (err) {
                      reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                        blockId,
                        key: editingProp.key,
                        refPageId: page.id,
                      })
                    }
                    setEditingProp(null)
                  }}
                >
                  {page.content || t('block.untitled')}
                </button>
              ))
            })()}
          </ScrollArea>
        </fieldset>
      ) : (
        <input
          ref={(el) => {
            el?.focus()
          }}
          type="text"
          className="rounded border px-2 py-1 text-sm w-32"
          aria-label={t('block.editProperty')}
          defaultValue={editingProp.value}
          onBlur={async (e) => {
            const newValue = e.target.value.trim()
            if (newValue !== editingProp.value) {
              try {
                await setProperty({
                  blockId,
                  key: editingProp.key,
                  valueText: newValue || null,
                })
              } catch (err) {
                reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                  blockId,
                  key: editingProp.key,
                })
              }
            }
            setEditingProp(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditingProp(null)
          }}
        />
      )}
    </div>
  ) : null

  const keyPopup = editingKey ? (
    <div
      ref={keyPopupRef}
      data-editor-portal=""
      className="property-key-editor rounded-md border bg-popover p-1 shadow-lg"
      style={{ position: 'fixed', left: HIDDEN_LEFT, top: HIDDEN_TOP, zIndex: 50 }}
    >
      <input
        ref={(el) => {
          el?.focus()
        }}
        type="text"
        className="rounded border px-2 py-1 text-sm w-32"
        aria-label={t('block.editProperty')}
        defaultValue={editingKey.oldKey}
        onBlur={async (e) => {
          const newKey = e.target.value.trim()
          if (newKey && newKey !== editingKey.oldKey) {
            try {
              await setProperty({
                blockId,
                key: newKey,
                valueText: editingKey.value,
              })
              await setProperty({
                blockId,
                key: editingKey.oldKey,
                valueText: null,
              })
            } catch (err) {
              reportIpcError('BlockPropertyEditor', 'property.renameFailed', err, t, {
                blockId,
                oldKey: editingKey.oldKey,
              })
            }
          }
          setEditingKey(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditingKey(null)
        }}
      />
    </div>
  ) : null

  return (
    <>
      {editingProp && (
        <span
          ref={propAnchorRef}
          aria-hidden="true"
          data-testid="block-property-editor-anchor"
          style={{ display: 'inline-block', width: 0, height: 0 }}
        />
      )}
      {editingKey && (
        <span
          ref={keyAnchorRef}
          aria-hidden="true"
          data-testid="block-property-key-editor-anchor"
          style={{ display: 'inline-block', width: 0, height: 0 }}
        />
      )}
      {propPopup && createPortal(propPopup, document.body)}
      {keyPopup && createPortal(keyPopup, document.body)}
    </>
  )
}
