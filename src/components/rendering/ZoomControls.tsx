/**
 * ZoomControls — the on-screen zoom cluster for a `useZoomPan` surface
 * (#1104, #5638). Each button's accessible name carries its keyboard binding;
 * the surfaces share the graph's `+/-/0` bindings, so they reuse the
 * `graphZoom*` shortcut ids.
 */

import { Maximize2, Minus, Plus, Scan } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import type { useZoomPan } from '@/hooks/useZoomPan'
import { getShortcutKeys } from '@/lib/keyboard-config'

/** Append the current binding, if any, so the hotkey is in the accessible name. */
function withShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

export interface ZoomControlsProps {
  zoomPan: ReturnType<typeof useZoomPan>
  /** Label of the button that returns to the fitted view. */
  resetLabel: string
  /** Adds a 100% button, for a surface whose zoom 1 is the content's natural size. */
  actualSize?: boolean | undefined
  testIdPrefix: string
  className?: string | undefined
}

export function ZoomControls({
  zoomPan,
  resetLabel,
  actualSize = false,
  testIdPrefix,
  className,
}: ZoomControlsProps): React.ReactElement {
  const { t } = useTranslation()
  const { zoom, zoomed, canZoomIn, zoomBy, zoomTo, resetZoom } = zoomPan
  const step = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation()
    action()
  }
  return (
    <div className={className} data-testid={`${testIdPrefix}-zoom-controls`}>
      <IconButton
        variant="outline"
        disabled={!canZoomIn}
        onClick={(e) => step(e, () => zoomBy(0.25))}
        tooltip={t('lightbox.zoomIn')}
        ariaLabel={withShortcut(t('lightbox.zoomIn'), 'graphZoomIn')}
        data-testid={`${testIdPrefix}-zoom-in`}
      >
        <Plus className="h-4 w-4" />
      </IconButton>
      <IconButton
        variant="outline"
        disabled={!zoomed}
        onClick={(e) => step(e, () => zoomBy(-0.25))}
        tooltip={t('lightbox.zoomOut')}
        ariaLabel={withShortcut(t('lightbox.zoomOut'), 'graphZoomOut')}
        data-testid={`${testIdPrefix}-zoom-out`}
      >
        <Minus className="h-4 w-4" />
      </IconButton>
      <IconButton
        variant="outline"
        disabled={!zoomed}
        onClick={(e) => step(e, resetZoom)}
        tooltip={resetLabel}
        ariaLabel={withShortcut(resetLabel, 'graphZoomReset')}
        data-testid={`${testIdPrefix}-zoom-reset`}
      >
        <Maximize2 className="h-4 w-4" />
      </IconButton>
      {actualSize && (
        <IconButton
          variant="outline"
          disabled={zoom === 1}
          onClick={(e) => step(e, () => zoomTo(1))}
          tooltip={t('diagramViewer.actualSize')}
          ariaLabel={t('diagramViewer.actualSize')}
          data-testid={`${testIdPrefix}-zoom-actual`}
        >
          <Scan className="h-4 w-4" />
        </IconButton>
      )}
    </div>
  )
}
