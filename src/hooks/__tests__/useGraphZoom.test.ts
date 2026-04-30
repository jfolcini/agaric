/**
 * Tests for useGraphZoom (MAINT-127 split from useGraphSimulation).
 *
 * The hook owns the d3 zoom behavior + keyboard zoom listener and exposes
 * three imperative zoom callbacks plus `attach(svg, g)` for the
 * orchestrator. Tests focus on observable effects: which d3-zoom APIs the
 * callbacks invoke, that `attach` registers + cleans up the keyboard
 * listener, and that callbacks are no-ops before `attach` runs.
 */

import { renderHook } from '@testing-library/react'
import { select } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraphZoom } from '../useGraphZoom'

vi.mock('d3-selection', () => ({
  select: vi.fn(() => ({
    selectAll: vi.fn().mockReturnThis(),
    transition: vi.fn().mockReturnThis(),
    duration: vi.fn().mockReturnThis(),
    call: vi.fn().mockReturnThis(),
    append: vi.fn().mockReturnThis(),
    attr: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  })),
}))

vi.mock('d3-zoom', () => ({
  zoom: vi.fn(() => ({
    scaleExtent: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    scaleBy: vi.fn(),
    transform: vi.fn(),
  })),
  zoomIdentity: { k: 1, x: 0, y: 0 },
}))

vi.mock('@/lib/keyboard-config', () => ({
  matchesShortcutBinding: vi.fn(() => false),
}))

interface FakeSvg {
  setAttribute: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function makeFakeSvg(): FakeSvg {
  return {
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useGraphZoom', () => {
  it('returns attach + zoomIn/zoomOut/zoomReset callbacks', () => {
    const ref = React.createRef<SVGSVGElement>()
    const { result } = renderHook(() => useGraphZoom(ref))
    expect(typeof result.current.attach).toBe('function')
    expect(typeof result.current.zoomIn).toBe('function')
    expect(typeof result.current.zoomOut).toBe('function')
    expect(typeof result.current.zoomReset).toBe('function')
  })

  it('zoom callbacks are no-ops before attach runs (no zoom behavior wired)', () => {
    const ref = React.createRef<SVGSVGElement>()
    // Point ref at a fake element so the callbacks pass the early-return guard.
    ;(ref as { current: SVGSVGElement | null }).current = {} as SVGSVGElement
    const { result } = renderHook(() => useGraphZoom(ref))
    // No throws even though no zoom behavior was attached yet.
    expect(() => {
      result.current.zoomIn()
      result.current.zoomOut()
      result.current.zoomReset()
    }).not.toThrow()
    // d3-zoom factory was never invoked because attach wasn't called.
    expect(zoom).not.toHaveBeenCalled()
  })

  it('attach registers a keydown listener and returns a cleanup that removes it', () => {
    const ref = React.createRef<SVGSVGElement>()
    const { result } = renderHook(() => useGraphZoom(ref))

    const fakeSvg = makeFakeSvg() as unknown as SVGSVGElement
    // biome-ignore lint/suspicious/noExplicitAny: GSel is not constructable in tests
    const fakeG = {} as any

    const cleanup = result.current.attach(fakeSvg, fakeG)

    const svgMock = fakeSvg as unknown as FakeSvg
    expect(svgMock.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(svgMock.removeEventListener).not.toHaveBeenCalled()

    cleanup()
    expect(svgMock.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('zoomIn invokes scaleBy with the zoom step after attach', () => {
    const ref = React.createRef<SVGSVGElement>()
    ;(ref as { current: SVGSVGElement | null }).current = makeFakeSvg() as unknown as SVGSVGElement
    const { result } = renderHook(() => useGraphZoom(ref))

    const fakeSvg = makeFakeSvg() as unknown as SVGSVGElement
    // biome-ignore lint/suspicious/noExplicitAny: GSel is not constructable in tests
    const fakeG = {} as any
    result.current.attach(fakeSvg, fakeG)
    result.current.zoomIn()

    // biome-ignore lint/suspicious/noExplicitAny: d3-zoom mock value access
    const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
    expect(zoomInstance.scaleBy).toHaveBeenCalledTimes(1)
    // Second arg is the zoom step (1.3) — the in/out parity is tested below.
    expect(zoomInstance.scaleBy.mock.calls[0]?.[1]).toBeCloseTo(1.3)
  })

  it('zoomOut and zoomReset invoke scaleBy / transform after attach', () => {
    const ref = React.createRef<SVGSVGElement>()
    ;(ref as { current: SVGSVGElement | null }).current = makeFakeSvg() as unknown as SVGSVGElement
    const { result } = renderHook(() => useGraphZoom(ref))

    const fakeSvg = makeFakeSvg() as unknown as SVGSVGElement
    // biome-ignore lint/suspicious/noExplicitAny: GSel is not constructable in tests
    const fakeG = {} as any
    result.current.attach(fakeSvg, fakeG)

    result.current.zoomOut()
    result.current.zoomReset()

    // biome-ignore lint/suspicious/noExplicitAny: d3-zoom mock value access
    const zoomInstance = vi.mocked(zoom).mock.results[0]?.value as any
    // zoomOut: scaleBy(transition, 1/1.3)
    expect(zoomInstance.scaleBy).toHaveBeenCalledTimes(1)
    expect(zoomInstance.scaleBy.mock.calls[0]?.[1]).toBeCloseTo(1 / 1.3)
    // zoomReset: transform(transition, zoomIdentity)
    expect(zoomInstance.transform).toHaveBeenCalledTimes(1)
    expect(zoomInstance.transform.mock.calls[0]?.[1]).toBe(zoomIdentity)
    // d3-selection's `select` was called for each zoom callback.
    expect(select).toHaveBeenCalled()
  })

  it('attach + zoomIn coexist: callbacks remain stable across re-renders', () => {
    const ref = React.createRef<SVGSVGElement>()
    ;(ref as { current: SVGSVGElement | null }).current = makeFakeSvg() as unknown as SVGSVGElement
    const { result, rerender } = renderHook(() => useGraphZoom(ref))

    const before = {
      attach: result.current.attach,
      zoomIn: result.current.zoomIn,
      zoomOut: result.current.zoomOut,
      zoomReset: result.current.zoomReset,
    }
    rerender()
    expect(result.current.attach).toBe(before.attach)
    expect(result.current.zoomIn).toBe(before.zoomIn)
    expect(result.current.zoomOut).toBe(before.zoomOut)
    expect(result.current.zoomReset).toBe(before.zoomReset)
  })
})
