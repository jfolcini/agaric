/**
 * Tests for useDialogOrSheet — the Dialog/Sheet swap hook used by
 * ConfirmDialog (kind='alert', default) and the form-style dialogs migrated
 * under (kind='dialog').
 *
 * Validates:
 *  - Desktop+alert returns the AlertDialog set.
 *  - Desktop+dialog returns the Dialog set.
 *  - Mobile (both kinds) returns the Sheet set.
 *  - `kind` discriminant on the returned object matches the input.
 */

import { render, renderHook, screen } from '@testing-library/react'
import { createElement } from 'react'
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
import { type DialogKind, useDialogOrSheet } from '@/hooks/useDialogOrSheet'
import { useIsMobile } from '@/hooks/useIsMobile'

vi.mock('@/hooks/useIsMobile', () => ({
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
    let sharedContent: unknown

    for (const kind of ['alert', 'dialog'] as const) {
      const { result } = renderHook(() => useDialogOrSheet(kind))

      expect(result.current.isMobile).toBe(true)
      expect(result.current.kind).toBe(kind)
      expect(result.current.Root).toBe(Sheet)
      expect(result.current.Content).not.toBe(SheetContent)
      sharedContent ??= result.current.Content
      expect(result.current.Content).toBe(sharedContent)
      expect(result.current.Header).toBe(SheetHeader)
      expect(result.current.Title).toBe(SheetTitle)
      expect(result.current.Description).toBe(SheetDescription)
      expect(result.current.Footer).toBe(SheetFooter)
    }
  })

  it('renders mobile content as a bottom sheet even when a caller requests another side', () => {
    mockedUseIsMobile.mockReturnValue(true)
    const { result } = renderHook(() => useDialogOrSheet('dialog'))
    if (!result.current.isMobile) throw new Error('expected mobile parts')

    const Content = result.current.Content
    render(
      createElement(
        Sheet,
        { open: true },
        createElement(Content, { side: 'right' }, createElement(SheetTitle, null, 'Mobile sheet')),
      ),
    )

    const content = screen.getByRole('dialog')
    expect(content).toHaveClass('bottom-0', 'inset-x-0')
    // One class per expectation: `.not.toHaveClass(a, b)` passes as soon as a
    // single member is absent, so the grouped form would not actually rule out
    // the right-drawer anchor.
    expect(content).not.toHaveClass('right-0')
    expect(content).not.toHaveClass('w-3/4')
    expect(content).not.toHaveClass('sm:max-w-sm')
  })

  it('keeps the mobile Content component identity stable across rerenders and kinds', () => {
    mockedUseIsMobile.mockReturnValue(true)
    const { result, rerender } = renderHook(
      ({ kind }: { kind: DialogKind }) => useDialogOrSheet(kind),
      { initialProps: { kind: 'alert' as DialogKind } },
    )
    const initialContent = result.current.Content

    rerender({ kind: 'dialog' })

    expect(result.current.Content).toBe(initialContent)
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
    expect(
      Object.keys(renderHook(() => useDialogOrSheet('alert')).result.current).toSorted(),
    ).toEqual([...expectedKeys].toSorted())
    expect(
      Object.keys(renderHook(() => useDialogOrSheet('dialog')).result.current).toSorted(),
    ).toEqual([...expectedKeys].toSorted())

    mockedUseIsMobile.mockReturnValue(true)
    expect(
      Object.keys(renderHook(() => useDialogOrSheet('alert')).result.current).toSorted(),
    ).toEqual([...expectedKeys].toSorted())
    expect(
      Object.keys(renderHook(() => useDialogOrSheet('dialog')).result.current).toSorted(),
    ).toEqual([...expectedKeys].toSorted())
  })
})
