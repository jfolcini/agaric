/**
 * LinkPreviewTooltip — floating tooltip that shows metadata for hovered
 * external links inside the TipTap editor.
 *
 * Displays the page title and favicon when metadata is available. Falls
 * back to the raw URL when no title is present. Uses @floating-ui/dom for
 * viewport-aware positioning below the hovered link element.
 *
 * UX-165
 */

import { computePosition, flip, shift } from '@floating-ui/dom'
import { Globe } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'

import { useLinkPreview } from '@/hooks/useLinkPreview'
import { cn } from '@/lib/utils'
import { Spinner } from './ui/spinner'

interface LinkPreviewTooltipProps {
  container: HTMLElement | null
}

export function LinkPreviewTooltip({
  container,
}: LinkPreviewTooltipProps): React.ReactElement | null {
  const { url, metadata, anchorRect, isLoading } = useLinkPreview(container)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [imgErrorUrl, setImgErrorUrl] = useState<string | null>(null)

  const faviconUrl = metadata?.favicon_url ?? null
  const imgError = imgErrorUrl === faviconUrl && faviconUrl !== null

  // Compute tooltip position using @floating-ui/dom
  useEffect(() => {
    if (!anchorRect || !tooltipRef.current) {
      setPosition(null)
      return
    }

    // Create a virtual reference element from the anchorRect
    const virtualEl = {
      getBoundingClientRect: () => anchorRect,
    }

    computePosition(virtualEl, tooltipRef.current, {
      placement: 'bottom-start',
      middleware: [flip(), shift({ padding: 8 })],
    })
      .then(({ x, y }) => {
        setPosition({ x, y })
      })
      .catch(() => {
        // Fallback: position directly below the link
        setPosition({ x: anchorRect.left, y: anchorRect.bottom + 4 })
      })
  }, [anchorRect])

  if (!url || !anchorRect) return null

  const showFavicon = metadata?.favicon_url && !imgError && !metadata.auth_required
  const title = metadata?.auth_required ? null : metadata?.title

  return (
    <div
      ref={tooltipRef}
      data-testid="link-preview-tooltip"
      role="tooltip"
      className={cn(
        'fixed z-50 max-w-xs rounded-md border bg-popover p-2 text-popover-foreground shadow-md',
        'animate-in fade-in-0',
      )}
      style={
        position
          ? { left: position.x, top: position.y }
          : { left: anchorRect.left, top: anchorRect.bottom + 4, visibility: 'hidden' }
      }
    >
      <div className="flex items-center gap-2">
        {isLoading ? (
          <>
            <Spinner size="sm" className="shrink-0" />
            <span className="truncate text-xs text-muted-foreground">{url}</span>
          </>
        ) : (
          <>
            {showFavicon ? (
              <img
                src={metadata.favicon_url as string}
                alt=""
                width={16}
                height={16}
                className="shrink-0 rounded-sm"
                onError={() => setImgErrorUrl(faviconUrl)}
              />
            ) : (
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            {title ? (
              <span className="truncate text-xs font-medium">{title}</span>
            ) : (
              <span className="truncate text-xs text-muted-foreground">{url}</span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
