/**
 * Tests for FormattingToolbar component.
 *
 * Validates:
 *  - Renders all twenty buttons (Bold, Italic, Code, Strikethrough, Highlight, External link, Internal link, Tag, Code block, Heading, Priority 1/2/3, Date, Due Date, Scheduled Date, TODO, Undo, Redo)
 *  - Active marks get aria-pressed=true + bg-accent
 *  - Undo/Redo disabled state reflects editor.can()
 *  - Clicking buttons calls the correct editor chain commands
 *  - Uses onPointerDown (not onClick) with preventDefault
 *  - Separator between formatting and history groups
 *  - External link button toggles LinkEditPopover inside a Popover
 *  - Ctrl+K custom event opens the link popover
 *  - a11y: role=toolbar, aria-labels, axe audit
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { FormattingToolbar } from '../FormattingToolbar'

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock useEditorState to return controlled state
const mockEditorState = {
  bold: false,
  italic: false,
  code: false,
  strike: false,
  highlight: false,
  link: false,
  codeBlock: false,
  blockquote: false,
  headingLevel: 0,
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

// Mock Popover components — render children inline for testing
let popoverIdx = 0
vi.mock('../ui/popover', () => ({
  Popover: ({
    children,
    open,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    const id = `popover-${popoverIdx++}`
    return (
      <div data-testid={id} data-popover data-open={String(!!open)}>
        {children}
      </div>
    )
  },
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
  }: {
    children: React.ReactNode
    align?: string
    className?: string
  }) => <div data-testid="popover-content">{children}</div>,
}))

// Mock LinkEditPopover — render a simple stub with data attributes for props
vi.mock('../LinkEditPopover', () => ({
  LinkEditPopover: ({
    isEditing,
    initialUrl,
    onClose,
  }: {
    editor: unknown
    isEditing: boolean
    initialUrl: string
    onClose: () => void
  }) => (
    <div
      data-testid="link-edit-popover-mock"
      data-is-editing={String(!!isEditing)}
      data-initial-url={initialUrl}
    >
      <button type="button" onClick={onClose} data-testid="close-popover">
        Close
      </button>
    </div>
  ),
}))

// ── Editor mock helpers ──────────────────────────────────────────────────

const mockRun = vi.fn()
const mockToggleBold = vi.fn(() => ({ run: mockRun }))
const mockToggleItalic = vi.fn(() => ({ run: mockRun }))
const mockToggleCode = vi.fn(() => ({ run: mockRun }))
const mockToggleStrike = vi.fn(() => ({ run: mockRun }))
const mockToggleHighlight = vi.fn(() => ({ run: mockRun }))
const mockToggleCodeBlock = vi.fn(() => ({ run: mockRun }))
const mockToggleBlockquote = vi.fn(() => ({ run: mockRun }))
const mockToggleHeading = vi.fn(() => ({ run: mockRun }))
const mockSetLink = vi.fn(() => ({ run: mockRun }))
const mockUnsetLink = vi.fn(() => ({ run: mockRun }))
const mockInsertContent = vi.fn(() => ({ run: mockRun }))
const mockUndo = vi.fn(() => ({ run: mockRun }))
const mockRedo = vi.fn(() => ({ run: mockRun }))
const mockFocus = vi.fn(() => ({
  toggleBold: mockToggleBold,
  toggleItalic: mockToggleItalic,
  toggleCode: mockToggleCode,
  toggleStrike: mockToggleStrike,
  toggleHighlight: mockToggleHighlight,
  toggleCodeBlock: mockToggleCodeBlock,
  toggleBlockquote: mockToggleBlockquote,
  toggleHeading: mockToggleHeading,
  setLink: mockSetLink,
  unsetLink: mockUnsetLink,
  insertContent: mockInsertContent,
  undo: mockUndo,
  redo: mockRedo,
}))
const mockChain = vi.fn(() => ({
  focus: mockFocus,
}))
const mockGetAttributes = vi.fn(() => ({}))

/** Shared editor DOM element so Ctrl+K event listener can be tested. */
const mockEditorDom = document.createElement('div')

function makeEditor() {
  return {
    chain: mockChain,
    getAttributes: mockGetAttributes,
    view: { dom: mockEditorDom },
  } as never
}

