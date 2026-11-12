import { invoke } from '@tauri-apps/api/core'
import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { useTaskStateCycle } from '@/hooks/useTaskStateCycle'

vi.mock('@tauri-apps/api/core', async () => ({
  invoke: vi.fn((await import('@/__tests__/helpers/invoke')).strictInvokeFallback),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const mockedInvoke = vi.mocked(invoke)

/** A one-block backend: `set_todo_state` writes the state `get` reads back. */
function stubBackend(fail = false): { get: () => string | null } {
  let state: string | null = 'TODO'
  stubInvoke(mockedInvoke, {
    set_todo_state: (args) => {
      if (fail) throw new Error('refused')
      state = (args['state'] as string | null) ?? null
      return withOps(makeBlockRow({ id: 'B1', todo_state: state }))
    },
  })
  return { get: () => state }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTaskStateCycle', () => {
  it('moves a task to the next state in the block cycle', async () => {
    const backend = stubBackend()
    const { result } = renderHook(() => useTaskStateCycle())

    await result.current('B1', 'TODO')
    expect(backend.get()).toBe('DOING')
    await result.current('B1', 'DOING')
    expect(backend.get()).toBe('DONE')
  })

  it('reports a refused write instead of rejecting', async () => {
    const backend = stubBackend(true)
    const { result } = renderHook(() => useTaskStateCycle())

    await expect(result.current('B1', 'TODO')).resolves.toBeUndefined()
    expect(backend.get()).toBe('TODO')
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
