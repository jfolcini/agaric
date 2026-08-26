/**
 * Pins React's own `useEffectEvent` republish behaviour per fiber tag, because
 * the #4377 refactor depends on it and it is not documented anywhere.
 *
 * An effect event's implementation is republished from the commit phase, in
 * `commitBeforeMutationEffectsOnFiber` (`react-dom-client.development.js`).
 * That switch drains `fiber.updateQueue.events` for `FunctionComponent`, then
 * falls through `case ForwardRef: case SimpleMemoComponent: break` — draining
 * nothing. On those two tags the implementation captured at MOUNT is the one
 * every later call dispatches to, for the life of the component. No warning is
 * emitted, and no lint rule catches it: `react-hooks/rules-of-hooks` polices
 * where an effect event is *called*, never which fiber owns it.
 *
 * The four cases below are the whole decision surface:
 *
 * | wrapper                  | fiber tag             | republished? |
 * |--------------------------|-----------------------|--------------|
 * | none                     | FunctionComponent     | yes          |
 * | `memo(Fn)`               | SimpleMemoComponent   | NO           |
 * | `memo(Fn, compare)`      | MemoComponent (+ an   | yes          |
 * |                          | inner FunctionComp.)  |              |
 * | `forwardRef(Fn)`         | ForwardRef            | NO           |
 *
 * This test asserts what React ACTUALLY does today, stale cases included, so a
 * React upgrade that fixes it fails here and tells us the companion guard
 * (`effect-event-fiber-owner.test.ts`) can be relaxed. `DaySection` — the site
 * that hit this for real — is `memo(DaySectionInner)` and therefore uses the
 * `useLayoutEffect` mirror instead; see
 * `docs/architecture/frontend.md § Latest-value mirrors`.
 */

import { render } from '@testing-library/react'
import { forwardRef, memo, useEffect, useEffectEvent } from 'react'
import { describe, expect, it } from 'vitest'

interface ProbeProps {
  cb: () => void
}

/** Calls the latest `cb` from an effect, via an effect event, on every commit. */
function useProbe(cb: () => void): void {
  const fire = useEffectEvent(() => {
    cb()
  })
  useEffect(() => {
    fire()
  })
}

function PlainProbe({ cb }: ProbeProps): null {
  useProbe(cb)
  return null
}

const MemoProbe = memo(({ cb }: ProbeProps) => {
  useProbe(cb)
  return null
})

const MemoWithCompareProbe = memo(
  ({ cb }: ProbeProps) => {
    useProbe(cb)
    return null
  },
  () => false,
)

const ForwardRefProbe = forwardRef<null, ProbeProps>(({ cb }, _ref) => {
  useProbe(cb)
  return null
})

/** Mount with callback `FIRST`, re-render with `SECOND`, report what ran. */
function observedCalls(Component: React.ComponentType<ProbeProps>): string[] {
  const calls: string[] = []
  const { rerender } = render(<Component cb={() => calls.push('FIRST')} />)
  rerender(<Component cb={() => calls.push('SECOND')} />)
  return calls
}

describe('useEffectEvent republish by fiber tag (React 19.2)', () => {
  it('republishes on a plain function component', () => {
    expect(observedCalls(PlainProbe)).toEqual(['FIRST', 'SECOND'])
  })

  it('republishes under memo(Fn, compare) — MemoComponent renders an inner function fiber', () => {
    expect(observedCalls(MemoWithCompareProbe)).toEqual(['FIRST', 'SECOND'])
  })

  it('does NOT republish under memo(Fn) — SimpleMemoComponent stays frozen at mount', () => {
    // If this ever reads ['FIRST', 'SECOND'], React has fixed the gap.
    expect(observedCalls(MemoProbe)).toEqual(['FIRST', 'FIRST'])
  })

  it('does NOT republish under forwardRef(Fn) — ForwardRef stays frozen at mount', () => {
    expect(observedCalls(ForwardRefProbe)).toEqual(['FIRST', 'FIRST'])
  })
})
