/**
 * useZoomPan — the zoom-and-pan surface shared by the image lightbox and the
 * diagram viewer (#294 item 7, #5638).
 *
 * `zoom` is a scale factor and `pan` a CSS-px translation applied before it.
 * The zoomed element takes `style` and `setNode`; the element that receives
 * gestures takes `gestureHandlers` and `setGestureNode`. They differ when the
 * content can be smaller than the area around it, such as a fitted diagram.
 * Inputs: `+`/`=`, `-`/`_` and `0` (back to `minZoom`) on the window, arrow
 * keys pan while zoomed, the wheel zooms (or pans, with `wheel: 'pan'`, where
 * Ctrl/⌘ + wheel and a trackpad pinch zoom), one pointer drags while zoomed,
 * and two pointers pinch.
 */

import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const ZOOM_STEP = 0.25
const MAX_ZOOM = 4
/** Pixels panned per arrow-key press while zoomed in. */
const PAN_KEY_STEP = 60

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

interface Point {
  x: number
  y: number
}
type Gesture =
  | { kind: 'drag'; x: number; y: number; panX: number; panY: number }
  | { kind: 'pinch'; distance: number; zoom: number }

const distance = ([a, b]: Point[]): number => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0)

export interface ZoomPanOptions {
  /** Listen for keys only while the surface is on screen. */
  active: boolean
  /** Zoom and pan return to `minZoom` whenever this changes. */
  resetKey?: unknown
  minZoom?: number
  wheel?: 'zoom' | 'pan'
  /** Called for ArrowLeft/ArrowRight while not zoomed; return true when handled. */
  onUnzoomedArrow?: ((key: 'ArrowLeft' | 'ArrowRight') => boolean) | undefined
}

export function useZoomPan({
  active,
  resetKey,
  minZoom = 1,
  wheel = 'zoom',
  onUnzoomedArrow,
}: ZoomPanOptions) {
  const nodeRef = useRef<HTMLElement | null>(null)
  const setNode = useCallback((el: HTMLElement | null) => {
    nodeRef.current = el
  }, [])
  // State, not a ref, so the wheel effect re-attaches exactly when the DOM node
  // changes (#2760): a Radix Portal mounts in two passes, so an effect keyed on
  // anything else can run before the node exists.
  const [gestureNode, setGestureNode] = useState<HTMLElement | null>(null)
  const [zoom, setZoom] = useState(minZoom)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const zoomed = zoom > minZoom

  // Keep the scaled node from leaving the view: at most half its growth past
  // `minZoom` in each axis. Layout size is unaffected by the CSS transform.
  const clampPan = useCallback(
    (p: Point, z: number): Point => {
      const el = nodeRef.current
      if (!el || z <= minZoom) return { x: 0, y: 0 }
      const maxX = (el.clientWidth * (z - minZoom)) / 2
      const maxY = (el.clientHeight * (z - minZoom)) / 2
      return { x: clamp(p.x, -maxX, maxX), y: clamp(p.y, -maxY, maxY) }
    },
    [minZoom],
  )

  const zoomTo = useCallback(
    (z: number) => setZoom(clamp(Number(z.toFixed(2)), minZoom, MAX_ZOOM)),
    [minZoom],
  )
  const zoomBy = useCallback(
    (delta: number) => setZoom((z) => clamp(Number((z + delta).toFixed(2)), minZoom, MAX_ZOOM)),
    [minZoom],
  )
  const resetZoom = useCallback(() => {
    setZoom(minZoom)
    setPan({ x: 0, y: 0 })
  }, [minZoom])
  const panBy = useCallback(
    (dx: number, dy: number) => setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, zoom)),
    [clampPan, zoom],
  )

  // Re-clamp pan whenever the zoom changes (zooming back out recenters).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the pan bound comes from the node's measured size, not from props; see #4407
    setPan((p) => clampPan(p, zoom))
  }, [zoom, clampPan])

  // A layout effect, so new content or a new fit is never painted at the old zoom.
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- returns to the fitted view when the shown content or the fit changes; wheel, drag and keys drive it afterwards; see #4407
    resetZoom()
  }, [resetKey, active, resetZoom])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const pans: Record<string, Point> = {
        ArrowLeft: { x: PAN_KEY_STEP, y: 0 },
        ArrowRight: { x: -PAN_KEY_STEP, y: 0 },
        ArrowUp: { x: 0, y: PAN_KEY_STEP },
        ArrowDown: { x: 0, y: -PAN_KEY_STEP },
      }
      const handled = (): boolean => {
        const step = pans[e.key]
        if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP)
        else if (e.key === '-' || e.key === '_') zoomBy(-ZOOM_STEP)
        else if (e.key === '0') resetZoom()
        else if (zoomed && step) panBy(step.x, step.y)
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          return onUnzoomedArrow?.(e.key) ?? false
        } else return false
        return true
      }
      if (handled()) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, zoomed, zoomBy, resetZoom, panBy, onUnzoomedArrow])

  // A native non-passive listener, not JSX `onWheel` (#2760): React's root
  // wheel listener is passive, so `preventDefault()` there is a no-op.
  useEffect(() => {
    if (!gestureNode) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (wheel === 'pan' && !e.ctrlKey && !e.metaKey) panBy(-e.deltaX, -e.deltaY)
      else zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
    }
    gestureNode.addEventListener('wheel', onWheel, { passive: false })
    return () => gestureNode.removeEventListener('wheel', onWheel)
  }, [gestureNode, wheel, zoomBy, panBy])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.current.size === 2) {
        gesture.current = {
          kind: 'pinch',
          distance: distance([...pointers.current.values()]),
          zoom,
        }
        setDragging(false)
      } else if (zoomed) {
        gesture.current = { kind: 'drag', x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
        setDragging(true)
      } else return
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    [zoom, zoomed, pan.x, pan.y],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const g = gesture.current
      if (g?.kind === 'pinch' && g.distance > 0) {
        zoomTo((g.zoom * distance([...pointers.current.values()])) / g.distance)
      } else if (g?.kind === 'drag') {
        setPan(clampPan({ x: g.panX + (e.clientX - g.x), y: g.panY + (e.clientY - g.y) }, zoom))
      }
    },
    [zoomTo, clampPan, zoom],
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (!gesture.current) return
    gesture.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  return {
    zoom,
    zoomed,
    canZoomIn: zoom < MAX_ZOOM,
    dragging,
    zoomBy,
    zoomTo,
    resetZoom,
    setNode,
    setGestureNode,
    style: { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` },
    gestureHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  }
}
