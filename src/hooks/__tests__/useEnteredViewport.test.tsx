/**
 * useEnteredViewport: the gate opens once its element is on screen, including
 * an element that mounts after the hook did (#6990: a week day whose page
 * arrives after the day rendered).
 */

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import { useEnteredViewport } from '@/hooks/useEnteredViewport'

function Gate({ shown }: { shown: boolean }) {
  const [entered, ref] = useEnteredViewport<HTMLDivElement>()
  if (entered) return <p>entered</p>
  return shown ? <div ref={ref} data-testid="target" /> : null
}

beforeEach(() => {
  EnteringIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useEnteredViewport', () => {
  it('opens once an element shown from the first render is on screen', () => {
    render(<Gate shown />)
    expect(screen.getByText('entered')).toBeInTheDocument()
  })

  it('opens once an element that mounts after the hook is on screen', () => {
    const { rerender } = render(<Gate shown={false} />)
    expect(screen.queryByText('entered')).not.toBeInTheDocument()

    act(() => {
      rerender(<Gate shown />)
    })

    expect(screen.getByText('entered')).toBeInTheDocument()
  })
})
