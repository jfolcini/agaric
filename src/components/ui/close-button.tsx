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
// pushing the glyph inward. `-m-1` cancels `p-1` (fine); on coarse pointers the
// 44px min box centres the 20px glyph, so `-m-3` cancels its 12px slack.
const closeButtonClassName =
  'absolute top-6 right-6 -m-1 coarse:-m-3 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-ring-visible disabled:pointer-events-none p-1 coarse:p-2 coarse:min-h-(--touch-target) coarse:min-w-(--touch-target) coarse:flex coarse:items-center coarse:justify-center'

const CloseButtonIcon = ({ ref, ...props }: React.ComponentProps<'span'>) => {
  const { t } = useTranslation()
  return (
    <span ref={ref} data-slot="close-button-icon" {...props}>
      <XIcon className="size-4 coarse:size-5" />
      <span className="sr-only">{t('ui.close')}</span>
    </span>
  )
}
CloseButtonIcon.displayName = 'CloseButtonIcon'

export { CloseButtonIcon, closeButtonClassName }
