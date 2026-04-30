/**
 * Tests for renderKeys utility.
 *
 * Validates:
 *  - Single key renders as a single <kbd>
 *  - `+` combos render as kbd + "+" + kbd
 *  - `/` alternatives render as kbd "/" kbd
 *  - `Ctrl` is substituted with the platform mod key (Ctrl on non-Mac)
 *  - All produced kbd elements share the same className
 */

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetPlatformCacheForTests } from '../platform'
import { renderKeys } from '../render-keyboard-shortcut'

beforeEach(() => {
  __resetPlatformCacheForTests()
  // Force non-Mac so `Ctrl` stays as the literal `Ctrl` token.
  Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
})

afterEach(() => {
  __resetPlatformCacheForTests()
})

describe('renderKeys', () => {
  it('renders a single key as a single <kbd>', () => {
    const { container } = render(renderKeys('Tab'))
    const kbds = container.querySelectorAll('kbd')
    expect(kbds).toHaveLength(1)
    expect(kbds[0]?.textContent).toBe('Tab')
  })

  it('renders `Ctrl + S` as two kbds joined by a `+` separator', () => {
    const { container } = render(renderKeys('Ctrl + S'))
    const kbds = container.querySelectorAll('kbd')
    expect(kbds).toHaveLength(2)
    expect(kbds[0]?.textContent).toBe('Ctrl')
    expect(kbds[1]?.textContent).toBe('S')
    // Separator should appear between the two kbds
    expect(container.textContent).toContain('+')
  })

  it('renders alternative shortcuts joined by a `/` separator', () => {
    const { container } = render(renderKeys('Cmd / Ctrl'))
    const kbds = container.querySelectorAll('kbd')
    expect(kbds).toHaveLength(2)
    expect(kbds[0]?.textContent).toBe('Cmd')
    expect(kbds[1]?.textContent).toBe('Ctrl')
    expect(container.textContent).toContain('/')
  })

  it('renders combined alternatives like `Ctrl + Z / Ctrl + Shift + Z`', () => {
    const { container } = render(renderKeys('Ctrl + Z / Ctrl + Shift + Z'))
    const kbds = Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)
    expect(kbds).toEqual(['Ctrl', 'Z', 'Ctrl', 'Shift', 'Z'])
  })

  it('substitutes `Ctrl` with `\u2318` (Cmd) on macOS', () => {
    __resetPlatformCacheForTests()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    const { container } = render(renderKeys('Ctrl + K'))
    const kbds = Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)
    expect(kbds).toEqual(['\u2318', 'K'])
  })

  it('produces kbd elements with the canonical Tailwind classes', () => {
    const { container } = render(renderKeys('Esc'))
    const kbd = container.querySelector('kbd')
    expect(kbd?.className).toContain('rounded')
    expect(kbd?.className).toContain('border-border')
    expect(kbd?.className).toContain('bg-muted')
    expect(kbd?.className).toContain('font-mono')
  })
})
