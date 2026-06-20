/**
 * Tests for the focus-keyed block command bus (#1250).
 *
 * Validates that `dispatchBlockCommand` routes a command to the SINGLE
 * registered BlockTree whose page store owns the global `focusedBlockId`,
 * no-ops when nothing is focused / no store owns the focused block, forwards
 * the `detail` payload, supports every `BLOCK_EVENTS` command name, and that
 * registrations are removed by their cleanup (no listener fan-out / leakage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { useBlockStore } from '../../stores/blocks'
import type { PageBlockState } from '../../stores/page-blocks'
import {
  __resetBlockCommandBus,
  type BlockCommandName,
  dispatchBlockCommand,
  registerBlockCommandTarget,
  registeredBlockCommandTargetCount,
} from '../block-command-bus'
import { BLOCK_EVENTS } from '../block-events'

/** Page-store stub owning the given block ids (the bus reads `blocksById.has`). */
function makeStore(ownedIds: string[]): StoreApi<PageBlockState> {
  const blocksById = new Map(ownedIds.map((id) => [id, { id }]))
  return {
    setState: vi.fn(),
    getState: () => ({ blocksById }),
    getInitialState: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as StoreApi<PageBlockState>
}

function setFocus(id: string | null): void {
  useBlockStore.setState({ focusedBlockId: id })
}

beforeEach(() => {
  __resetBlockCommandBus()
  setFocus(null)
})

afterEach(() => {
  __resetBlockCommandBus()
  setFocus(null)
})

describe('dispatchBlockCommand', () => {
  it('routes to the registered store that owns the focused block', () => {
    const a = vi.fn()
    const b = vi.fn()
    registerBlockCommandTarget(makeStore(['BLOCK_A']), { TOGGLE_TODO_STATE: a })
    registerBlockCommandTarget(makeStore(['BLOCK_B']), { TOGGLE_TODO_STATE: b })

    setFocus('BLOCK_A')
    dispatchBlockCommand('TOGGLE_TODO_STATE')

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('BLOCK_A', undefined)
    expect(b).not.toHaveBeenCalled()
  })

  it('is a no-op when no block is focused', () => {
    const handler = vi.fn()
    registerBlockCommandTarget(makeStore(['BLOCK_A']), { CYCLE_PRIORITY: handler })

    setFocus(null)
    dispatchBlockCommand('CYCLE_PRIORITY')

    expect(handler).not.toHaveBeenCalled()
  })

  it('is a no-op when no registered store owns the focused block', () => {
    const handler = vi.fn()
    registerBlockCommandTarget(makeStore(['BLOCK_A']), { CYCLE_PRIORITY: handler })

    setFocus('BLOCK_FOREIGN')
    dispatchBlockCommand('CYCLE_PRIORITY')

    expect(handler).not.toHaveBeenCalled()
  })

  it('is a no-op when the owning target has no handler for the command', () => {
    const handler = vi.fn()
    // Registers TOGGLE_TODO_STATE only — dispatching CYCLE_PRIORITY must no-op.
    registerBlockCommandTarget(makeStore(['BLOCK_A']), { TOGGLE_TODO_STATE: handler })

    setFocus('BLOCK_A')
    dispatchBlockCommand('CYCLE_PRIORITY')

    expect(handler).not.toHaveBeenCalled()
  })

  it('forwards the detail payload to the handler', () => {
    const handler = vi.fn()
    registerBlockCommandTarget(makeStore(['BLOCK_A']), { INSERT_CALLOUT: handler })

    setFocus('BLOCK_A')
    dispatchBlockCommand('INSERT_CALLOUT', { type: 'warning' })

    expect(handler).toHaveBeenCalledWith('BLOCK_A', { type: 'warning' })
  })

  it('invokes the handler exactly once even with several trees registered', () => {
    const owner = vi.fn()
    registerBlockCommandTarget(makeStore(['BLOCK_A']), { TOGGLE_TODO_STATE: owner })
    // Four more non-owning trees (journal week shape).
    for (let i = 0; i < 4; i++) {
      registerBlockCommandTarget(makeStore([`OTHER_${i}`]), { TOGGLE_TODO_STATE: vi.fn() })
    }
    expect(registeredBlockCommandTargetCount()).toBe(5)

    setFocus('BLOCK_A')
    dispatchBlockCommand('TOGGLE_TODO_STATE')

    expect(owner).toHaveBeenCalledTimes(1)
  })

  it('supports every BLOCK_EVENTS command name', () => {
    const names = Object.keys(BLOCK_EVENTS) as BlockCommandName[]
    const calls: BlockCommandName[] = []
    const handlers = Object.fromEntries(
      names.map((n) => [n, () => calls.push(n)]),
    ) as unknown as Record<BlockCommandName, () => void>

    registerBlockCommandTarget(makeStore(['BLOCK_A']), handlers)
    setFocus('BLOCK_A')

    for (const name of names) dispatchBlockCommand(name)

    expect(calls.toSorted()).toEqual([...names].toSorted())
  })
})

describe('registerBlockCommandTarget', () => {
  it('cleanup removes the registration', () => {
    const handler = vi.fn()
    const cleanup = registerBlockCommandTarget(makeStore(['BLOCK_A']), {
      CYCLE_PRIORITY: handler,
    })
    expect(registeredBlockCommandTargetCount()).toBe(1)

    cleanup()
    expect(registeredBlockCommandTargetCount()).toBe(0)

    setFocus('BLOCK_A')
    dispatchBlockCommand('CYCLE_PRIORITY')
    expect(handler).not.toHaveBeenCalled()
  })

  it('re-registering the same store replaces the handler set (latest wins)', () => {
    const store = makeStore(['BLOCK_A'])
    const first = vi.fn()
    const second = vi.fn()

    registerBlockCommandTarget(store, { CYCLE_PRIORITY: first })
    registerBlockCommandTarget(store, { CYCLE_PRIORITY: second })
    expect(registeredBlockCommandTargetCount()).toBe(1)

    setFocus('BLOCK_A')
    dispatchBlockCommand('CYCLE_PRIORITY')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('a stale cleanup does not tear down a newer registration on the same store', () => {
    const store = makeStore(['BLOCK_A'])
    const first = vi.fn()
    const second = vi.fn()

    const staleCleanup = registerBlockCommandTarget(store, { CYCLE_PRIORITY: first })
    registerBlockCommandTarget(store, { CYCLE_PRIORITY: second })

    // The first registration's cleanup runs AFTER the re-register — it must
    // not remove the live (second) registration.
    staleCleanup()
    expect(registeredBlockCommandTargetCount()).toBe(1)

    setFocus('BLOCK_A')
    dispatchBlockCommand('CYCLE_PRIORITY')
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('listener/registration count does NOT scale with command count (one entry per tree)', () => {
    // Seven trees (journal week) each registering all 13 commands → 7 entries,
    // not 7 × 13. The bus holds one registration per tree, period.
    for (let i = 0; i < 7; i++) {
      const handlers = Object.fromEntries(
        (Object.keys(BLOCK_EVENTS) as BlockCommandName[]).map((n) => [n, vi.fn()]),
      ) as unknown as Record<BlockCommandName, () => void>
      registerBlockCommandTarget(makeStore([`B_${i}`]), handlers)
    }
    expect(registeredBlockCommandTargetCount()).toBe(7)
  })
})
