/**
 * Tests for usePageCreation — the New page dialog's create handler. Covers
 * the created / existing-title / blank-name results, the name-change-bus
 * publish, the in-flight guard, and the error mapping the dialog shows.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePageCreation } from '@/hooks/usePageCreation'
import { useSpaceStore } from '@/stores/space'

// `usePageCreation` calls `commands.createPageInSpace` from `@/lib/bindings`
// directly. The spy sees the real wire arguments `(parentId, content,
// spaceId)`; the shim wraps a fulfilment in the `{ status: 'ok', data }`
// envelope `unwrap` expects.
const mockedCreate = vi.hoisted(() => vi.fn())
// #4723 — the create path asks the space for its full page list first, so an
// existing title never reaches `createPageInSpace`.
const mockedListPages = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      createPageInSpace: (...args: unknown[]) =>
        mockedCreate(...args).then((data: unknown) => ({ status: 'ok', data })),
      listAllPagesInSpace: (...args: unknown[]) =>
        mockedListPages(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

import { isConflict } from '@/lib/app-error'
import { t } from '@/lib/i18n'
import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'

beforeEach(() => {
  vi.clearAllMocks()
  mockedListPages.mockResolvedValue([])
  useSpaceStore.setState({ currentSpaceId: 'SPACE_A', isReady: true })
})

async function create(name: string) {
  const { result } = renderHook(() => usePageCreation())
  let created: Awaited<ReturnType<typeof result.current.createPage>> = null
  await act(async () => {
    created = await result.current.createPage(name)
  })
  return { result, created }
}

describe('usePageCreation', () => {
  it('creates the page in the active space and returns it', async () => {
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000000')

    const { result, created } = await create('  My Page  ')

    expect(mockedCreate).toHaveBeenCalledWith(null, 'My Page', 'SPACE_A')
    expect(created).toEqual({ id: 'NEW_ID_0000000000000000000', title: 'My Page' })
    expect(result.current.createError).toBeNull()
    expect(result.current.isCreating).toBe(false)
  })

  // #4723 — an existing title resolves to that page on the backend, so the
  // create is skipped and the existing page is returned for the caller to open.
  it('returns the existing page and never calls create when the title already exists', async () => {
    mockedListPages.mockResolvedValue([{ id: 'OLD', content: 'My Page' }])

    const { created } = await create('My Page')

    expect(mockedCreate).not.toHaveBeenCalled()
    expect(created).toEqual({ id: 'OLD', title: 'My Page' })
  })

  // #4338 — the bus is the dialog's only route to a warm `[[` picker cache.
  it("publishes an 'added' event so the picker cache learns the new page", async () => {
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000009')
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      await create('Quarterly Review')
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      {
        kind: 'added',
        entity: 'page',
        id: 'NEW_ID_0000000000000000009',
        name: 'Quarterly Review',
        spaceId: 'SPACE_A',
      },
    ])
  })

  it('publishes nothing and reports the error when the create IPC rejects', async () => {
    mockedCreate.mockRejectedValue(new Error('Disk full'))
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    let outcome: Awaited<ReturnType<typeof create>>
    try {
      outcome = await create('Doomed')
    } finally {
      unsubscribe()
    }

    // A cache told about a page that does not exist would offer a `[[` link
    // resolving to nothing.
    expect(changes).toEqual([])
    expect(outcome.created).toBeNull()
    expect(outcome.result.current.createError).toBe(
      t('pageBrowser.createFailed', { error: 'Error: Disk full' }),
    )
  })

  // #4782 — a blank name means "New page": the first free `Untitled N`, since
  // `create_page_in_space` RESOLVES a literal 'Untitled' to the one already there.
  it('names a blank create Untitled, suffixed past an existing Untitled page', async () => {
    mockedListPages.mockResolvedValue([{ id: 'OLD', content: 'Untitled' }])
    mockedCreate.mockResolvedValue('NEW_ID_0000000000000000003')

    const { created } = await create('   ')

    expect(mockedCreate).toHaveBeenCalledWith(null, 'Untitled 2', 'SPACE_A')
    expect(created).toEqual({ id: 'NEW_ID_0000000000000000003', title: 'Untitled 2' })
  })

  it('refuses a not-yet-ready space without calling the IPC', async () => {
    useSpaceStore.setState({ currentSpaceId: null })

    const { result, created } = await create('Anything')

    expect(mockedListPages).not.toHaveBeenCalled()
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(created).toBeNull()
    expect(result.current.createError).toBe(t('pageBrowser.spaceNotReady'))
  })

  it('maps a conflict to the duplicate-name message', async () => {
    const conflict = { kind: 'conflict', message: 'dup' }
    expect(isConflict(conflict)).toBe(true)
    mockedCreate.mockRejectedValue(conflict)

    const { result, created } = await create('Taken')

    expect(created).toBeNull()
    expect(result.current.createError).toBe(t('pageBrowser.duplicateName'))
  })

  it('ignores a second create while the first is in flight', async () => {
    let resolveCreate: (id: string) => void = () => {}
    mockedCreate.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCreate = resolve
      }),
    )
    const { result } = renderHook(() => usePageCreation())

    let first: Promise<unknown> = Promise.resolve()
    let second: unknown
    await act(async () => {
      first = result.current.createPage('Once')
      second = await result.current.createPage('Once')
    })
    await act(async () => {
      resolveCreate('NEW_ID_0000000000000000004')
      await first
    })

    expect(second).toBeNull()
    expect(mockedCreate).toHaveBeenCalledTimes(1)
  })
})
