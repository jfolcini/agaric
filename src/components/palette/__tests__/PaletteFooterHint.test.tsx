/**
 * The palette footer's new-tab chord follows the platform (#6548): the
 * handler accepts Ctrl or ⌘ with Enter, so Linux and Windows read `Ctrl`
 * and macOS reads `⌘`.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PaletteFooterHint } from '@/components/palette/ModeChipRow'
import { t } from '@/lib/i18n'
import { __resetPlatformCacheForTests } from '@/lib/platform'

function setPlatform(value: string): void {
  Object.defineProperty(navigator, 'platform', { value, configurable: true })
  __resetPlatformCacheForTests()
}

/** The chips beside the new-tab label, in order. */
function newTabChips(): string[] {
  const label = screen.getByText(t('palette.footerHintNewTab'))
  return Array.from(label.closest('span')?.querySelectorAll('kbd') ?? []).map(
    (k) => k.textContent ?? '',
  )
}

afterEach(() => {
  setPlatform('Linux x86_64')
})

describe('PaletteFooterHint', () => {
  it.each(['Linux x86_64', 'Win32'])('names Ctrl, with no Mac glyph, on %s', (platform) => {
    setPlatform(platform)
    render(<PaletteFooterHint t={t} />)
    expect(newTabChips()).toEqual(['Ctrl', 'Enter'])
    expect(screen.getByTestId('palette-footer-hint').textContent).not.toMatch(/[⌘⌃⌥⇧]/)
  })

  it('names ⌘ on macOS', () => {
    setPlatform('MacIntel')
    render(<PaletteFooterHint t={t} />)
    expect(newTabChips()).toEqual(['⌘', 'Enter'])
  })

  it('has no a11y violations', async () => {
    const { container } = render(<PaletteFooterHint t={t} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
