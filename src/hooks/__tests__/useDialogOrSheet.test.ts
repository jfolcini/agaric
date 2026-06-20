/**
 * Tests for useDialogOrSheet — the Dialog/Sheet swap hook used by
 * ConfirmDialog (kind='alert', default) and the 6 form-style dialogs
 * Migrated under (kind='dialog').
 *
 * Validates:
 *  - Desktop+alert returns the AlertDialog set.
 *  - Desktop+dialog returns the Dialog set.
 *  - Mobile (both kinds) returns the Sheet set.
 *  - `kind` discriminant on the returned object matches the input.
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  it('returns AlertDialog primitives on desktop with the default kind', () => {
    mockedUseIsMobile.mockReturnValue(false)

    const { result } = renderHook(() => useDialogOrSheet())

    expect(result.current.isMobile).toBe(false)
    expect(result.current.kind).toBe('alert')
    expect(result.current.Root).toBe(AlertDialog)
    expect(result.current.Content).toBe(AlertDialogContent)
    expect(result.current.Header).toBe(AlertDialogHeader)
    expect(result.current.Title).toBe(AlertDialogTitle)
    expect(result.current.Description).toBe(AlertDialogDescription)
    expect(result.current.Footer).toBe(AlertDialogFooter)
  })

  it('returns AlertDialog primitives on desktop when kind="alert"', () => {
    mockedUseIsMobile.mockReturnValue(false)

    const { result } = renderHook(() => useDialogOrSheet('alert'))

    expect(result.current.kind).toBe('alert')
    expect(result.current.Root).toBe(AlertDialog)
  })

  it('returns Dialog primitives on desktop when kind="dialog"', () => {
    mockedUseIsMobile.mockReturnValue(false)

    const { result } = renderHook(() => useDialogOrSheet('dialog'))

    expect(result.current.isMobile).toBe(false)
    expect(result.current.kind).toBe('dialog')
    expect(result.current.Root).toBe(Dialog)
    expect(result.current.Content).toBe(DialogContent)
    expect(result.current.Header).toBe(DialogHeader)
    expect(result.current.Title).toBe(DialogTitle)
    expect(result.current.Description).toBe(DialogDescription)
    expect(result.current.Footer).toBe(DialogFooter)
  })

  it('returns Sheet primitives on mobile regardless of kind', () => {
    mockedUseIsMobile.mockReturnValue(true)

    for (const kind of ['alert', 'dialog'] as const) {
      const { result } = renderHook(() => useDialogOrSheet(kind))

      expect(result.current.isMobile).toBe(true)
      expect(result.current.kind).toBe(kind)
      expect(result.current.Root).toBe(Sheet)
      expect(result.current.Content).toBe(SheetContent)
      expect(result.current.Header).toBe(SheetHeader)
      expect(result.current.Title).toBe(SheetTitle)
      expect(result.current.Description).toBe(SheetDescription)
      expect(result.current.Footer).toBe(SheetFooter)
    }
  })

  it('exposes the same part keys on every path', () => {
    const expectedKeys = [
      'isMobile',
      'kind',
      'Root',
      'Content',
      'Header',
      'Title',
      'Description',
      'Footer',
    ]

    mockedUseIsMobile.mockReturnValue(false)
    expect(Object.keys(renderHook(() => useDialogOrSheet('alert')).result.current).sort()).toEqual(
      [...expectedKeys].sort(),
    )
    expect(Object.keys(renderHook(() => useDialogOrSheet('dialog')).result.current).sort()).toEqual(
      [...expectedKeys].sort(),
    )

    mockedUseIsMobile.mockReturnValue(true)
    expect(Object.keys(renderHook(() => useDialogOrSheet('alert')).result.current).sort()).toEqual(
      [...expectedKeys].sort(),
    )
    expect(Object.keys(renderHook(() => useDialogOrSheet('dialog')).result.current).sort()).toEqual(
      [...expectedKeys].sort(),
    )
  })
})
