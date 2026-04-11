/**
 * Tests for useRichContentCallbacks hook.
 *
 * Validates:
 * - resolveBlockTitle returns cached title or undefined fallback
 * - resolveBlockStatus returns 'active' or 'deleted'
 * - resolveTagName returns cached title or undefined fallback
 * - resolveTagStatus returns 'active' or 'deleted'
 * - Callbacks re-render when store version bumps
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useResolveStore } from '../../stores/resolve'
import { useRichContentCallbacks } from '../useRichContentCallbacks'

beforeEach(() => {
  useResolveStore.setState({
    cache: new Map(),
    pagesList: [],
    version: 0,
    _preloaded: false,
  })
})

// ── resolveBlockTitle ──────────────────────────────────────────────────

describe('resolveBlockTitle', () => {
  it('returns cached title when the block is in the store', () => {
    useResolveStore.getState().set('BLOCK_A', 'My Page', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('BLOCK_A')).toBe('My Page')
  })

  it('returns undefined for uncached blocks', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('MISSING')).toBeUndefined()
  })

  it('picks up new entries after store update', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('BLOCK_B')).toBeUndefined()

    act(() => {
      useResolveStore.getState().set('BLOCK_B', 'Updated Title', false)
    })

    expect(result.current.resolveBlockTitle('BLOCK_B')).toBe('Updated Title')
  })
})

// ── resolveBlockStatus ─────────────────────────────────────────────────

describe('resolveBlockStatus', () => {
  it('returns "active" for non-deleted blocks', () => {
    useResolveStore.getState().set('BLOCK_A', 'Active Page', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockStatus('BLOCK_A')).toBe('active')
  })

  it('returns "deleted" for deleted blocks', () => {
    useResolveStore.getState().set('BLOCK_D', 'Deleted Page', true)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockStatus('BLOCK_D')).toBe('deleted')
  })

  it('returns "active" for uncached blocks', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockStatus('MISSING')).toBe('active')
  })
})

// ── resolveTagName ─────────────────────────────────────────────────────

describe('resolveTagName', () => {
  it('returns cached tag name', () => {
    useResolveStore.getState().set('TAG_A', 'project', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagName('TAG_A')).toBe('project')
  })

  it('returns undefined for uncached tags', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagName('MISSING')).toBeUndefined()
  })
})

// ── resolveTagStatus ───────────────────────────────────────────────────

describe('resolveTagStatus', () => {
  it('returns "active" for non-deleted tags', () => {
    useResolveStore.getState().set('TAG_A', 'active-tag', false)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagStatus('TAG_A')).toBe('active')
  })

  it('returns "deleted" for deleted tags', () => {
    useResolveStore.getState().set('TAG_D', 'deleted-tag', true)

    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagStatus('TAG_D')).toBe('deleted')
  })

  it('returns "active" for uncached tags', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveTagStatus('MISSING')).toBe('active')
  })
})

// ── Reactivity ─────────────────────────────────────────────────────────

describe('reactivity', () => {
  it('re-renders when store version changes via batchSet', () => {
    const { result } = renderHook(() => useRichContentCallbacks())
    expect(result.current.resolveBlockTitle('B1')).toBeUndefined()
    expect(result.current.resolveTagName('T1')).toBeUndefined()

    act(() => {
      useResolveStore.getState().batchSet([
        { id: 'B1', title: 'Page One', deleted: false },
        { id: 'T1', title: 'tag-one', deleted: false },
      ])
    })

    expect(result.current.resolveBlockTitle('B1')).toBe('Page One')
    expect(result.current.resolveTagName('T1')).toBe('tag-one')
  })
})
