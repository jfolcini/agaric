import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  type SelectOptionsDraftActions,
  useSelectOptionsDraft,
} from '@/hooks/useSelectOptionsDraft'

const SAVED = ['alpha', 'beta', 'gamma'] as const

function setup(actions: Partial<SelectOptionsDraftActions> = {}) {
  const save = actions.save ?? vi.fn(async () => true)
  const hook = renderHook(() => useSelectOptionsDraft(SAVED, { ...actions, save }))
  act(() => hook.result.current.handleOpen())
  return { ...hook, save }
}

function addOption(result: { current: ReturnType<typeof useSelectOptionsDraft> }, name: string) {
  act(() => result.current.setNewOptionInput(name))
  act(() => result.current.handleAdd())
}

describe('useSelectOptionsDraft', () => {
  it('opens on a copy of the saved options', () => {
    const { result } = setup()
    expect(result.current.open).toBe(true)
    expect(result.current.options).toEqual(['alpha', 'beta', 'gamma'])
    expect(result.current.saved).toEqual(SAVED)
  })

  it('adds a trimmed name once, removes and moves', () => {
    const { result } = setup()
    addOption(result, '  delta ')
    addOption(result, 'delta')
    expect(result.current.options).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    expect(result.current.newOptionInput).toBe('')
    act(() => result.current.handleRemove('beta'))
    act(() => result.current.handleMove('delta', 'up'))
    act(() => result.current.handleMove('alpha', 'up'))
    expect(result.current.options).toEqual(['alpha', 'delta', 'gamma'])
  })

  it('a blank name is not offered and adds nothing', () => {
    const { result } = setup()
    act(() => result.current.setNewOptionInput('   '))
    expect(result.current.canAddOption).toBe(false)
    act(() => result.current.handleAdd())
    expect(result.current.options).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('save writes the draft and closes when it succeeds', async () => {
    const { result, save } = setup()
    act(() => result.current.handleRemove('gamma'))
    await act(() => result.current.handleSave())
    expect(save).toHaveBeenCalledWith(['alpha', 'beta'])
    expect(result.current.open).toBe(false)
  })

  it('a failed save keeps the popover and the draft', async () => {
    const { result } = setup({ save: vi.fn(async () => false) })
    act(() => result.current.handleRemove('gamma'))
    await act(() => result.current.handleSave())
    expect(result.current.open).toBe(true)
    expect(result.current.options).toEqual(['alpha', 'beta'])
  })

  it('offers no rename when the caller has none', () => {
    const { result } = setup()
    expect(result.current.handleRename).toBeNull()
  })

  it('a rename maps the draft in place and drops a pending add of the new name', async () => {
    const rename = vi.fn(async () => true)
    const { result } = setup({ rename })
    addOption(result, 'apollo')
    let renamed = false
    await act(async () => {
      renamed = (await result.current.handleRename?.('alpha', 'apollo')) ?? false
    })
    expect(renamed).toBe(true)
    expect(rename).toHaveBeenCalledWith('alpha', 'apollo')
    expect(result.current.options).toEqual(['apollo', 'beta', 'gamma'])
  })

  it('a failed rename leaves the draft alone', async () => {
    const { result } = setup({ rename: vi.fn(async () => false) })
    addOption(result, 'apollo')
    let renamed = true
    await act(async () => {
      renamed = (await result.current.handleRename?.('alpha', 'apollo')) ?? true
    })
    expect(renamed).toBe(false)
    expect(result.current.options).toEqual(['alpha', 'beta', 'gamma', 'apollo'])
  })
})
