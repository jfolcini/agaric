/**
 * Tests for useZoomPan (#5638) — the surface the lightbox and the diagram
 * viewer share. The lightbox's own suite pins keys, buttons and wheel zoom;
 * these cover what only the diagram viewer uses: a fitted `minZoom`, wheel
 * panning, and the two-finger pinch.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useZoomPan, type ZoomPanOptions } from '@/hooks/useZoomPan'

function Surface(props: Partial<ZoomPanOptions>): React.ReactElement {
  const { setNode, setGestureNode, style, gestureHandlers } = useZoomPan({
    active: true,
    ...props,
  })
  return (
    <div ref={setGestureNode} {...gestureHandlers} data-testid="area">
      <div ref={setNode} style={style} data-testid="surface" />
    </div>
  )
}

const transform = () => screen.getByTestId('surface').style.transform

describe('useZoomPan', () => {
  it('starts at minZoom and returns to it on 0', () => {
    render(<Surface minZoom={0.5} />)
    expect(transform()).toContain('scale(0.5)')
    fireEvent.keyDown(window, { key: '+' })
    expect(transform()).toContain('scale(0.75)')
    fireEvent.keyDown(window, { key: '0' })
    expect(transform()).toContain('scale(0.5)')
  })

  it('leaves Ctrl/⌘ with + - 0 to the interface zoom', () => {
    render(<Surface />)
    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    fireEvent.keyDown(window, { key: '+', metaKey: true })
    expect(transform()).toContain('scale(1)')
    fireEvent.keyDown(window, { key: '=' })
    fireEvent.keyDown(window, { key: '-', ctrlKey: true })
    fireEvent.keyDown(window, { key: '0', metaKey: true })
    expect(transform()).toContain('scale(1.25)')
  })

  it('pans on a plain wheel and zooms on Ctrl + wheel in pan mode', () => {
    render(<Surface wheel="pan" />)
    // The pan limit comes from the zoomed content; the wheel lands around it.
    const surface = screen.getByTestId('surface')
    Object.defineProperty(surface, 'clientWidth', { value: 400 })
    Object.defineProperty(surface, 'clientHeight', { value: 400 })
    const area = screen.getByTestId('area')
    const ctrlWheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
    // happy-dom's WheelEvent init drops modifier keys.
    Object.defineProperty(ctrlWheel, 'ctrlKey', { value: true })
    fireEvent(area, ctrlWheel)
    expect(transform()).toContain('scale(1.25)')
    fireEvent.wheel(area, { deltaY: 20, deltaX: 0 })
    expect(transform()).toContain('translate(0px, -20px) scale(1.25)')
  })

  it('zooms by the ratio two pointers spread apart', () => {
    render(<Surface />)
    const area = screen.getByTestId('area')
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 0 })
    fireEvent.pointerDown(area, { pointerId: 2, clientX: 140, clientY: 0 })
    fireEvent.pointerMove(area, { pointerId: 2, clientX: 180, clientY: 0 })
    expect(transform()).toContain('scale(2)')
    fireEvent.pointerUp(area, { pointerId: 2 })
    fireEvent.pointerUp(area, { pointerId: 1 })
    expect(transform()).toContain('scale(2)')
  })
})
