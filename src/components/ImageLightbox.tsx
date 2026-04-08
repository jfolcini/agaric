/**
 * ImageLightbox — fullscreen image viewer using Radix Dialog.
 *
 * Displays an image centered on a dark overlay.
 * Closes on Escape, click outside, or the top-right close button
 * (provided by DialogContent via CloseButtonIcon).
 * Optionally calls `onOpenExternal` to open the image in an external app.
 */

import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

export interface ImageLightboxProps {
  src: string
  alt: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional callback to open the image externally (e.g. in the OS viewer). */
  onOpenExternal?: (() => void) | undefined
}

export function ImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
  onOpenExternal,
}: ImageLightboxProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'bg-black/80 border-0 shadow-none rounded-none p-0',
          'max-w-[90vw] sm:max-w-[90vw] max-h-[90vh]',
          'flex items-center justify-center',
          '[&>[data-slot=dialog-close]]:text-white [&>[data-slot=dialog-close]]:hover:text-white/80',
        )}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('lightbox.description', { filename: alt })}
        </DialogDescription>

        <img
          src={src}
          alt={alt}
          className="max-w-[90vw] max-h-[90vh] object-contain"
          data-testid="lightbox-image"
        />

        {onOpenExternal && (
          <button
            type="button"
            className={cn(
              'absolute bottom-4 right-4 inline-flex items-center gap-1.5',
              'rounded-md bg-black/60 px-3 py-1.5 text-xs text-white/80',
              'transition-colors hover:bg-black/80 hover:text-white',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
            )}
            onClick={(e) => {
              e.stopPropagation()
              onOpenExternal()
            }}
            data-testid="lightbox-open-external"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t('lightbox.openExternal')}
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}
