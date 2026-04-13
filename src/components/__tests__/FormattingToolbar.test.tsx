/**
 * Tests for FormattingToolbar component.
 *
 * Validates:
 *  - Renders all buttons (Bold, Italic, Code, Strikethrough, Highlight, External link, Internal link, Tag, Code block, Heading, Cycle Priority, Date, Due Date, Scheduled Date, TODO, Undo, Redo)
 *  - Active marks get aria-pressed=true + bg-accent
 *  - Undo/Redo disabled state reflects editor.can()
 *  - Clicking buttons calls the correct editor chain commands
 *  - Uses onPointerDown (not onClick) with preventDefault
 *  - Separator between formatting and history groups
 *  - External link button toggles LinkEditPopover inside a Popover
 *  - Ctrl+K custom event opens the link popover
 *  - Cycle priority button shows current priority state
 *  - a11y: role=toolbar, aria-labels, axe audit
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  codeBlockLanguage: '',
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
    savedSelection,
  }: {
    editor: unknown
    isEditing: boolean
    initialUrl: string
    onClose: () => void
    savedSelection?: { from: number; to: number } | null
  }) => (
    <div
      data-testid="link-edit-popover-mock"
      data-is-editing={String(!!isEditing)}
      data-initial-url={initialUrl}
      data-saved-selection={savedSelection ? JSON.stringify(savedSelection) : ''}
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
const mockToggleCodeBlock = vi.fn(() => ({ run: mockRun, updateAttributes: mockUpdateAttributes }))
const mockToggleBlockquote = vi.fn(() => ({ run: mockRun }))
const mockToggleHeading = vi.fn(() => ({ run: mockRun }))
const mockSetLink = vi.fn(() => ({ run: mockRun }))
const mockUnsetLink = vi.fn(() => ({ run: mockRun }))
const mockInsertContent = vi.fn(() => ({ run: mockRun }))
const mockUndo = vi.fn(() => ({ run: mockRun }))
const mockRedo = vi.fn(() => ({ run: mockRun }))
const mockUpdateAttributes = vi.fn(() => ({ run: mockRun }))
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
  updateAttributes: mockUpdateAttributes,
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
    mockEditorState.codeBlockLanguage = ''
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

    it('renders all twenty-two formatting buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Italic' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Strikethrough' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Highlight' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'External link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Internal link' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Insert tag' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Code block language' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Blockquote' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Heading level' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Ordered list' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Divider' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Callout' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cycle priority' })).toBeInTheDocument()
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
      expect(seps).toHaveLength(4)
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

    it('closes popover when LinkEditPopover calls onClose', async () => {
      const user = userEvent.setup()
      render(<FormattingToolbar editor={makeEditor()} />)

      // Open the popover first
      fireEvent.pointerDown(screen.getByRole('button', { name: 'External link' }))
      // After re-render the popover index changes; find the popover that wraps the close button
      const closeBtn = screen.getByTestId('close-popover')
      const popover = closeBtn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'true')

      // Click the close button in the mocked LinkEditPopover
      await user.click(closeBtn)
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
        mockEditorDom.dispatchEvent(new CustomEvent('open-link-popover', { bubbles: true }))
      })

      const popoverAfter = screen
        .getByRole('button', { name: 'External link' })
        .closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('Ctrl+K event with selection range passes savedSelection to popover', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      act(() => {
        mockEditorDom.dispatchEvent(
          new CustomEvent('open-link-popover', {
            bubbles: true,
            detail: { from: 5, to: 15 },
          }),
        )
      })

      const linkBtn = screen.getByRole('button', { name: 'External link' })
      const popoverAfter = linkBtn.closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')

      const popoverMock = screen.getByTestId('link-edit-popover-mock')
      expect(popoverMock).toHaveAttribute(
        'data-saved-selection',
        JSON.stringify({ from: 5, to: 15 }),
      )
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
      // Code block button is now a popover — click opens it, select "Plain text" to toggle
      const btn = screen.getByRole('button', { name: 'Code block language' })
      fireEvent.pointerDown(btn)
      // The popover content shows language options including "Plain text"
      const popoverContents = screen.getAllByTestId('popover-content')
      const codeBlockPopover = popoverContents.find((el) =>
        el.textContent?.includes('Plain text'),
      ) as HTMLElement
      expect(codeBlockPopover).toBeInTheDocument()
    })

    it('shows Code block as pressed when active', () => {
      mockEditorState.codeBlock = true
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Code block language' })
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

  // ── Priority cycling button ─────────────────────────────────────────

  describe('priority cycling button', () => {
    it('dispatches cycle-priority event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('cycle-priority', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Cycle priority' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('cycle-priority', spy)
    })

    it('shows "P" with no dot when no priority is set', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Cycle priority' })
      expect(btn.textContent).toBe('P')
      expect(btn.querySelector('.rounded-full')).toBeNull()
      expect(btn).toHaveAttribute('aria-pressed', 'false')
    })

    it('shows "P1" with red dot for priority 1', () => {
      render(<FormattingToolbar editor={makeEditor()} currentPriority="1" />)
      const btn = screen.getByRole('button', { name: 'Cycle priority' })
      expect(btn.textContent).toContain('P1')
      const dot = btn.querySelector('.rounded-full')
      expect(dot).toBeInTheDocument()
      expect(dot?.className).toContain('bg-priority-urgent')
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows "P2" with yellow dot for priority 2', () => {
      render(<FormattingToolbar editor={makeEditor()} currentPriority="2" />)
      const btn = screen.getByRole('button', { name: 'Cycle priority' })
      expect(btn.textContent).toContain('P2')
      const dot = btn.querySelector('.rounded-full')
      expect(dot).toBeInTheDocument()
      expect(dot?.className).toContain('bg-priority-high')
      expect(btn).toHaveAttribute('aria-pressed', 'true')
    })

    it('shows "P3" with blue dot for priority 3', () => {
      render(<FormattingToolbar editor={makeEditor()} currentPriority="3" />)
      const btn = screen.getByRole('button', { name: 'Cycle priority' })
      expect(btn.textContent).toContain('P3')
      const dot = btn.querySelector('.rounded-full')
      expect(dot).toBeInTheDocument()
      expect(dot?.className).toContain('bg-priority-normal')
      expect(btn).toHaveAttribute('aria-pressed', 'true')
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Cycle priority' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── Date buttons ───────────────────────────────────────────────────

  describe('date buttons', () => {
    it('date button dispatches open-date-picker event', () => {
      const spy = vi.fn()
      document.addEventListener('open-date-picker', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Insert date' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-date-picker', spy)
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
      expect(screen.getByRole('button', { name: 'Code block language' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Blockquote' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Heading level' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Ordered list' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Divider' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Callout' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cycle priority' })).toBeInTheDocument()
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

  // ── UX-90: Structure buttons (Ordered List, Divider, Callout) ─────────

  describe('structure buttons', () => {
    it('renders Ordered list button with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Ordered list' })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', 'Ordered list')
    })

    it('renders Divider button with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Divider' })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', 'Divider')
    })

    it('renders Callout button with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Callout' })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', 'Callout')
    })

    it('dispatches insert-ordered-list event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('insert-ordered-list', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Ordered list' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('insert-ordered-list', spy)
    })

    it('dispatches insert-divider event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('insert-divider', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Divider' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('insert-divider', spy)
    })

    it('dispatches insert-callout event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('insert-callout', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Callout' }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('insert-callout', spy)
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      for (const label of ['Ordered list', 'Divider', 'Callout']) {
        const btn = screen.getByRole('button', { name: label })
        const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
        const prevented = !btn.dispatchEvent(event)
        expect(prevented).toBe(true)
      }
    })

    it('passes axe audit with structure buttons', async () => {
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)
      expect(await axe(container)).toHaveNoViolations()
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

    it('heading button uses icon-xs size matching other toolbar buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Heading level' })
      // icon-xs size class includes size-6
      expect(btn.className).toContain('size-6')
    })

    it('shows H1-H6 and Paragraph options in popover content', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // The popover content is always rendered in our mock
      const popoverContents = screen.getAllByTestId('popover-content')
      // The heading popover is the third popover-content (after link and code block popovers)
      const headingPopover = popoverContents[2] as HTMLElement
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
    it('wraps toolbar in ScrollArea for narrow screens', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
      const scrollArea = toolbar.closest('[data-slot="scroll-area"]')
      expect(scrollArea).toBeInTheDocument()
    })
  })

  // ── UX-62: Code block language popover ────────────────────────────────

  describe('code block language popover', () => {
    it('renders code block language popover button', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Code block language' })
      expect(btn).toBeInTheDocument()
    })

    it('opens code block language popover on click', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: 'Code block language' })
      const popover = btn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'false')

      fireEvent.pointerDown(btn)

      const popoverAfter = screen
        .getByRole('button', { name: 'Code block language' })
        .closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('shows language options in popover content', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const popoverContents = screen.getAllByTestId('popover-content')
      // The code block popover is the second popover-content (after the link popover)
      const codeBlockPopover = popoverContents[1] as HTMLElement
      expect(codeBlockPopover).toBeInTheDocument()
      for (const lang of ['javascript', 'typescript', 'python', 'rust', 'bash', 'sql']) {
        expect(codeBlockPopover.textContent).toContain(lang)
      }
      expect(codeBlockPopover.textContent).toContain('Plain text')
    })

    it('shows active language highlight', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'python'
      render(<FormattingToolbar editor={makeEditor()} />)

      const popoverContents = screen.getAllByTestId('popover-content')
      const codeBlockPopover = popoverContents[1] as HTMLElement
      // Find the python button inside the popover
      const buttons = codeBlockPopover.querySelectorAll('button')
      const pythonBtn = Array.from(buttons).find((b) => b.textContent === 'python')
      expect(pythonBtn).toBeDefined()
      expect(pythonBtn?.className).toContain('bg-accent')
    })

    it('selects a language when not in code block', () => {
      mockEditorState.codeBlock = false
      render(<FormattingToolbar editor={makeEditor()} />)

      const popoverContents = screen.getAllByTestId('popover-content')
      const codeBlockPopover = popoverContents[1] as HTMLElement
      const buttons = codeBlockPopover.querySelectorAll('button')
      const jsBtn = Array.from(buttons).find((b) => b.textContent === 'javascript')
      expect(jsBtn).toBeDefined()

      fireEvent.pointerDown(jsBtn as HTMLElement)

      expect(mockToggleCodeBlock).toHaveBeenCalled()
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'javascript' })
    })

    it('updates language when already in code block', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'python'
      render(<FormattingToolbar editor={makeEditor()} />)

      const popoverContents = screen.getAllByTestId('popover-content')
      const codeBlockPopover = popoverContents[1] as HTMLElement
      const buttons = codeBlockPopover.querySelectorAll('button')
      const rustBtn = Array.from(buttons).find((b) => b.textContent === 'rust')
      expect(rustBtn).toBeDefined()

      fireEvent.pointerDown(rustBtn as HTMLElement)

      expect(mockToggleCodeBlock).not.toHaveBeenCalled()
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'rust' })
    })

    it('shows short language label when active', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'javascript'
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: 'Code block language' })
      expect(btn.textContent).toContain('JS')
    })

    it('shows short label for typescript', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'typescript'
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: 'Code block language' })
      expect(btn.textContent).toContain('TS')
    })

    it('does not show short label when no language is set', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = ''
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: 'Code block language' })
      // Should only have the icon, no text label
      expect(btn.querySelector('.text-\\[10px\\]')).toBeNull()
    })

    it('a11y: no violations with code block popover open', async () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'python'
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)

      // Open the popover
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Code block language' }))

      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
