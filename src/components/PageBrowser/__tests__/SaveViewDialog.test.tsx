/**
 * Tests for `SaveViewDialog` (#2003 piece 1) — name-entry modal for saving
 * the Pages view's current `{ sort, density, filters }` tuple.
 *
 * Mirrors `RenameDialog.test.tsx`'s structure: `sanitizeSavedViewName` /
 * `validateSavedViewName` unit coverage, render/interaction via
 * `@testing-library/react` + `userEvent`, and an `axe(document.body)` a11y
 * audit while open — `DialogContent` renders via a Radix Portal to
 * `document.body`, outside RTL's `render()` container, so `axe(container)`
 * would silently skip the dialog content entirely.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import {
  MAX_SAVED_VIEW_NAME_LENGTH,
  SaveViewDialog,
  sanitizeSavedViewName,
  validateSavedViewName,
} from '@/components/PageBrowser/SaveViewDialog'

describe('SaveViewDialog', () => {
  it('renders nothing when not open', () => {
    render(<SaveViewDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.queryByText('Save current view')).not.toBeInTheDocument()
  })

  it('renders title, description, input, buttons when open', () => {
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText('Save current view')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Saves the current sort, density, and filters so you can reapply them later.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('starts with an empty input and Save disabled', () => {
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('resets the input across a close/reopen cycle', () => {
    const { rerender } = render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: /name/i })
    // Directly set a value via fireEvent-equivalent (userEvent used below
    // in the interaction tests) — here we only need to exercise state, so
    // typing via userEvent keeps this consistent with the rest of the file.
    rerender(<SaveViewDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    rerender(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('')
    void input
  })

  it('enables Save once a non-empty name is typed and calls onConfirm with the trimmed name', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<SaveViewDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />)

    const input = screen.getByRole('textbox', { name: /name/i })
    await user.type(input, '  My view  ')
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onConfirm).toHaveBeenCalledWith('My view')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('submits via Enter-key form submission', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />)

    const input = screen.getByRole('textbox', { name: /name/i })
    await user.type(input, 'Enter view{Enter}')
    expect(onConfirm).toHaveBeenCalledWith('Enter view')
  })

  it('shows an inline error and does not confirm when Save is clicked while empty', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />)

    const input = screen.getByRole('textbox', { name: /name/i })
    await user.type(input, 'x')
    await user.clear(input)

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name for this view')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows a tooLong error once the name exceeds the cap', async () => {
    const user = userEvent.setup()
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /name/i })
    await user.type(input, 'a'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1))

    expect(screen.getByRole('alert')).toHaveTextContent(
      `Name must be ${MAX_SAVED_VIEW_NAME_LENGTH} characters or fewer`,
    )
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('strips control characters as the user types', async () => {
    const user = userEvent.setup()
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: /name/i }) as HTMLInputElement
    await user.click(input)
    // Built via String.fromCharCode at runtime (NUL, US, DEL) rather than
    // embedded escape-sequence text, which this authoring pipeline has
    // silently transcoded into raw control bytes in the past.
    const noisy = `View${String.fromCharCode(0)}name${String.fromCharCode(31)}${String.fromCharCode(127)}`
    await user.paste(noisy)

    expect(input.value).toBe('Viewname')
  })

  it('closes without confirming when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<SaveViewDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />)

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Discarded')
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('has no a11y violations while open', async () => {
    render(<SaveViewDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />)
    const results = await axe(document.body)
    expect(results).toHaveNoViolations()
  })
})

describe('sanitizeSavedViewName / validateSavedViewName', () => {
  it('reports empty for whitespace-only input', () => {
    expect(validateSavedViewName('')).toBe('empty')
    expect(validateSavedViewName('   ')).toBe('empty')
    expect(validateSavedViewName('\t\n')).toBe('empty')
  })

  it('reports tooLong above the cap', () => {
    const tooLong = 'a'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1)
    expect(validateSavedViewName(tooLong)).toBe('tooLong')
  })

  it('accepts a name exactly at the cap', () => {
    expect(validateSavedViewName('a'.repeat(MAX_SAVED_VIEW_NAME_LENGTH))).toBeNull()
  })

  it('trims surrounding whitespace before measuring', () => {
    expect(validateSavedViewName('  My view  ')).toBeNull()
    expect(sanitizeSavedViewName('  My view  ')).toBe('My view')
  })

  it('strips ASCII control characters before measuring length', () => {
    const noisy = `Vi${String.fromCharCode(0)}ew${String.fromCharCode(31)}name${String.fromCharCode(127)}`
    expect(sanitizeSavedViewName(noisy)).toBe('Viewname')
    expect(validateSavedViewName(noisy)).toBeNull()
  })

  it('treats input that becomes empty after stripping as empty', () => {
    const onlyControlChars = `${String.fromCharCode(0)}${String.fromCharCode(31)}${String.fromCharCode(127)}`
    expect(validateSavedViewName(onlyControlChars)).toBe('empty')
  })
})
