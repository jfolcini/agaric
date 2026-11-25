/**
 * Tests for <Kbd>, the one shortcut renderer (#1005, #7040): one keycap per
 * alternative, modifier glyphs on macOS and words elsewhere, arrow glyphs
 * everywhere, and the absolute colour tokens that keep it legible on a
 * selected row (#1004).
 */

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Kbd } from '@/components/ui/kbd'
import { __resetPlatformCacheForTests } from '@/lib/platform'

function setPlatform(platform: string): void {
  __resetPlatformCacheForTests()
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

const keycaps = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)

beforeEach(() => {
  setPlatform('Linux x86_64')
})

afterEach(() => {
  __resetPlatformCacheForTests()
})

describe('Kbd', () => {
  it('draws a chord as one keycap, modifiers as words joined by +', () => {
    const { container } = render(<Kbd keys="Ctrl + Shift + F" />)
    expect(keycaps(container)).toEqual(['Ctrl+Shift+F'])
  })

  it('draws arrow keys as glyphs', () => {
    const { container } = render(<Kbd keys="Alt + Shift + Arrow Up" />)
    expect(keycaps(container)).toEqual(['Alt+Shift+↑'])
  })

  it('draws modifiers as glyphs on macOS, with no separator', () => {
    setPlatform('MacIntel')
    const { container } = render(<Kbd keys="Ctrl + Alt + Shift + Arrow Right" />)
    expect(keycaps(container)).toEqual(['⌘⌥⇧→'])
  })

  it('keeps a + key as a token', () => {
    const { container } = render(<Kbd keys="Ctrl + +" />)
    expect(keycaps(container)).toEqual(['Ctrl++'])
  })

  it('draws each alternative as its own keycap, with a / between', () => {
    const { container } = render(<Kbd keys="Ctrl + Y / Ctrl + Shift + Z" />)
    expect(keycaps(container)).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z'])
    expect(container.textContent).toBe('Ctrl+Y/Ctrl+Shift+Z')
  })

  it('draws a repeated alternative without a duplicate-key warning (#1562)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { container } = render(<Kbd keys="Esc / Esc" />)
      expect(keycaps(container)).toEqual(['Esc', 'Esc'])
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('carries its own absolute colour tokens so it contrasts on selected rows (#1004)', () => {
    const { container } = render(<Kbd keys="K" />)
    const kbd = container.querySelector('kbd')
    expect(kbd?.className).toContain('bg-background')
    expect(kbd?.className).toContain('text-foreground')
    expect(kbd?.className).toContain('border-border')
  })

  it('defaults to the compact sm size, and md is the prominent variant', () => {
    const { container: sm } = render(<Kbd keys="A" />)
    expect(sm.querySelector('kbd')?.className).not.toContain('font-semibold')
    const { container: md } = render(<Kbd keys="A / B" size="md" />)
    for (const kbd of md.querySelectorAll('kbd')) expect(kbd.className).toContain('font-semibold')
  })

  it('forwards aria-hidden and className to the outer element', () => {
    const { container } = render(<Kbd keys="Enter" aria-hidden="true" className="ml-1" />)
    const kbd = container.querySelector('kbd')
    expect(kbd?.getAttribute('aria-hidden')).toBe('true')
    expect(kbd?.className).toContain('ml-1')
  })
})
