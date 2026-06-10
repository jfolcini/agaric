/**
 * Tests for the Android back-chain registry (#716).
 *
 * Validates:
 * - empty chain → not handled
 * - priority order (higher priority runs first)
 * - LIFO ordering within the same priority band
 * - first `true` short-circuits lower-priority handlers
 * - unregister removes the handler (and is idempotent)
 * - a throwing handler is skipped without breaking the chain
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetBackHandlersForTests,
  BACK_PRIORITY_NAVIGATION,
  BACK_PRIORITY_OVERLAY,
  BACK_PRIORITY_ZOOM,
  registerBackHandler,
  runBackChain,
} from '../back-chain'

describe('back-chain registry', () => {
  beforeEach(() => {
    __resetBackHandlersForTests()
  })

  it('returns false when no handlers are registered', () => {
    expect(runBackChain()).toBe(false)
  })

  it('returns false when every handler declines', () => {
    registerBackHandler(() => false, BACK_PRIORITY_OVERLAY)
    registerBackHandler(() => false, BACK_PRIORITY_NAVIGATION)
    expect(runBackChain()).toBe(false)
  })

  it('runs handlers in descending priority order', () => {
    const order: string[] = []
    registerBackHandler(() => {
      order.push('navigation')
      return false
    }, BACK_PRIORITY_NAVIGATION)
    registerBackHandler(() => {
      order.push('overlay')
      return false
    }, BACK_PRIORITY_OVERLAY)
    registerBackHandler(() => {
      order.push('zoom')
      return false
    }, BACK_PRIORITY_ZOOM)

    runBackChain()
    expect(order).toEqual(['overlay', 'zoom', 'navigation'])
  })

  it('short-circuits lower-priority handlers once one consumes the press', () => {
    const navigation = vi.fn(() => true)
    const overlay = vi.fn(() => true)
    registerBackHandler(navigation, BACK_PRIORITY_NAVIGATION)
    registerBackHandler(overlay, BACK_PRIORITY_OVERLAY)

    expect(runBackChain()).toBe(true)
    expect(overlay).toHaveBeenCalledTimes(1)
    expect(navigation).not.toHaveBeenCalled()
  })

  it('resolves same-priority ties LIFO (most recently registered wins)', () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    registerBackHandler(first, BACK_PRIORITY_ZOOM)
    registerBackHandler(second, BACK_PRIORITY_ZOOM)

    expect(runBackChain()).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('unregister removes the handler and is idempotent', () => {
    const handler = vi.fn(() => true)
    const unregister = registerBackHandler(handler, BACK_PRIORITY_OVERLAY)

    unregister()
    unregister() // second call must be a no-op, not an error

    expect(runBackChain()).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('skips a throwing handler and continues down the chain', () => {
    const navigation = vi.fn(() => true)
    registerBackHandler(navigation, BACK_PRIORITY_NAVIGATION)
    registerBackHandler(() => {
      throw new Error('broken overlay')
    }, BACK_PRIORITY_OVERLAY)

    expect(runBackChain()).toBe(true)
    expect(navigation).toHaveBeenCalledTimes(1)
  })
})
