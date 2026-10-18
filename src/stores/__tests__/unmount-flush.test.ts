/**
 * #5160 D2 — the blur flush acts only on what the edit ADDED. A block loaded
 * with several top-level nodes, an inline `key:: value` line or a leading task
 * marker keeps them after a typo fix; the same shapes typed into the block are
 * split, extracted or folded as before.
 *
 * #5160 follow-up 7a — a `#name` the block is saved with as text is a tag, as
 * import and paste read it.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, withOps } from '@/__tests__/fixtures'
import { deferred, mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { TagCacheRow } from '@/lib/bindings'
import { bumpFlushSeq } from '@/stores/inline-property-commit'
import { useSpaceStore } from '@/stores/space'
import { classifyUnmountFlush, runUnmountFlush, settlePendingSaves } from '@/stores/unmount-flush'

function run(loaded: string, changed: string, saved = true) {
  const edit = vi.fn<(id: string, content: string) => Promise<boolean>>(() =>
    Promise.resolve(saved),
  )
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
        list_property_defs: () => ({
          items: [],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }),
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

// #5448 — the branches that write the text only after an IPC answers are
// registered per block, so the empty-block cleanup can wait for them.
describe('settlePendingSaves', () => {
  it('resolves at once for a block with no save in flight', async () => {
    await expect(settlePendingSaves('NOBODY')).resolves.toBeUndefined()
  })

  it.each([
    { line: 'key:: v', ipc: 'set_property' as const, saved: '' },
    { line: '- [ ] ', ipc: 'set_todo_state' as const, saved: '' },
  ])(
    'waits for a typed `$line` until its $ipc has answered and the text is written',
    async ({ line, ipc, saved }) => {
      const answer = deferred<undefined>()
      vi.mocked(invoke).mockImplementation(
        mockInvokeCommands({
          get_property_def: () => null,
          list_property_defs: () => ({
            items: [],
            next_cursor: null,
            has_more: false,
            total_count: null,
          }),
          [ipc]: () => answer.promise,
        }),
      )
      const { result, edit } = run('', line)
      let settled = false
      const waiting = settlePendingSaves('BLOCK').then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(edit).not.toHaveBeenCalled()

      answer.resolve(undefined)
      await waiting
      expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', saved)
      await result.outcome
      // Settled: a second wait does not block on the finished save.
      await expect(settlePendingSaves('BLOCK')).resolves.toBeUndefined()
    },
  )

  it('a plain edit, which writes its text synchronously, registers nothing', async () => {
    const { result } = run('', 'plain text')
    await expect(settlePendingSaves('BLOCK')).resolves.toBeUndefined()
    await result.outcome
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
    expect(classifyUnmountFlush('', 'see #project').kind).toBe('tag')
  })

  it('reads a #name as import does: a tag after whitespace, even one it was loaded with', () => {
    expect(classifyUnmountFlush('see #project', 'see #project!').kind).toBe('tag')
    expect(classifyUnmountFlush('', 'a #[[deep work]]').kind).toBe('tag')
    expect(classifyUnmountFlush('', 'fixes #42').kind).toBe('edit')
    expect(classifyUnmountFlush('', 'see (#project)').kind).toBe('edit')
    expect(classifyUnmountFlush('', 'x `#endif`').kind).toBe('edit')
  })

  it('never reads a tag in a code block', () => {
    expect(classifyUnmountFlush('', '```c\n#include <x>\n```').kind).toBe('edit')
    // The fence around a ``` run pairs no backticks around the code.
    expect(classifyUnmountFlush('', '````\n#include ```\n````').kind).toBe('edit')
  })

  it('leaves a typed property line or task marker first to its own branch', () => {
    expect(classifyUnmountFlush('', 'see #project\nkey:: v').kind).toBe('property')
    expect(classifyUnmountFlush('', '- [ ] see #project').kind).toBe('checkbox')
  })
})

describe('a #name saved as text becomes the tag (#5160 follow-up 7a)', () => {
  const TAGS: TagCacheRow[] = [
    { tag_id: 'TAG_PROJECT', name: 'Project', usage_count: 1, updated_at: '' },
  ]
  const created: string[] = []

  beforeEach(() => {
    created.length = 0
    useSpaceStore.setState({ currentSpaceId: 'SPACE' })
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        list_all_tags_in_space: () => TAGS,
        create_block: (args) => {
          const name = args['content'] as string
          if (name === 'broken') throw new Error('create failed')
          created.push(name)
          return withOps(makeBlockRow({ id: `NEW_${created.length}`, block_type: 'tag' }))
        },
      }),
    )
  })

  afterEach(() => {
    useSpaceStore.setState({ currentSpaceId: null })
  })

  it('saves the text, then writes each tag as its id: the existing one in any case, else a new one', async () => {
    const { result, edit } = run('', 'see #project and #[[deep work]] now')
    expect(result.kind).toBe('tag')
    expect(edit).toHaveBeenCalledExactlyOnceWith('BLOCK', 'see #project and #[[deep work]] now')
    await expect(result.outcome).resolves.toBe(true)
    expect(created).toEqual(['deep work'])
    expect(edit).toHaveBeenLastCalledWith('BLOCK', 'see #[TAG_PROJECT] and #[NEW_1] now')
    expect(edit).toHaveBeenCalledTimes(2)
  })

  it('creates a new name once, however many times the block writes it', async () => {
    const { result, edit } = run('', '#plan and #Plan')
    await result.outcome
    expect(created).toEqual(['plan'])
    expect(edit).toHaveBeenLastCalledWith('BLOCK', '#[NEW_1] and #[NEW_1]')
  })

  it('keeps a name whose create fails as text and writes the rest', async () => {
    const { result, edit } = run('', '#broken #project')
    await expect(result.outcome).resolves.toBe(true)
    expect(edit).toHaveBeenLastCalledWith('BLOCK', '#broken #[TAG_PROJECT]')
  })

  it('leaves the text when the save failed, so the draft is kept', async () => {
    const { result, edit } = run('', 'see #project', false)
    await expect(result.outcome).resolves.toBe(false)
    expect(edit).toHaveBeenCalledOnce()
  })

  it('leaves the text with no active space', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    const { result, edit } = run('', 'see #project')
    await expect(result.outcome).resolves.toBe(true)
    expect(edit).toHaveBeenCalledOnce()
  })

  it('writes nothing more once a newer save of the block has started', async () => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        list_all_tags_in_space: () => {
          bumpFlushSeq('BLOCK')
          return TAGS
        },
      }),
    )
    const { result, edit } = run('', 'see #project and #new')
    await expect(result.outcome).resolves.toBe(true)
    expect(edit).toHaveBeenCalledOnce()
    expect(created).toEqual([])
  })
})

describe('one leave commits every kind the edit typed, as page mode does', () => {
  // A task paragraph's Shift+Enter line break serializes as `\` and a newline.
  const TYPED = '- [ ] call mom #work\\\nstatus:: done'
  const calls: string[] = []

  function mockCommands(overrides: Parameters<typeof mockInvokeCommands>[0] = {}) {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        set_todo_state: (args) => {
          calls.push(`todo:${args['state'] as string}`)
          return undefined
        },
        get_property_def: () => null,
        list_property_defs: () => ({
          items: [],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }),
        set_property: (args) => {
          const value = args['value'] as { value_text: string }
          calls.push(`property:${args['key'] as string}=${value.value_text}`)
          return undefined
        },
        list_all_tags_in_space: (): TagCacheRow[] => [
          { tag_id: 'TAG_WORK', name: 'work', usage_count: 1, updated_at: '' },
        ],
        ...overrides,
      }),
    )
  }

  beforeEach(() => {
    calls.length = 0
    useSpaceStore.setState({ currentSpaceId: 'SPACE' })
    mockCommands()
  })

  afterEach(() => {
    useSpaceStore.setState({ currentSpaceId: null })
  })

  it('a typed task marker, property line and tag: the state, the property, then the tag', async () => {
    const { result, edit } = run('', TYPED)
    await expect(result.outcome).resolves.toBe(true)
    expect(calls).toEqual(['todo:TODO', 'property:status=done'])
    expect(edit.mock.calls.map(([, content]) => content)).toEqual([
      'call mom #work\\\nstatus:: done',
      'call mom #work',
      'call mom #[TAG_WORK]',
    ])
  })

  it('a refused task state keeps the marker as text and still commits the property and the tag', async () => {
    mockCommands({
      set_todo_state: () => {
        throw new Error('refused')
      },
    })
    const { result, edit } = run('', TYPED)
    await expect(result.outcome).resolves.toBe(true)
    expect(calls).toEqual(['property:status=done'])
    expect(edit).toHaveBeenLastCalledWith('BLOCK', '- [ ] call mom #[TAG_WORK]')
  })

  it('a failed text write is carried by the next one', async () => {
    const { result, edit } = run('', TYPED)
    edit.mockResolvedValueOnce(false)
    await expect(result.outcome).resolves.toBe(true)
    expect(calls).toEqual(['todo:TODO', 'property:status=done'])
    expect(edit.mock.calls.map(([, content]) => content)).toEqual([
      'call mom #work\\\nstatus:: done',
      'call mom #work',
      'call mom #[TAG_WORK]',
    ])
  })

  it('a refused property line writes the text once, then the tag', async () => {
    mockCommands({
      set_property: () => {
        throw new Error('refused')
      },
    })
    const { result, edit } = run('', TYPED)
    await expect(result.outcome).resolves.toBe(true)
    expect(edit.mock.calls.map(([, content]) => content)).toEqual([
      'call mom #work\\\nstatus:: done',
      'call mom #[TAG_WORK]\\\nstatus:: done',
    ])
  })

  it('stops once a newer save of the block has started', async () => {
    mockCommands({
      set_todo_state: () => {
        bumpFlushSeq('BLOCK')
        return undefined
      },
    })
    const { result, edit } = run('', TYPED)
    await expect(result.outcome).resolves.toBe(true)
    expect(calls).toEqual([])
    expect(edit).not.toHaveBeenCalled()
  })
})
