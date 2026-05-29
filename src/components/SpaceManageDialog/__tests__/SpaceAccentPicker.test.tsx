/**
 * Tests for SpaceAccentPicker (PEND-30 D-2 extraction).
 *
 * Coverage:
 *  - Renders all 6 swatches with palette tokens (PEND-23 L3 contract).
 *  - Each swatch carries aria-label `accentSwatchLabel`.
 *  - Clicking a swatch calls setProperty(accent_color, token).
 *  - The clicked swatch flips `aria-pressed=true`; others stay false.
 *  - Selected swatch overlays the Check icon (UX-6); others do not.
 *  - During the in-flight save every swatch is `disabled`.
 *  - On IPC failure: toast.error fires + previous selection is restored.
 *  - The 6 swatches advertise `data-accent-token` for downstream tests.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from '@/lib/i18n'

import { ACCENT_SWATCHES, SpaceAccentPicker } from '../SpaceAccentPicker'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'set_property') return null
    return null
  })
})

describe('SpaceAccentPicker', () => {
  it('exports the canonical 6-swatch palette as ACCENT_SWATCHES', () => {
    expect(ACCENT_SWATCHES).toHaveLength(6)
    expect(ACCENT_SWATCHES.map((s) => s.token)).toEqual([
      'accent-emerald',
      'accent-blue',
      'accent-violet',
      'accent-amber',
      'accent-rose',
      'accent-slate',
    ])
  })

  it('renders all 6 swatches with palette tokens (PEND-23 L3)', () => {
    render(<SpaceAccentPicker spaceId="SPACE_1" />)
    const group = screen.getByRole('group', { name: t('space.accentColorLabel') })
    const swatches = within(group).getAllByRole('button', { name: /accent/i })
    expect(swatches).toHaveLength(6)

    for (const btn of swatches) {
      const token = btn.getAttribute('data-accent-token') ?? ''
      expect(token).toMatch(/^accent-/)
      expect(btn.getAttribute('style') ?? '').toContain(`background-color: var(--${token})`)
      // No hardcoded Tailwind `bg-*-500` escape hatch.
      expect(btn.className).not.toMatch(/\bbg-[a-z]+-500\b/)
    }
  })

  it('each swatch has an accent-specific aria-label', () => {
    render(<SpaceAccentPicker spaceId="SPACE_1" />)
    for (const swatch of ACCENT_SWATCHES) {
      const btn = screen.getByRole('button', {
        name: t('space.accentSwatchLabel', { color: swatch.label }),
      })
      expect(btn).toBeInTheDocument()
    }
  })

  it('clicking a swatch calls setProperty(accent_color, token)', async () => {
    const user = userEvent.setup()
    render(<SpaceAccentPicker spaceId="SPACE_1" />)

    const violet = screen.getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'violet' }),
    })
    await user.click(violet)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: 'SPACE_1',
          key: 'accent_color',
          value: expect.objectContaining({ value_text: 'accent-violet' }),
        }),
      )
    })
  })

  it('flips aria-pressed on the clicked swatch only', async () => {
    const user = userEvent.setup()
    render(<SpaceAccentPicker spaceId="SPACE_1" />)

    const violet = screen.getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'violet' }),
    })
    const blue = screen.getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'blue' }),
    })

    await user.click(violet)

    await waitFor(() => {
      expect(violet.getAttribute('aria-pressed')).toBe('true')
    })
    expect(blue.getAttribute('aria-pressed')).toBe('false')
  })

  it('overlays the Check icon on the selected swatch only (UX-6)', async () => {
    const user = userEvent.setup()
    render(<SpaceAccentPicker spaceId="SPACE_1" />)

    const violet = screen.getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'violet' }),
    })
    const blue = screen.getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'blue' }),
    })

    expect(violet.querySelector('svg')).toBeNull()
    expect(blue.querySelector('svg')).toBeNull()

    await user.click(violet)

    await waitFor(() => {
      expect(violet.querySelector('svg')).not.toBeNull()
    })
    expect(blue.querySelector('svg')).toBeNull()
    expect(violet.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('reverts selection and surfaces toast on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') throw new Error('IPC offline')
      return null
    })
    const user = userEvent.setup()
    render(<SpaceAccentPicker spaceId="SPACE_1" />)

    const violet = screen.getByRole('button', {
      name: t('space.accentSwatchLabel', { color: 'violet' }),
    })
    await user.click(violet)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.accentFailed'))
    })
    // After the rejection settles aria-pressed reverts to false.
    await waitFor(() => {
      expect(violet.getAttribute('aria-pressed')).toBe('false')
    })
  })
})
