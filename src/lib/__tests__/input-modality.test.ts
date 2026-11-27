/**
 * `<html data-pointer>` marks a pointer press as the last input until a key
 * press clears it; a bare modifier press, as Ctrl+Click starts with, does not.
 */

import { fireEvent } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { syncPointerAttribute } from '@/lib/input-modality'

const root = document.documentElement

describe('syncPointerAttribute', () => {
  beforeAll(() => syncPointerAttribute())
  beforeEach(() => root.removeAttribute('data-pointer'))

  it('marks a pointer press, and a Ctrl chord clears it', () => {
    fireEvent.pointerDown(document.body)
    expect(root.hasAttribute('data-pointer')).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowDown', ctrlKey: true })
    expect(root.hasAttribute('data-pointer')).toBe(false)
  })

  it('keeps the mark through a bare modifier press', () => {
    fireEvent.pointerDown(document.body)
    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) fireEvent.keyDown(document.body, { key })
    expect(root.hasAttribute('data-pointer')).toBe(true)
  })
})
