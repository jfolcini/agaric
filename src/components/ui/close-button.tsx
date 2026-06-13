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

// #1013: anchor the box on the 24px content frame (top-6 right-6) and grow
// the hit-target OUTWARD via negative margins that cancel the button's own
// padding — so the glyph lands exactly on the gutter line while the clickable
// area (and 44px coarse touch target) expands past the frame instead of
// pushing the glyph inward. `-m-1` cancels `p-1` (fine); `-m-2` cancels `p-2`
// (coarse).
const closeButtonClassName =
  'absolute top-6 right-6 -m-1 [@media(pointer:coarse)]:-m-2 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-ring-visible disabled:pointer-events-none p-1 [@media(pointer:coarse)]:p-2 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center'

const CloseButtonIcon = ({ ref, ...props }: React.ComponentProps<'span'>) => {
  const { t } = useTranslation()
  return (
    <span ref={ref} data-slot="close-button-icon" {...props}>
      <XIcon className="size-4 [@media(pointer:coarse)]:size-5" />
      <span className="sr-only">{t('ui.close')}</span>
    </span>
  )
}
CloseButtonIcon.displayName = 'CloseButtonIcon'

export { CloseButtonIcon, closeButtonClassName }
