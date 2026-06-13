/**
 * Tests for the canonical <Kbd> / <KbdChord> primitives (#1005 / #1004).
 *
 * Validates:
 *  - <Kbd> renders a single key chip with the absolute-token chrome that
 *    keeps it legible on a selected row (`bg-background text-foreground
 *    border-border`, #1004).
 *  - size="sm" vs size="md" produce the compact / prominent variants.
 *  - aria-hidden is opt-in (not blanket-applied), so standalone help chips
 *    stay readable to assistive tech while interactive-row chips can be
 *    hidden by the caller (#1005).
 *  - <KbdChord> splits `+` combos and `/` alternatives, and substitutes the
 *    platform mod key for a literal `Ctrl`.
 */

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __resetPlatformCacheForTests } from '../../../lib/platform'
import { Kbd, KbdChord } from '../kbd'

beforeEach(() => {
  __resetPlatformCacheForTests()
  // Force non-Mac so `Ctrl` stays the literal `Ctrl` token by default.
  Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
})

afterEach(() => {
  __resetPlatformCacheForTests()
})

describe('Kbd', () => {
  it('renders a single key as one <kbd>', () => {
    const { container } = render(<Kbd>Esc</Kbd>)
    const kbds = container.querySelectorAll('kbd')
    expect(kbds).toHaveLength(1)
    expect(kbds[0]?.textContent).toBe('Esc')
  })

  it('carries its own absolute colour tokens so it contrasts on selected rows (#1004)', () => {
    const { container } = render(<Kbd>K</Kbd>)
    const kbd = container.querySelector('kbd')
    expect(kbd?.className).toContain('bg-background')
    expect(kbd?.className).toContain('text-foreground')
    expect(kbd?.className).toContain('border-border')
    expect(kbd?.className).toContain('rounded')
    expect(kbd?.className).toContain('font-mono')
    // The old row-relative muted fill must be gone.
    expect(kbd?.className).not.toContain('bg-muted')
  })

  it('defaults to the compact sm size', () => {
    const { container } = render(<Kbd>A</Kbd>)
    expect(container.querySelector('kbd')?.className).toContain('text-[11px]')
  })

  it('size="md" renders the prominent settings variant', () => {
    const { container } = render(<Kbd size="md">A</Kbd>)
    const kbd = container.querySelector('kbd')
    expect(kbd?.className).toContain('text-xs')
    expect(kbd?.className).toContain('font-semibold')
    expect(kbd?.className).toContain('shadow-sm')
  })

  it('does not apply aria-hidden by default (standalone help chips stay readable)', () => {
    const { container } = render(<Kbd>?</Kbd>)
    expect(container.querySelector('kbd')?.getAttribute('aria-hidden')).toBeNull()
  })

  it('forwards aria-hidden when the caller marks the chip decorative', () => {
    const { container } = render(<Kbd aria-hidden="true">↵</Kbd>)
    expect(container.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('merges caller className', () => {
    const { container } = render(<Kbd className="ml-1">↵</Kbd>)
    expect(container.querySelector('kbd')?.className).toContain('ml-1')
  })
})

describe('KbdChord', () => {
  it('renders a single key as one chip', () => {
    const { container } = render(<KbdChord keys="Tab" />)
    const kbds = container.querySelectorAll('kbd')
    expect(kbds).toHaveLength(1)
    expect(kbds[0]?.textContent).toBe('Tab')
  })

  it('splits a `+` combo into multiple chips joined by `+`', () => {
    const { container } = render(<KbdChord keys="Ctrl + S" />)
    const kbds = Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)
    expect(kbds).toEqual(['Ctrl', 'S'])
    expect(container.textContent).toContain('+')
  })

  it('splits `/` alternatives joined by a `/` separator', () => {
    const { container } = render(<KbdChord keys="Cmd / Ctrl" />)
    const kbds = Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)
    expect(kbds).toEqual(['Cmd', 'Ctrl'])
    expect(container.textContent).toContain('/')
  })

  it('handles combined alternatives like `Ctrl + Z / Ctrl + Shift + Z`', () => {
    const { container } = render(<KbdChord keys="Ctrl + Z / Ctrl + Shift + Z" />)
    const kbds = Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)
    expect(kbds).toEqual(['Ctrl', 'Z', 'Ctrl', 'Shift', 'Z'])
  })

  it('substitutes `Ctrl` with the ⌘ glyph on macOS', () => {
    __resetPlatformCacheForTests()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    const { container } = render(<KbdChord keys="Ctrl + K" />)
    const kbds = Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)
    expect(kbds).toEqual(['⌘', 'K'])
  })

  it('propagates the size variant to its chips', () => {
    const { container } = render(<KbdChord keys="Ctrl + K" size="md" />)
    for (const kbd of container.querySelectorAll('kbd')) {
      expect(kbd.className).toContain('font-semibold')
    }
  })
})
