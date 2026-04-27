/**
 * CloseButton — shared close-button styles for Dialog and Sheet overlays.
 *
 * Exports a className constant and an inner-content component so that
 * Dialog and Sheet can each render their own Radix primitive while
 * sharing identical visual appearance and touch-target sizing.
 */

import { XIcon } from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'

const closeButtonClassName =
  'absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:pointer-events-none p-1 [@media(pointer:coarse)]:p-2 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center'

const CloseButtonIcon = ({ ref, ...props }: React.ComponentProps<'span'>) => {
  const { t } = useTranslation()
  return (
    <span ref={ref} {...props}>
      <XIcon className="size-4 [@media(pointer:coarse)]:size-5" />
      <span className="sr-only">{t('ui.close')}</span>
    </span>
  )
}
CloseButtonIcon.displayName = 'CloseButtonIcon'

export { CloseButtonIcon, closeButtonClassName }
