/**
 * Tests for useDialogOrSheet — the Dialog/Sheet swap hook used by
 * ConfirmDialog (and any other responsive overlay).
 *
 * Validates:
 *  - Desktop path (`useIsMobile() === false`) returns the AlertDialog set.
 *  - Mobile path (`useIsMobile() === true`) returns the Sheet set.
 *  - The discriminator `isMobile` matches the underlying primitive set.
 *  - Both paths expose the same compatible part shape
 *    (`Root`, `Content`, `Header`, `Title`, `Description`, `Footer`).
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useDialogOrSheet } from '../useDialogOrSheet'
import { useIsMobile } from '../useIsMobile'

vi.mock('../useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedUseIsMobile = vi.mocked(useIsMobile)

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseIsMobile.mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDialogOrSheet', () => {
  it('returns AlertDialog primitives on desktop', () => {
    mockedUseIsMobile.mockReturnValue(false)

    const { result } = renderHook(() => useDialogOrSheet())

    expect(result.current.isMobile).toBe(false)
    expect(result.current.Root).toBe(AlertDialog)
    expect(result.current.Content).toBe(AlertDialogContent)
    expect(result.current.Header).toBe(AlertDialogHeader)
    expect(result.current.Title).toBe(AlertDialogTitle)
    expect(result.current.Description).toBe(AlertDialogDescription)
    expect(result.current.Footer).toBe(AlertDialogFooter)
  })

  it('returns Sheet primitives on mobile', () => {
    mockedUseIsMobile.mockReturnValue(true)

    const { result } = renderHook(() => useDialogOrSheet())

    expect(result.current.isMobile).toBe(true)
    expect(result.current.Root).toBe(Sheet)
    expect(result.current.Content).toBe(SheetContent)
    expect(result.current.Header).toBe(SheetHeader)
    expect(result.current.Title).toBe(SheetTitle)
    expect(result.current.Description).toBe(SheetDescription)
    expect(result.current.Footer).toBe(SheetFooter)
  })

  it('exposes the same part keys on both paths', () => {
    const expectedKeys = ['isMobile', 'Root', 'Content', 'Header', 'Title', 'Description', 'Footer']

    mockedUseIsMobile.mockReturnValue(false)
    const desktop = renderHook(() => useDialogOrSheet()).result.current
    expect(Object.keys(desktop).sort()).toEqual([...expectedKeys].sort())

    mockedUseIsMobile.mockReturnValue(true)
    const mobile = renderHook(() => useDialogOrSheet()).result.current
    expect(Object.keys(mobile).sort()).toEqual([...expectedKeys].sort())
  })
})
