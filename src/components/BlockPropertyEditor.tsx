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
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '../lib/logger'
import { reportIpcError } from '../lib/report-ipc-error'
import type { BlockRow } from '../lib/tauri'
import { setProperty } from '../lib/tauri'
import { cn } from '../lib/utils'

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
          Object.assign(popup.style, {
            position: 'fixed',
            left: `${x}px`,
            top: `${y}px`,
          })
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockPropertyEditor',
            'value popup computePosition failed',
            { key: editingProp.key },
            err,
          )
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

    // Defer registration by a frame so the click that opened the popup
    // doesn't immediately close it (mirrors suggestion-renderer.ts).
    let frameId: number | null = null
    frameId = requestAnimationFrame(() => {
      frameId = null
      document.addEventListener('pointerdown', handlePointerDown, true)
    })

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown, true)
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
          Object.assign(popup.style, {
            position: 'fixed',
            left: `${x}px`,
            top: `${y}px`,
          })
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockPropertyEditor',
            'key popup computePosition failed',
            { oldKey: editingKey.oldKey },
            err,
          )
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
      className="rounded-md border bg-popover p-1 shadow-lg"
      style={{ position: 'fixed', left: HIDDEN_LEFT, top: HIDDEN_TOP, zIndex: 50 }}
      role="dialog"
      aria-label={t('block.editProperty')}
    >
      {selectOptions ? (
        <div className="flex flex-col gap-0.5" data-testid="select-options-dropdown">
          {selectOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              className={cn(
                'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors',
                opt === editingProp.value && 'bg-accent font-medium',
              )}
              onClick={async () => {
                try {
                  await setProperty({ blockId, key: editingProp.key, valueText: opt })
                } catch (err) {
                  reportIpcError('BlockPropertyEditor', 'property.saveFailed', err, t, {
                    blockId,
                    key: editingProp.key,
                  })
                }
                setEditingProp(null)
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : isRefProp ? (
        <fieldset
          className="flex flex-col gap-0.5 w-56 border-none p-0 m-0"
          data-testid="ref-picker"
          aria-label={t('block.refPickerLabel')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditingProp(null)
          }}
        >
          <input
            ref={(el) => {
              el?.focus()
            }}
            type="text"
            className="rounded border px-2 py-1 text-sm w-full"
            placeholder={t('block.searchPages')}
            data-testid="ref-search-input"
            value={refSearch}
            onChange={(e) => setRefSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingProp(null)
            }}
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
                    'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors truncate',
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