describe('FormattingToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    popoverIdx = 0
    mockEditorState.bold = false
    mockEditorState.italic = false
    mockEditorState.code = false
    mockEditorState.strike = false
    mockEditorState.highlight = false
    mockEditorState.link = false
    mockEditorState.codeBlock = false
    mockEditorState.blockquote = false
    mockEditorState.headingLevel = 0
    mockEditorState.canUndo = false
    mockEditorState.canRedo = false
    mockGetAttributes.mockReturnValue({})
  })

  // ── Rendering ────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders as an always-visible toolbar div', () => {
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)
      expect(container.querySelector('.formatting-toolbar')).toBeInTheDocument()
    })

    it('has role="toolbar" with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
      expect(toolbar).toBeInTheDocument()
    })

    it('renders all twenty-one formatting buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Italic' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Strikethrough' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Highlight' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'External link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Internal link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Insert tag' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code block' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Blockquote' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Heading level' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Priority 1 (high)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Priority 2 (medium)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Priority 3 (low)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Insert date' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Set due date' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Set scheduled date' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Toggle TODO state' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()
    })

    it('renders separators between button groups', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const seps = screen.getAllByTestId('separator')
      expect(seps).toHaveLength(3)
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

      for (const label of ['Bold', 'Italic', 'Code', 'Strikethrough', 'Highlight', 'Blockquote']) {
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
    it('toggles bold via editor chain on pointerdown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Bold' })

      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const preventSpy = vi.spyOn(event, 'preventDefault')
      fireEvent(btn, event)

      expect(preventSpy).toHaveBeenCalled()
      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockToggleBold).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles italic via editor chain on pointerdown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Italic' }))

      expect(mockToggleItalic).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles code via editor chain on pointerdown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Code' }))

      expect(mockToggleCode).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('triggers undo via editor chain on pointerdown', () => {
      mockEditorState.canUndo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Undo' }))

      expect(mockUndo).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('triggers redo via editor chain on pointerdown', () => {
      mockEditorState.canRedo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Redo' }))

      expect(mockRedo).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })
  })

  // ── Link popover actions ─────────────────────────────────────────────

  describe('link popover', () => {
    it('opens link popover when clicking External link button', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      const linkBtn = screen.getByRole('button', { name: 'External link' })
      const popover = linkBtn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'false')

      fireEvent.pointerDown(linkBtn)

      // After re-render, find the popover wrapping the link button again
      const popoverAfter = screen
        .getByRole('button', { name: 'External link' })
        .closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('passes isEditing=false and empty initialUrl when no link is active', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-is-editing', 'false')
      expect(mock).toHaveAttribute('data-initial-url', '')
    })

    it('passes isEditing=true and pre-filled URL when link is active', () => {
      mockEditorState.link = true
      mockGetAttributes.mockReturnValue({ href: 'https://example.com' })
      render(<FormattingToolbar editor={makeEditor()} />)

      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-is-editing', 'true')
      expect(mock).toHaveAttribute('data-initial-url', 'https://example.com')
    })

    it('closes popover when LinkEditPopover calls onClose', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      // Open the popover first
      fireEvent.pointerDown(screen.getByRole('button', { name: 'External link' }))
      // After re-render the popover index changes; find the popover that wraps the close button
      const closeBtn = screen.getByTestId('close-popover')
      const popover = closeBtn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'true')

      // Click the close button in the mocked LinkEditPopover
      fireEvent.click(closeBtn)
      // After another re-render, find the popover again
      const linkEditMock = screen.getByTestId('link-edit-popover-mock')
      const popoverAfter = linkEditMock.closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'false')
    })

    it('opens popover on Ctrl+K custom event from editor DOM', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      const linkBtn = screen.getByRole('button', { name: 'External link' })
      const popover = linkBtn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'false')

      // Simulate the custom event dispatched by the ExternalLink extension
      act(() => {
        mockEditorDom.dispatchEvent(new CustomEvent('open-link-popover'))
      })

      const popoverAfter = screen
        .getByRole('button', { name: 'External link' })
        .closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('shows External link as pressed when link is active', () => {
      mockEditorState.link = true
      mockGetAttributes.mockReturnValue({ href: 'https://example.com' })
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'External link' })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('toggles code block via editor chain', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Code block' }))

      expect(mockToggleCodeBlock).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
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

  // ── Priority and Date buttons ──────────────────────────────────────

  describe('priority and date buttons', () => {
    it('priority 1 button dispatches set-priority-1 event', () => {
      const spy = vi.fn()
      document.addEventListener('set-priority-1', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Priority 1 (high)' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('set-priority-1', spy)
    })

    it('priority 2 button dispatches set-priority-2 event', () => {
      const spy = vi.fn()
      document.addEventListener('set-priority-2', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Priority 2 (medium)' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('set-priority-2', spy)
    })

    it('priority 3 button dispatches set-priority-3 event', () => {
      const spy = vi.fn()
      document.addEventListener('set-priority-3', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Priority 3 (low)' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('set-priority-3', spy)
    })

    it('date button dispatches open-date-picker event', () => {
      const spy = vi.fn()
      document.addEventListener('open-date-picker', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Insert date' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-date-picker', spy)
    })

    it('priority buttons prevent default to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Priority 1 (high)' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })

    it('date button prevents default to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Insert date' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── Internal link button ───────────────────────────────────────────

  describe('internal link button', () => {
    it('inserts [[ into the editor to trigger the block link picker', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Internal link' }))
      expect(mockInsertContent).toHaveBeenCalledWith('[[')
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Internal link' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── Tag button ─────────────────────────────────────────────────────

  describe('tag button', () => {
    it('inserts @ into the editor to trigger the tag picker', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Insert tag' }))
      expect(mockInsertContent).toHaveBeenCalledWith('@')
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Insert tag' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── Tooltip labels (via aria-labels) ───────────────────────────────

  describe('tooltip labels', () => {
    it('all buttons have correct aria-labels', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Italic' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Strikethrough' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Highlight' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'External link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Internal link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Insert tag' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code block' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Blockquote' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Heading level' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Priority 1 (high)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Priority 2 (medium)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Priority 3 (low)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Insert date' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Set due date' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Set scheduled date' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Toggle TODO state' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()
    })
  })

  // ── #46: aria-controls linking ────────────────────────────────────────

  describe('aria-controls', () => {
    it('sets aria-controls to editor-{blockId} when blockId is provided', () => {
      render(<FormattingToolbar editor={makeEditor()} blockId="B1" />)
      const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
      expect(toolbar).toHaveAttribute('aria-controls', 'editor-B1')
    })

    it('does not set aria-controls when blockId is omitted', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
      expect(toolbar).not.toHaveAttribute('aria-controls')
    })
  })

  // ── #611: Due Date button ─────────────────────────────────────────────

  describe('due date button', () => {
    it('renders with aria-label "Set due date"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Set due date' })).toBeInTheDocument()
    })

    it('dispatches open-due-date-picker custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('open-due-date-picker', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Set due date' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-due-date-picker', spy)
    })
  })

  // ── #631: Scheduled Date button ─────────────────────────────────────────

  describe('scheduled date button', () => {
    it('renders with aria-label "Set scheduled date"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Set scheduled date' })).toBeInTheDocument()
    })

    it('dispatches open-scheduled-date-picker custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('open-scheduled-date-picker', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Set scheduled date' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-scheduled-date-picker', spy)
    })
  })

  // ── #612: TODO cycle button ───────────────────────────────────────────

  describe('TODO cycle button', () => {
    it('renders with aria-label "Toggle TODO state"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Toggle TODO state' })).toBeInTheDocument()
    })

    it('dispatches toggle-todo-state custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('toggle-todo-state', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Toggle TODO state' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('toggle-todo-state', spy)
    })
  })

  // ── #613: Heading dropdown ────────────────────────────────────────────

  describe('heading dropdown', () => {
    it('renders heading button and shows level when heading is active', () => {
      mockEditorState.headingLevel = 2
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Heading level' })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
      expect(btn.textContent).toContain('2')
    })

    it('shows H1-H6 and Paragraph options in popover content', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // The popover content is always rendered in our mock
      const popoverContents = screen.getAllByTestId('popover-content')
      // The heading popover is the second popover-content (after the link popover)
      const headingPopover = popoverContents[1]
      expect(headingPopover).toBeInTheDocument()
      for (let i = 1; i <= 6; i++) {
        expect(headingPopover.textContent).toContain(`H${i}`)
      }
      expect(headingPopover.textContent).toContain('Paragraph')
    })
  })

  // ── #590-A4: Discard button ───────────────────────────────────────────

  describe('discard button', () => {
    it('renders with aria-label "Discard changes"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()
    })

    it('dispatches discard-block-edit custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('discard-block-edit', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Discard changes' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('discard-block-edit', spy)
    })
  })

  // ── #590-B7: Toolbar overflow handling ────────────────────────────────

  describe('toolbar overflow', () => {
    it('has overflow-x-auto class for narrow screens', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
      expect(toolbar.className).toContain('overflow-x-auto')
    })
  })
})
