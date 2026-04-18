/**
 * Tests for LinkEditPopover component and normalizeUrl utility.
 *
 * Validates:
 *  - normalizeUrl: prepends https:// when no protocol, preserves http/ftp/mailto/tel
 *  - Renders URL input with autoFocus
 *  - Apply button calls editor.setLink with normalized URL
 *  - Remove button calls editor.unsetLink (only when isEditing)
 *  - Enter key in input applies the link
 *  - Escape key closes the popover and refocuses editor
 *  - Empty/whitespace URL does not call setLink
 *  - a11y: axe audit
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { LinkEditPopover, normalizeUrl } from '../LinkEditPopover'

// ── Mock UI components ───────────────────────────────────────────────────
// Input and Button render real <input> / <button> elements, but we mock them
// to avoid any Radix/CSS dependencies while preserving behaviour.

vi.mock('../ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('../ui/button', () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button {...props} />
  ),
}))

vi.mock('../ui/label', () => ({
  Label: ({
    size: _size,
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement> & { size?: string }) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is passed via ...props from the real component
    <label {...props}>{children}</label>
  ),
}))

// Mock Tauri IPC functions used for link metadata prefetch (UX-165)
const mockFetchLinkMetadata = vi.fn().mockResolvedValue({})

vi.mock('@/lib/tauri', () => ({
  fetchLinkMetadata: (...args: unknown[]) => mockFetchLinkMetadata(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

// ── Editor mock helpers ──────────────────────────────────────────────────

const mockRun = vi.fn()
const mockSetLink = vi.fn(() => ({ run: mockRun }))
const mockInsertContent = vi.fn(() => ({ run: mockRun }))
const mockUnsetLink = vi.fn(() => ({ run: mockRun }))
const mockSetTextSelection = vi.fn(() => ({
  setLink: mockSetLink,
  insertContent: mockInsertContent,
}))
const mockFocus = vi.fn(() => ({
  setLink: mockSetLink,
  unsetLink: mockUnsetLink,
  setTextSelection: mockSetTextSelection,
  insertContent: mockInsertContent,
}))
const mockChain = vi.fn(() => ({ focus: mockFocus }))
const mockCommandsFocus = vi.fn()
const mockRemoveStoredMark = vi.fn().mockReturnThis()
const mockTr = { removeStoredMark: mockRemoveStoredMark }
const mockDispatch = vi.fn()
const mockLinkMarkType = { name: 'link' }

function makeEditor() {
  return {
    chain: mockChain,
    commands: { focus: mockCommandsFocus },
    schema: { marks: { link: mockLinkMarkType } },
    state: { tr: mockTr },
    view: { dispatch: mockDispatch },
  } as never
}

// ── normalizeUrl ─────────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeUrl('')).toBe('')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeUrl('   ')).toBe('')
    expect(normalizeUrl('\t\n')).toBe('')
  })

  it('prepends https:// when no protocol is present', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com')
  })

  it('preserves https:// URLs', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })

  it('preserves http:// URLs', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
  })

  it('preserves ftp:// URLs', () => {
    expect(normalizeUrl('ftp://files.example.com/readme.txt')).toBe(
      'ftp://files.example.com/readme.txt',
    )
  })

  it('preserves mailto: URLs (no authority component)', () => {
    expect(normalizeUrl('mailto:user@example.com')).toBe('mailto:user@example.com')
  })

  it('preserves tel: URLs (no authority component)', () => {
    expect(normalizeUrl('tel:+1234567890')).toBe('tel:+1234567890')
  })

  it('is case-insensitive for mailto/tel schemes', () => {
    expect(normalizeUrl('MAILTO:user@example.com')).toBe('MAILTO:user@example.com')
    expect(normalizeUrl('Tel:+1234567890')).toBe('Tel:+1234567890')
  })

  it('preserves custom scheme:// protocols', () => {
    expect(normalizeUrl('custom-app://open')).toBe('custom-app://open')
  })

  it('blocks javascript: URLs', () => {
    expect(normalizeUrl('javascript:alert("xss")')).toBe('')
  })

  it('blocks JavaScript: URLs (case-insensitive)', () => {
    expect(normalizeUrl('JavaScript:alert("xss")')).toBe('')
    expect(normalizeUrl('JAVASCRIPT:void(0)')).toBe('')
  })

  it('blocks data: URLs', () => {
    expect(normalizeUrl('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(normalizeUrl('DATA:text/html,test')).toBe('')
  })
})

// ── LinkEditPopover component ────────────────────────────────────────────

describe('LinkEditPopover', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Rendering ──────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the popover container with data-testid', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(screen.getByTestId('link-edit-popover')).toBeInTheDocument()
    })

    it('renders URL input with autoFocus', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      const input = screen.getByTestId('link-url-input')
      expect(input).toBeInTheDocument()
      expect(input).toHaveAttribute('type', 'url')
      expect(input).toHaveAttribute('placeholder', t('linkEdit.urlPlaceholder'))
      // autoFocus is set in the JSX
      expect(input).toHaveFocus()
    })

    it('renders Apply button when creating new link', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    })

    it('renders Update button when editing existing link', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://example.com"
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
    })

    it('does NOT render Remove button when not editing', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    })

    it('renders Remove button when editing an existing link', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://example.com"
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    })

    it('pre-fills input with initialUrl when editing', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://example.com"
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(screen.getByTestId('link-url-input')).toHaveValue('https://example.com')
    })
  })

  // ── Apply action ───────────────────────────────────────────────────────

  describe('apply', () => {
    it('calls editor.insertContent with normalized URL on Apply click', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://example.com',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
      expect(mockRun).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('applies link on Enter key in input', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://example.com',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
      expect(onClose).toHaveBeenCalled()
    })

    it('does NOT call setLink when URL is empty', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockSetLink).not.toHaveBeenCalled()
      expect(mockCommandsFocus).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('does NOT call setLink when URL is whitespace-only', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockSetLink).not.toHaveBeenCalled()
      expect(mockCommandsFocus).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('Apply button prevents pointerdown default (preserves editor focus)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const applyBtn = screen.getByRole('button', { name: 'Apply' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const preventSpy = vi.spyOn(event, 'preventDefault')
      fireEvent(applyBtn, event)

      expect(preventSpy).toHaveBeenCalled()
    })

    it('triggers metadata prefetch after applying link (UX-165)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockFetchLinkMetadata).toHaveBeenCalledWith('https://example.com')
    })

    it('removes stored link mark after applying link (UX-177)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockRemoveStoredMark).toHaveBeenCalledWith(mockLinkMarkType)
      expect(mockDispatch).toHaveBeenCalledWith(mockTr)
    })
  })

  // ── Remove action ──────────────────────────────────────────────────────

  describe('remove', () => {
    it('calls editor.unsetLink on Remove click', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://example.com"
          initialLabel=""
          onClose={onClose}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockUnsetLink).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('Remove button prevents pointerdown default (preserves editor focus)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://example.com"
          initialLabel=""
          onClose={onClose}
        />,
      )

      const removeBtn = screen.getByRole('button', { name: 'Remove' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const preventSpy = vi.spyOn(event, 'preventDefault')
      fireEvent(removeBtn, event)

      expect(preventSpy).toHaveBeenCalled()
    })
  })

  // ── Escape key ─────────────────────────────────────────────────────────

  describe('escape', () => {
    it('closes popover and refocuses editor on Escape', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(mockCommandsFocus).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
      // setLink should NOT be called
      expect(mockSetLink).not.toHaveBeenCalled()
    })

    it('prevents default on Escape to avoid other handlers', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      const preventSpy = vi.spyOn(event, 'preventDefault')
      fireEvent(input, event)

      expect(preventSpy).toHaveBeenCalled()
    })
  })

  // ── Input state ────────────────────────────────────────────────────────

  describe('input state', () => {
    it('updates internal state as user types', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'new-url.com' } })
      expect(input).toHaveValue('new-url.com')
    })

    it('allows editing existing URL', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://old.com"
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      expect(input).toHaveValue('https://old.com')

      fireEvent.change(input, { target: { value: 'https://new.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))

      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://new.com',
        marks: [{ type: 'link', attrs: { href: 'https://new.com' } }],
      })
    })
  })

  // ── Accessibility ──────────────────────────────────────────────────────

  describe('a11y', () => {
    it('passes axe audit (new link)', async () => {
      const { container } = render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit (editing existing link)', async () => {
      const { container } = render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl="https://example.com"
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  // ── Rejected URL error ─────────────────────────────────────────────────

  describe('rejected URL error', () => {
    it('shows error for javascript: URLs and does not close', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      // Error should be visible
      expect(screen.getByRole('alert')).toHaveTextContent(
        'javascript: and data: URLs are not allowed',
      )

      // Should NOT close the popover
      expect(onClose).not.toHaveBeenCalled()

      // Should NOT call setLink
      expect(mockSetLink).not.toHaveBeenCalled()
    })

    it('shows error for data: URLs', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'data:text/html,test' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(screen.getByRole('alert')).toHaveTextContent(
        'javascript: and data: URLs are not allowed',
      )
      expect(onClose).not.toHaveBeenCalled()
    })

    it('clears error when user types', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const input = screen.getByTestId('link-url-input')

      // Trigger the error
      fireEvent.change(input, { target: { value: 'javascript:void(0)' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      expect(screen.getByRole('alert')).toBeInTheDocument()

      // Type a new value — error should clear
      fireEvent.change(input, { target: { value: 'https://safe.com' } })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  // ── Selection restoration (B-70) ──────────────────────────────────────

  describe('selection restoration (B-70)', () => {
    it('restores saved selection before applying link', () => {
      const mockInsertContentLocal = vi.fn(() => ({ run: mockRun }))
      const mockSetTextSelectionLocal = vi.fn(() => ({
        setLink: mockSetLink,
        insertContent: mockInsertContentLocal,
      }))
      const mockFocusWithSelection = vi.fn(() => ({
        setTextSelection: mockSetTextSelectionLocal,
        setLink: mockSetLink,
        insertContent: mockInsertContentLocal,
      }))
      const mockChainWithSelection = vi.fn(() => ({ focus: mockFocusWithSelection }))

      const editorWithSelection = {
        chain: mockChainWithSelection,
        commands: { focus: mockCommandsFocus },
        schema: { marks: { link: mockLinkMarkType } },
        state: { tr: mockTr },
        view: { dispatch: mockDispatch },
      } as never

      render(
        <LinkEditPopover
          editor={editorWithSelection}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
          savedSelection={{ from: 5, to: 15 }}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockChainWithSelection).toHaveBeenCalled()
      expect(mockFocusWithSelection).toHaveBeenCalled()
      expect(mockSetTextSelectionLocal).toHaveBeenCalledWith({ from: 5, to: 15 })
      expect(mockInsertContentLocal).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://example.com',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
      expect(mockRun).toHaveBeenCalled()
      expect(mockRemoveStoredMark).toHaveBeenCalledWith(mockLinkMarkType)
      expect(mockDispatch).toHaveBeenCalledWith(mockTr)
    })

    it('does not restore selection when savedSelection is null', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
          savedSelection={null}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      // Should use the regular chain().focus().insertContent() path
      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://example.com',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
    })

    it('does not restore selection when savedSelection is collapsed (from === to)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
          savedSelection={{ from: 5, to: 5 }}
        />,
      )

      const input = screen.getByTestId('link-url-input')
      fireEvent.change(input, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://example.com',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
      expect(mockRemoveStoredMark).toHaveBeenCalledWith(mockLinkMarkType)
      expect(mockDispatch).toHaveBeenCalledWith(mockTr)
    })
  })

  // ── Label field (UX-181) ──────────────────────────────────────────────

  describe('label field', () => {
    it('renders label input with empty initial value for new links', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      const labelInput = screen.getByTestId('link-label-input')
      expect(labelInput).toBeInTheDocument()
      expect(labelInput).toHaveValue('')
    })

    it('renders label input pre-filled with initial label', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel="My Link"
          onClose={onClose}
        />,
      )
      expect(screen.getByTestId('link-label-input')).toHaveValue('My Link')
    })

    it('apply with label inserts labeled linked text (no selection)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const labelInput = screen.getByTestId('link-label-input')
      const urlInput = screen.getByTestId('link-url-input')
      fireEvent.change(labelInput, { target: { value: 'Click here' } })
      fireEvent.change(urlInput, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'Click here',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
    })

    it('apply with empty label falls back to URL as text (no selection)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const urlInput = screen.getByTestId('link-url-input')
      fireEvent.change(urlInput, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'https://example.com',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
    })

    it('apply with selection + unchanged label preserves formatting (uses setLink)', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={true}
          initialUrl=""
          initialLabel="existing text"
          onClose={onClose}
          savedSelection={{ from: 5, to: 17 }}
        />,
      )

      const urlInput = screen.getByTestId('link-url-input')
      fireEvent.change(urlInput, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))

      expect(mockSetTextSelection).toHaveBeenCalledWith({ from: 5, to: 17 })
      expect(mockSetLink).toHaveBeenCalledWith({ href: 'https://example.com' })
      expect(mockInsertContent).not.toHaveBeenCalled()
    })

    it('apply with selection + changed label replaces with new text', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel="old text"
          onClose={onClose}
          savedSelection={{ from: 5, to: 13 }}
        />,
      )

      const labelInput = screen.getByTestId('link-label-input')
      const urlInput = screen.getByTestId('link-url-input')
      fireEvent.change(labelInput, { target: { value: 'new label' } })
      fireEvent.change(urlInput, { target: { value: 'https://example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockSetTextSelection).toHaveBeenCalledWith({ from: 5, to: 13 })
      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'new label',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
    })

    it('Enter key in label input applies the link', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const labelInput = screen.getByTestId('link-label-input')
      const urlInput = screen.getByTestId('link-url-input')
      fireEvent.change(labelInput, { target: { value: 'My label' } })
      fireEvent.change(urlInput, { target: { value: 'https://example.com' } })
      fireEvent.keyDown(labelInput, { key: 'Enter' })

      expect(mockInsertContent).toHaveBeenCalledWith({
        type: 'text',
        text: 'My label',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      })
      expect(onClose).toHaveBeenCalled()
    })

    it('Escape key in label input closes popover', () => {
      render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )

      const labelInput = screen.getByTestId('link-label-input')
      fireEvent.keyDown(labelInput, { key: 'Escape' })

      expect(mockCommandsFocus).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    it('passes axe audit with label field', async () => {
      const { container } = render(
        <LinkEditPopover
          editor={makeEditor()}
          isEditing={false}
          initialUrl=""
          initialLabel=""
          onClose={onClose}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
