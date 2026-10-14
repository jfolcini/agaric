/**
 * Tests for `resolveTitles` — cache-first title lookup with one
 * `batch_resolve` for the misses (#5439).
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { ResolvedBlock } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { resolveTitles } from '@/stores/resolve-titles'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const SPACE = 'SPACE_1'
const SCOPE = { kind: 'active', space_id: SPACE }

function row(id: string, title: string | null, deleted = false): ResolvedBlock {
  return { id, title, block_type: 'page', deleted }
}

/** `batch_resolve` answering from `rows`; returns the id lists it was asked for. */
function stubBatchResolve(rows: ResolvedBlock[]): string[][] {
  const asked: string[][] = []
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      batch_resolve: (args) => {
        const ids = args['ids'] as string[]
        asked.push(ids)
        return rows.filter((r) => ids.includes(r.id))
      },
    }),
  )
  return asked
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: SPACE })
  useResolveStore.setState({ cache: new Map(), version: 0 })
})

describe('resolveTitles', () => {
  it('answers a full cache hit without any IPC', async () => {
    const asked = stubBatchResolve([])
    useResolveStore.getState().batchSet([
      { id: 'P1', title: 'One', deleted: false },
      { id: 'P2', title: 'Two', deleted: true },
    ])

    const titles = await resolveTitles(SPACE, ['P1', 'P2'])

    expect([...titles]).toEqual([
      ['P1', 'One'],
      ['P2', 'Two'],
    ])
    expect(asked).toHaveLength(0)
  })

  it('sends one batch_resolve with only the misses', async () => {
    const asked = stubBatchResolve([row('P2', 'Two')])
    useResolveStore.getState().batchSet([{ id: 'P1', title: 'One', deleted: false }])

    const titles = await resolveTitles(SPACE, ['P1', 'P2', 'P1'])

    expect([...titles]).toEqual([
      ['P1', 'One'],
      ['P2', 'Two'],
    ])
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('batch_resolve', { ids: ['P2'], scope: SCOPE })
    expect(asked).toEqual([['P2']])
  })

  it('treats an entry cached under another space, or unresolved, as a miss', async () => {
    const asked = stubBatchResolve([row('P1', 'Here'), row('P2', 'Back')])
    useSpaceStore.setState({ currentSpaceId: 'SPACE_OTHER' })
    useResolveStore.getState().batchSet([{ id: 'P1', title: 'Elsewhere', deleted: false }])
    useSpaceStore.setState({ currentSpaceId: SPACE })
    useResolveStore
      .getState()
      .batchSet([{ id: 'P2', title: '[[P2...]]', deleted: true, resolved: false }])

    const titles = await resolveTitles(SPACE, ['P1', 'P2'])

    expect([...titles]).toEqual([
      ['P1', 'Here'],
      ['P2', 'Back'],
    ])
    expect(asked).toEqual([['P1', 'P2']])
  })

  it('writes fetched rows into the store so the next caller hits', async () => {
    const asked = stubBatchResolve([row('P1', 'One', true), row('P2', '   ')])

    const first = await resolveTitles(SPACE, ['P1', 'P2', 'GONE'])

    expect([...first]).toEqual([
      ['P1', 'One'],
      ['P2', t('block.untitled')],
    ])
    const cache = useResolveStore.getState().cache
    expect(cache.get(keyFor(SPACE, 'P1'))).toEqual({ title: 'One', deleted: true, resolved: true })
    expect(cache.get(keyFor(SPACE, 'P2'))).toEqual({
      title: t('block.untitled'),
      deleted: false,
      resolved: true,
    })
    expect(cache.has(keyFor(SPACE, 'GONE'))).toBe(false)

    await resolveTitles(SPACE, ['P1', 'P2'])
    expect(asked).toEqual([['P1', 'P2', 'GONE']])
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const asked: string[][] = []
    const answers: Array<(rows: ResolvedBlock[]) => void> = []
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        batch_resolve: (args) => {
          asked.push(args['ids'] as string[])
          return new Promise<ResolvedBlock[]>((resolve) => {
            answers.push(resolve)
          })
        },
      }),
    )

    const first = resolveTitles(SPACE, ['P1'])
    const second = resolveTitles(SPACE, ['P1'])
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0))
    for (const answer of answers) answer([row('P1', 'One')])

    expect([...(await first)]).toEqual([['P1', 'One']])
    expect([...(await second)]).toEqual([['P1', 'One']])
    expect(asked).toEqual([['P1']])
  })

  it('does not write rows into the store when the space switched mid-IPC', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        batch_resolve: () => {
          useSpaceStore.setState({ currentSpaceId: 'SPACE_OTHER' })
          return [row('P1', 'One')]
        },
      }),
    )

    const titles = await resolveTitles(SPACE, ['P1'])

    expect([...titles]).toEqual([['P1', 'One']])
    expect(useResolveStore.getState().cache.size).toBe(0)
  })

  it('rejects when batch_resolve fails, and the next call asks again', async () => {
    let calls = 0
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        batch_resolve: () => {
          calls += 1
          if (calls === 1) throw new Error('backend down')
          return [row('P1', 'One')]
        },
      }),
    )

    await expect(resolveTitles(SPACE, ['P1'])).rejects.toThrow('backend down')
    await expect(resolveTitles(SPACE, ['P1'])).resolves.toEqual(new Map([['P1', 'One']]))
    expect(calls).toBe(2)
  })
})
