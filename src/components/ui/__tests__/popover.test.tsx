/**
 * Tests for the Popover components.
 *
 * Validates:
 *  - displayName is set on all exports
 *  - PopoverContent forwards ref
 *  - Render output and a11y compliance
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

describe('Popover displayNames', () => {
  it('Popover has displayName', () => {
    expect(Popover.displayName).toBe('Popover')
  })

  it('PopoverTrigger has displayName', () => {
    expect(PopoverTrigger.displayName).toBe('PopoverTrigger')
  })

  it('PopoverAnchor has displayName', () => {
    expect(PopoverAnchor.displayName).toBe('PopoverAnchor')
  })

  it('PopoverContent has displayName', () => {
    expect(PopoverContent.displayName).toBe('PopoverContent')
  })
})

describe('PopoverContent', () => {
  it('forwards ref to the content element', async () => {
    const ref = React.createRef<HTMLDivElement>()

    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent ref={ref}>Popover body</PopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Popover body')
    expect(content).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('popover-content')
  })

  it('renders with data-slot="popover-content"', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content here</PopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Content here')
    expect(content.closest('[data-slot="popover-content"]')).toBeInTheDocument()
  })

  // #4313 — the cap is Radix's collision-aware available height, with the old
  // `100dvh` expression demoted to a fallback for when that var is unset — in
  // practice, jsdom/happy-dom, where nothing ever lays the popper out enough
  // to run the `size()` middleware's `apply`. It's not `avoidCollisions={false}`:
  // that only gates `shift`/`flip` in `@radix-ui/react-popper`, not `size()`.
  // It cannot be `100dvh` alone: on Android the soft keyboard does not shrink
  // the layout viewport, so a `dvh` cap let popovers extend under the
  // keyboard and past the top of the screen. The Radix var, by contrast, IS
  // keyboard-aware on its own — floating-ui measures the collision boundary
  // with `window.visualViewport` — which is why the popover does not (and must
  // not) also add the keyboard height as bottom `collisionPadding`; that would
  // subtract it twice. The HEIGHT CAP specifically is covered end-to-end in
  // `e2e/formatting-toolbar-mobile.spec.ts` (it asserts the available-height
  // variable). That spec does NOT cover `collisionPadding`'s 4px inset —
  // nothing does; see the `collisionPadding` block below, which says so. The
  // two statements are about different geometry, not in conflict.
  it('caps height to the collision-aware available height, falling back to the dynamic viewport', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content</PopoverContent>
      </Popover>,
    )
    const content = await screen.findByText('Content')
    const root = content.closest('[data-slot="popover-content"]')
    expect(root).not.toBeNull()
    expect(root?.className).toContain(
      'max-h-[max(var(--radix-popover-content-available-height,calc(100dvh-4rem)),8rem)]',
    )
  })

  // #4339 — `collisionPadding` defaults to `EDGE_PADDING_PX` (4px), not
  // Radix's own default of `0`. That default is real geometry, not
  // decoration: it feeds `detectOverflow`'s `paddingObject`, which
  // floating-ui's `size()` folds into `maximumClippingHeight` for every
  // popover in the app (31 production call sites, none of which pass the
  // prop; #4339 estimated ~45, but 31 is the measured figure) — see the
  // comment on `EDGE_PADDING_PX` in `../popover.tsx` for the full chain.
  //
  // That geometry only manifests once `size()` actually lays the popper out,
  // which happy-dom never does (the same reason the max-height test above
  // asserts the class expression rather than a computed pixel value). A
  // render-based test can't tell a real 4px inset from Radix's 0px default,
  // because `collisionPadding` isn't reflected anywhere in the DOM — no
  // attribute, no style — until layout runs. So this asserts the one thing
  // this environment CAN observe: that `PopoverContent`'s default flows
  // through to the underlying Radix element unchanged. It calls
  // `PopoverContent` as a plain function rather than rendering it — React 19
  // allows `ref` as an ordinary prop, so the component is a plain arrow
  // function with no ref-forwarding wrapper of any kind, and calling it runs
  // exactly the body React would run — and reads the element tree it returns
  // directly, with no DOM involved. (The wrapper is named without using the
  // legacy API's identifier on purpose: `no-legacy-react-apis` is a text
  // scan, so spelling it out here would fail the hook on a comment.) That
  // is deliberately narrower than "the popover avoids the viewport edge by
  // 4px"; it goes red the moment the default itself regresses (removed, or
  // drifts from 4), which is what shipped untested at #4339.
  // Both direct-call tests assume `PopoverContent` returns exactly
  // Portal -> Content. If a wrapper element is ever inserted between them,
  // `portal.props.children` is undefined and the padding assertion dies with
  // a TypeError naming neither the padding nor the shape change. Assert the
  // shape first so the failure says which of the two actually broke.
  const contentOf = (portal: { props: { children?: { props?: object } } }) => {
    const props = portal.props.children?.props
    // Checking that `collisionPadding` is PRESENT, not merely that `props`
    // exists: an inserted wrapper element has props of its own, so a
    // `toBeDefined()` on `props` passes and the real assertion then fails as
    // an opaque "expected undefined to be 4". Keying on the prop under test
    // is what makes a shape change say so.
    expect(
      props && 'collisionPadding' in props,
      'PopoverContent no longer returns Portal -> Content carrying collisionPadding; retarget these direct-call tests rather than relaxing them',
    ).toBe(true)
    return portal.props.children as { props: { collisionPadding?: number } }
  }

  // The `4` is restated here rather than imported. `EDGE_PADDING_PX` is not
  // exported, and exporting it so this arm could assert against the source of
  // truth would make the arm follow the constant instead of pinning it — a
  // bump to 8 would then redden nothing. Restating it keeps this a deliberate
  // change-detector: bumping the default is a decision that should have to
  // touch its test, test title included.
  it('defaults collisionPadding to EDGE_PADDING_PX (4), not Radix default of 0', () => {
    const portal = PopoverContent({ children: 'Content' })
    expect(contentOf(portal).props.collisionPadding).toBe(4)
  })

  // A default and a hardcoded constant both satisfy the assertion above —
  // neither proves a caller-supplied value actually reaches Radix instead of
  // being clobbered by the default. This is the failure class #4339 is about
  // in the first place: an app-wide value change with nothing pinning the
  // contract around it. Same direct-call technique as the default test.
  it('still passes through a caller-supplied collisionPadding instead of forcing the default', () => {
    const portal = PopoverContent({ children: 'Content', collisionPadding: 12 })
    expect(contentOf(portal).props.collisionPadding).toBe(12)
  })

  it('has no a11y violations', async () => {
    const { baseElement } = render(
      <Popover defaultOpen>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent aria-label="Popover content">Accessible popover content</PopoverContent>
      </Popover>,
    )
    const results = await axe(baseElement)
    expect(results).toHaveNoViolations()
  })
})
