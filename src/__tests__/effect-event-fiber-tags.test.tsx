/**
 * Pins React's `useEffectEvent` republish behaviour per fiber tag, because the
 * #4377 refactor depends on it and it is not documented anywhere.
 *
 * An effect event's implementation is republished from the commit phase, in
 * `commitBeforeMutationEffectsOnFiber` (`react-dom-client.development.js`).
 * Through React 19.2 that switch drained `fiber.updateQueue.events` for
 * `FunctionComponent` only, then fell through `case ForwardRef: case
 * SimpleMemoComponent: break` — draining nothing. On those two tags the
 * implementation captured at MOUNT was the one every later call dispatched to,
 * for the life of the component, with no warning and no lint rule to catch it.
 *
 * React 19.3 closed that gap: all four wrappers below republish. The cases are
 * still the whole decision surface, so they stay pinned — a React regression
 * (or a downgrade) that reopens the gap reddens here rather than silently
 * freezing a callback:
 *
 * | wrapper                  | fiber tag             | republished? |
 * |--------------------------|-----------------------|--------------|
 * | none                     | FunctionComponent     | yes          |
 * | `memo(Fn)`               | SimpleMemoComponent   | yes (19.3)   |
 * | `memo(Fn, compare)`      | MemoComponent (+ an   | yes          |
 * |                          | inner FunctionComp.)  |              |
 * | `forwardRef(Fn)`         | ForwardRef            | yes (19.3)   |
 *
 * With the gap closed, the companion guard (`effect-event-fiber-owner.test.ts`)
 * and the `useLayoutEffect` mirror `DaySection` uses in its place are no longer
 * load-bearing; both are kept until someone deliberately retires them, see
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

describe('useEffectEvent republish by fiber tag (React 19.3)', () => {
  it('republishes on a plain function component', () => {
    expect(observedCalls(PlainProbe)).toEqual(['FIRST', 'SECOND'])
  })

  it('republishes under memo(Fn, compare) — MemoComponent renders an inner function fiber', () => {
    expect(observedCalls(MemoWithCompareProbe)).toEqual(['FIRST', 'SECOND'])
  })

  it('republishes under memo(Fn) — SimpleMemoComponent, fixed in React 19.3', () => {
    expect(observedCalls(MemoProbe)).toEqual(['FIRST', 'SECOND'])
  })

  it('republishes under forwardRef(Fn) — ForwardRef, fixed in React 19.3', () => {
    expect(observedCalls(ForwardRefProbe)).toEqual(['FIRST', 'SECOND'])
  })
})
