/**
 * CloseButton — shared close-button styles for Dialog and Sheet overlays.
 *
 * Exports a className constant and an inner-content component so that
 * Dialog and Sheet can each render their own Radix primitive while
 * sharing identical visual appearance and touch-target sizing.
 */

import { XIcon } from 'lucide-react'
import * as React from 'react'

const closeButtonClassName =
  'absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none p-1 [@media(pointer:coarse)]:p-2 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center'

const CloseButtonIcon = React.forwardRef<HTMLSpanElement, React.ComponentProps<'span'>>(
  (props, ref) => {
    return (
      <span ref={ref} {...props}>
        <XIcon className="size-4" />
        <span className="sr-only">Close</span>
      </span>
    )
  },
)
CloseButtonIcon.displayName = 'CloseButtonIcon'

export { CloseButtonIcon, closeButtonClassName }
