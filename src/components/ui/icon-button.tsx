/**
 * IconButton — icon-only `Button` that *requires* a tooltip + aria-label.
 *
 * Icon-only buttons must surface their purpose for both sighted users (via a
 * visible tooltip) and assistive tech (via an accessible name). The `tooltip`
 * and `ariaLabel` props are typed as mandatory `string`s precisely so a
 * consumer cannot ship an icon-only button without both — TypeScript fails
 * the build if either is omitted.
 *
 * Reference pattern: `BlockGutterControls.GutterButton` (Tooltip-wrapped
 * icon button with bespoke gutter positioning). `IconButton` generalises
 * that pattern on top of the existing `Button` primitive so the entire
 * Button size/variant matrix (icon-xs through icon-lg, ghost / outline /
 * destructive / …) is available without re-implementing chrome.
 *
 * The tooltip relies on the app-level `<TooltipProvider>` mounted once in
 * `src/main.tsx` (#1094) — there is a single hover-delay source of truth for
 * the whole app, so the primitive no longer embeds its own provider. Tests
 * that render IconButton in isolation get the provider from the shared test
 * render wrapper (`src/test/render.tsx`).
 */

import type * as React from 'react'

import { Button } from './button'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

type IconSize = 'icon-xs' | 'icon-sm' | 'icon' | 'icon-lg'

export interface IconButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  'size' | 'children'
> {
  /**
   * The icon slot — pass a single icon element (e.g. a Lucide icon). Text
   * content does NOT belong here: it would render unlabelled next to the
   * icon and break the icon-only contract. Visible text goes in `tooltip`;
   * the accessible name goes in `ariaLabel`. Explicit (rather than inherited)
   * so the signature documents that this is an icon-only slot.
   */
  children?: React.ReactNode
  /** Text shown inside the Radix tooltip — mandatory by design. */
  tooltip: string
  /**
   * Accessible name surfaced as `aria-label` on the underlying `<button>` —
   * mandatory by design. Redundancy with `tooltip` is intentional and fine:
   * sighted users see the tooltip on hover/focus, AT users get the label.
   */
  ariaLabel: string
  /**
   * Restricted to the four `icon-*` Button sizes — this primitive only
   * makes sense for square icon-only chrome. Defaults to the standard 36 px
   * `icon` size.
   */
  size?: IconSize
}

const IconButton = ({ tooltip, ariaLabel, size = 'icon', children, ...rest }: IconButtonProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button size={size} aria-label={ariaLabel} data-slot="icon-button" {...rest}>
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{tooltip}</TooltipContent>
  </Tooltip>
)
IconButton.displayName = 'IconButton'

export { IconButton }
