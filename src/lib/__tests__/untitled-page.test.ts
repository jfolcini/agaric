/**
 * Tests for the shared "New page" create (#4723).
 *
 * `create_page_in_space` resolves an existing title to that page, so the
 * suffix search is what stops a second Ctrl+N from reopening the Untitled
 * page the user left un-renamed.
 */

import { describe, expect, it, vi } from 'vitest'

const mockedCreate = vi.hoisted(() => vi.fn())
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

import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { createUntitledPage, untitledTitle } from '@/lib/untitled-page'

describe('untitledTitle', () => {
  it('returns "Untitled" when nothing holds it', () => {
    expect(untitledTitle([])).toBe('Untitled')
    expect(untitledTitle(['Groceries', 'Meeting notes'])).toBe('Untitled')
  })

  it('suffixes past the titles already taken', () => {
    expect(untitledTitle(['Untitled'])).toBe('Untitled 2')
    expect(untitledTitle(['Untitled', 'Untitled 2'])).toBe('Untitled 3')
  })

  it('takes the first free name, not the next number', () => {
    expect(untitledTitle(['Untitled 2'])).toBe('Untitled')
  })

  it('ignores null titles', () => {
    expect(untitledTitle([null, null])).toBe('Untitled')
    expect(untitledTitle([null, 'Untitled'])).toBe('Untitled 2')
  })
})

describe('createUntitledPage', () => {
  it('creates the first free title when the space already holds an Untitled page', async () => {
    mockedListPages.mockResolvedValue([{ id: 'P_OLD_0000000000000000000', content: 'Untitled' }])
    mockedCreate.mockResolvedValue('P_NEW_0000000000000000000')

    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      const created = await createUntitledPage('SPACE_TEST')

      expect(created).toEqual({ id: 'P_NEW_0000000000000000000', title: 'Untitled 2' })
      expect(mockedCreate).toHaveBeenCalledWith(null, 'Untitled 2', 'SPACE_TEST')
      expect(changes).toEqual([
        {
          kind: 'added',
          entity: 'page',
          id: 'P_NEW_0000000000000000000',
          name: 'Untitled 2',
          spaceId: 'SPACE_TEST',
        },
      ])
    } finally {
      unsubscribe()
    }
  })

  it('creates "Untitled" in an empty space', async () => {
    mockedListPages.mockResolvedValue([])
    mockedCreate.mockResolvedValue('P_FIRST_000000000000000')

    const created = await createUntitledPage('SPACE_TEST')

    expect(created).toEqual({ id: 'P_FIRST_000000000000000', title: 'Untitled' })
    expect(mockedCreate).toHaveBeenCalledWith(null, 'Untitled', 'SPACE_TEST')
  })

  it('rejects when the create fails, publishing nothing', async () => {
    mockedListPages.mockResolvedValue([])
    mockedCreate.mockRejectedValue(new Error('db down'))

    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      await expect(createUntitledPage('SPACE_TEST')).rejects.toThrow('db down')
      expect(changes).toEqual([])
    } finally {
      unsubscribe()
    }
  })
})
