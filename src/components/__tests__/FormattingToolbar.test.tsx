/**
 * Tests for FormattingToolbar component.
 *
 * Validates:
 *  - Renders all five buttons (Bold, Italic, Code, Undo, Redo)
 *  - Active marks get aria-pressed=true + bg-accent
 *  - Undo/Redo disabled state reflects editor.can()
 *  - Clicking buttons calls the correct editor chain commands
 *  - Uses onMouseDown (not onClick) with preventDefault
 *  - Separator between formatting and history groups
 *  - a11y: role=toolbar, aria-labels, axe audit
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { FormattingToolbar } from '../FormattingToolbar'

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock useEditorState to return controlled state
const mockEditorState = {
  bold: false,
  italic: false,
  code: false,
  link: false,
  codeBlock: false,
  canUndo: false,
  canRedo: false,
}

vi.mock('@tiptap/react', () => ({
  useEditorState: () => {
    return mockEditorState
  },
}))

// Mock Separator — Radix UI Separator needs browser APIs
vi.mock('../ui/separator', () => ({
  Separator: ({ orientation, className }: { orientation?: string; className?: string }) => (
    <div data-testid="separator" data-orientation={orientation} className={className} />
  ),
}))

// ── Editor mock helpers ──────────────────────────────────────────────────

const mockRun = vi.fn()
const mockToggleBold = vi.fn(() => ({ run: mockRun }))
const mockToggleItalic = vi.fn(() => ({ run: mockRun }))
const mockToggleCode = vi.fn(() => ({ run: mockRun }))
const mockToggleCodeBlock = vi.fn(() => ({ run: mockRun }))
const mockSetLink = vi.fn(() => ({ run: mockRun }))
const mockUnsetLink = vi.fn(() => ({ run: mockRun }))
const mockUndo = vi.fn(() => ({ run: mockRun }))
const mockRedo = vi.fn(() => ({ run: mockRun }))
const mockFocus = vi.fn(() => ({
  toggleBold: mockToggleBold,
  toggleItalic: mockToggleItalic,
  toggleCode: mockToggleCode,
  toggleCodeBlock: mockToggleCodeBlock,
  setLink: mockSetLink,
  unsetLink: mockUnsetLink,
  undo: mockUndo,
  redo: mockRedo,
}))
const mockChain = vi.fn(() => ({
  focus: mockFocus,
}))

function makeEditor() {
  return { chain: mockChain } as never
}

describe('FormattingToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEditorState.bold = false
    mockEditorState.italic = false
    mockEditorState.code = false
    mockEditorState.link = false
    mockEditorState.codeBlock = false
    mockEditorState.canUndo = false
    mockEditorState.canRedo = false
  })

  // ── Rendering ────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders as an always-visible toolbar div', () => {
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)
      expect(container.querySelector('.formatting-toolbar')).toBeInTheDocument()
    })

    it('renders all seven formatting buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Italic' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'External link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code block' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument()
    })

    it('renders separators between button groups', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const seps = screen.getAllByTestId('separator')
      expect(seps).toHaveLength(2)
      for (const sep of seps) {
        expect(sep).toHaveAttribute('data-orientation', 'vertical')
      }
    })
  })

  // ── Active mark state ────────────────────────────────────────────────

  describe('active marks', () => {
    it('shows bold as pressed when active', () => {
      mockEditorState.bold = true
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: 'Bold' })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows italic as pressed when active', () => {
      mockEditorState.italic = true
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: 'Italic' })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows code as pressed when active', () => {
      mockEditorState.code = true
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: 'Code' })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows marks as not pressed when inactive', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      for (const label of ['Bold', 'Italic', 'Code']) {
        const btn = screen.getByRole('button', { name: label })
        expect(btn).toHaveAttribute('aria-pressed', 'false')
        // Check that bg-accent is NOT a standalone class (hover:bg-accent is expected from ghost variant)
        const classes = btn.className.split(/\s+/)
        expect(classes).not.toContain('bg-accent')
      }
    })
  })

  // ── Undo/Redo disabled state ─────────────────────────────────────────

  describe('undo/redo state', () => {
    it('disables Undo when canUndo is false', () => {
      mockEditorState.canUndo = false
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    })

    it('enables Undo when canUndo is true', () => {
      mockEditorState.canUndo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Undo' })).not.toBeDisabled()
    })

    it('disables Redo when canRedo is false', () => {
      mockEditorState.canRedo = false
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
    })

    it('enables Redo when canRedo is true', () => {
      mockEditorState.canRedo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled()
    })
  })

  // ── Button actions ───────────────────────────────────────────────────

  describe('button actions', () => {
    it('toggles bold via editor chain on mousedown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Bold' })

      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      const preventSpy = vi.spyOn(event, 'preventDefault')
      fireEvent(btn, event)

      expect(preventSpy).toHaveBeenCalled()
      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockToggleBold).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles italic via editor chain on mousedown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Italic' }))

      expect(mockToggleItalic).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles code via editor chain on mousedown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Code' }))

      expect(mockToggleCode).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('triggers undo via editor chain on mousedown', () => {
      mockEditorState.canUndo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Undo' }))

      expect(mockUndo).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('triggers redo via editor chain on mousedown', () => {
      mockEditorState.canRedo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Redo' }))

      expect(mockRedo).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })
  })

  // ── New button actions ───────────────────────────────────────────────

  describe('new button actions', () => {
    it('toggles external link — prompts for URL when not active', () => {
      const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('https://example.com')
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'External link' }))

      expect(promptSpy).toHaveBeenCalledWith('URL:')
      expect(mockSetLink).toHaveBeenCalledWith({ href: 'https://example.com' })
      promptSpy.mockRestore()
    })

    it('unsets link when link is active', () => {
      mockEditorState.link = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'External link' }))

      expect(mockUnsetLink).toHaveBeenCalled()
    })

    it('toggles code block via editor chain', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Code block' }))

      expect(mockToggleCodeBlock).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('shows External link as pressed when link is active', () => {
      mockEditorState.link = true
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'External link' })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows Code block as pressed when active', () => {
      mockEditorState.codeBlock = true
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Code block' })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })
  })

  // ── Accessibility ────────────────────────────────────────────────────

  describe('a11y', () => {
    it('passes axe audit with no active marks', async () => {
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit with active marks', async () => {
      mockEditorState.bold = true
      mockEditorState.italic = true
      mockEditorState.canUndo = true
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
