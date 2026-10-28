// @vitest-environment jsdom

/**
 * useListStyles with tasks (#5691 D3): a task is a list kind, so the map
 * holds no style for a block holding a task state, whatever it stores, and a
 * task state set or cleared changes the map.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makePropertyRow } from '@/__tests__/fixtures'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { BatchPropertiesProvider } from '@/hooks/useBatchPropertyRows'
import { useListStyles } from '@/hooks/useListStyles'
import { LIST_STYLE_KEY } from '@/lib/list-style'

const mockedInvoke = vi.mocked(invoke)

const wrapper = ({ children }: { children: ReactNode }) => (
  <BatchPropertiesProvider blockIds={['A', 'B']}>{children}</BatchPropertiesProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  stubInvoke(mockedInvoke, {
    get_batch_properties: () => ({
      A: [makePropertyRow({ key: LIST_STYLE_KEY, value_text: 'bullet' })],
      B: [makePropertyRow({ key: LIST_STYLE_KEY, value_text: 'ordered' })],
    }),
  })
})

describe('useListStyles with tasks', () => {
  it('a task shows no style; a block made a task, or no longer one, follows', async () => {
    const { result, rerender } = renderHook(
      ({ todo }: { todo: string | null }) =>
        useListStyles([
          { id: 'A', todo_state: null },
          { id: 'B', todo_state: todo },
        ]),
      { wrapper, initialProps: { todo: 'TODO' as string | null } },
    )
    await waitFor(() => expect(result.current.get('A')).toBe('bullet'))
    expect(result.current.has('B')).toBe(false)

    rerender({ todo: null })
    expect(result.current.get('B')).toBe('ordered')

    rerender({ todo: 'DONE' })
    expect([...result.current]).toEqual([['A', 'bullet']])
  })
})
