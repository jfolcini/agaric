/**
 * App-level TooltipProvider tests (#1094).
 *
 * The app now mounts a single `<TooltipProvider>` in `src/main.tsx`; the
 * per-surface providers (24 of them) and the IconButton-embedded provider were
 * removed. This file pins the two contracts that change made:
 *
 *  1. A tooltip-using primitive (IconButton / a bare Tooltip) renders WITHOUT a
 *     locally-mounted `<TooltipProvider>` — i.e. the provider it relies on is an
 *     ancestor it does NOT carry itself. In the test environment that ancestor
 *     comes from the shared test wrapper (`src/test-setup.ts`), mirroring the
 *     production app-level provider.
 *
 *  2. A surface that deliberately overrides the hover delay keeps its
 *     `delayDuration` on the individual `<Tooltip>` (Radix `Tooltip.Root`)
 *     rather than silently inheriting the app baseline.
 *
 * radix `Tooltip.Root` is spied (via `vi.mock('radix-ui')`) so we can assert
 * the `delayDuration` a `<Tooltip>` forwards. The spy also serves the
 * isolated-render path: `src/test-setup.ts` wraps the real `Tooltip` in a
 * `TooltipProvider`, so renders here do NOT mount their own provider — that is
 * the whole point.
 */

import { render, screen } from '@testing-library/react'
import { Settings } from 'lucide-react'
import { Tooltip as RealTooltipPrimitive } from 'radix-ui'
import type * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IconButton } from '../icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip'

// Capture the props radix `Tooltip.Root` receives so override-forwarding is
// assertable. Everything else stays the real radix implementation.
const rootProps: Array<{ delayDuration?: number | undefined }> = []

vi.mock('radix-ui', async () => {
  const actual = await vi.importActual<typeof import('radix-ui')>('radix-ui')
  return {
    ...actual,
    Tooltip: {
      ...actual.Tooltip,
      Root: (props: { delayDuration?: number; children?: React.ReactNode }) => {
        rootProps.push({ delayDuration: props.delayDuration })
        return actual.Tooltip.Root(props)
      },
    },
  }
})

beforeEach(() => {
  rootProps.length = 0
})

describe('app-level tooltip provider (#1094)', () => {
  it('IconButton renders its trigger without a locally-mounted provider', () => {
    // No <TooltipProvider> wrapper here — IconButton no longer embeds one and we
    // do not add one. The shared test wrapper supplies the ancestor, exactly as
    // the app-level provider does in production. The assertion is that rendering
    // does not throw "`Tooltip` must be used within `TooltipProvider`".
    expect(() =>
      render(
        <IconButton tooltip="Open settings" ariaLabel="Open settings">
          <Settings />
        </IconButton>,
      ),
    ).not.toThrow()

    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
  })

  it('IconButton no longer embeds its own TooltipProvider', () => {
    // The primitive used to render a `data-slot="tooltip-provider"` element per
    // button. After #1094 that element must NOT be present in IconButton's own
    // output — the provider lives at the app root, not per-instance.
    const { container } = render(
      <IconButton tooltip="Delete" ariaLabel="Delete">
        <Settings />
      </IconButton>,
    )
    expect(container.querySelector('[data-slot="tooltip-provider"]')).toBeNull()
  })

  it('an open tooltip shows its content via the ancestor provider (no local provider)', () => {
    render(
      <Tooltip open>
        <TooltipTrigger asChild>
          <button type="button">trigger</button>
        </TooltipTrigger>
        <TooltipContent>Tooltip body</TooltipContent>
      </Tooltip>,
    )
    // Radix renders the label in both the visible content and an a11y span, so
    // there is at least one match. The render only succeeds if a provider
    // ancestor exists.
    expect(screen.getAllByText('Tooltip body').length).toBeGreaterThan(0)
  })

  it('a Tooltip override delayDuration is forwarded to radix Tooltip.Root', () => {
    // The override-preservation contract (#1094): surfaces with a deliberate
    // delay set it on the `<Tooltip>` itself, not on a removed per-surface
    // provider. The `@/components/ui/tooltip` `Tooltip` is a thin
    // `<TooltipPrimitive.Root {...props} />`, so `delayDuration` must reach
    // radix's `Tooltip.Root` unchanged.
    render(
      <Tooltip open delayDuration={500}>
        <TooltipTrigger asChild>
          <button type="button">x</button>
        </TooltipTrigger>
        <TooltipContent>Delayed</TooltipContent>
      </Tooltip>,
    )
    expect(rootProps.some((p) => p.delayDuration === 500)).toBe(true)
  })

  it('a Tooltip with no delayDuration inherits the baseline (forwards undefined)', () => {
    // Default-delay surfaces drop their provider entirely and pass NO
    // delayDuration — they inherit the app baseline. Confirm the primitive does
    // not inject a stray delay of its own.
    render(
      <Tooltip open>
        <TooltipTrigger asChild>
          <button type="button">y</button>
        </TooltipTrigger>
        <TooltipContent>Baseline</TooltipContent>
      </Tooltip>,
    )
    expect(rootProps.some((p) => p.delayDuration === undefined)).toBe(true)
  })

  it('exists so the radix primitive import is referenced', () => {
    // `RealTooltipPrimitive` is imported to document that the spy targets the
    // same `radix-ui` Tooltip namespace the production primitive uses.
    expect(RealTooltipPrimitive.Root).toBeTypeOf('function')
  })
})
