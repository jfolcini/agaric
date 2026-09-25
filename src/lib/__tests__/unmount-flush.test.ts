/**
 * #5160 D2 — the blur flush acts only on what the edit ADDED. A block loaded
 * with several top-level nodes, an inline `key:: value` line or a leading task
 * marker keeps them after a typo fix; the same shapes typed into the block are
 * split, extracted or folded as before.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { classifyUnmountFlush, runUnmountFlush } from '@/lib/unmount-flush'

function run(loaded: string, changed: string) {
  const edit = vi.fn<(id: string, content: string) => Promise<boolean>>(() => Promise.resolve(true))
  const splitBlock = vi.fn<(id: string, content: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  )
  const result = runUnmountFlush({
    blockId: 'BLOCK',
    loaded,
    changed,
    edit,
    splitBlock,
    rootParentId: null,
  })
  return { result, edit, splitBlock }
}

describe('runUnmountFlush classifies the edit against the loaded content (#5160)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_property_def: () => null,
        set_property: () => undefined,
        set_todo_state: () => undefined,
      }),
    )
  })

  it('a loaded two-paragraph block with a typo fix is one plain edit', async () => {
    const { result, edit, splitBlock } = run('a\n\nb', 'a!\n\nb')
    await result.outcome
    expect(result.kind).toBe('edit')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'a!\n\nb')
    expect(splitBlock).not.toHaveBeenCalled()
  })

  it('a paragraph added inside the editor splits the block', async () => {
    const { result, splitBlock } = run('a', 'a\n\nb')
    await result.outcome
    expect(result.kind).toBe('split')
    expect(splitBlock).toHaveBeenCalledExactlyOnceWith('BLOCK', 'a\n\nb')
  })

  it('a line break typed into a block is not a split', async () => {
    const { result, edit } = run('a', 'a\nb')
    await result.outcome
    expect(result.kind).toBe('edit')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'a\nb')
  })

  it('a loaded `key:: v` line with a typo fix stays text', async () => {
    const { result, edit } = run('hello\nkey:: v', 'hello!\nkey:: v')
    await result.outcome
    expect(result.kind).toBe('edit')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'hello!\nkey:: v')
  })

  it('a typed `key:: v` line becomes a property', async () => {
    const { result, edit } = run('hello', 'hello\nkey:: v')
    await result.outcome
    expect(result.kind).toBe('property')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'hello')
  })

  it('only the property line the edit added is extracted', async () => {
    const { result, edit } = run('hello\nkey:: v', 'hello\nkey:: v\nother:: w')
    await result.outcome
    expect(result.kind).toBe('property')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'hello\nkey:: v')
  })

  it('a loaded task marker with a typo fix stays text', async () => {
    const { result, edit } = run('- [ ] open task', '- [ ] open task!')
    await result.outcome
    expect(result.kind).toBe('edit')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', '- [ ] open task!')
  })

  it('a typed task marker folds into the todo state', async () => {
    const { result, edit } = run('', '- [ ] buy milk')
    await result.outcome
    expect(result.kind).toBe('checkbox')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'buy milk')
  })
})

describe('classifyUnmountFlush', () => {
  it('is the pure decision the flush and the debounced commit share', () => {
    expect(classifyUnmountFlush('a\n\nb', 'a!\n\nb').kind).toBe('edit')
    expect(classifyUnmountFlush('a', 'a\n\nb').kind).toBe('split')
    expect(classifyUnmountFlush('key:: v', 'key:: v!').kind).toBe('edit')
    expect(classifyUnmountFlush('', 'key:: v').kind).toBe('property')
    expect(classifyUnmountFlush('- [ ] x', '- [ ] x!').kind).toBe('edit')
    expect(classifyUnmountFlush('', '- [ ] x').kind).toBe('checkbox')
  })
})
