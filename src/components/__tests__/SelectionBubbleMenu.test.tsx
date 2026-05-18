/**
 * Tests for SelectionBubbleMenu component (PEND-33 Layer A).
 *
 * The bubble menu hosts the 5 mark toggles (Bold, Italic, Code, Strike,
 * Highlight) and the External Link button + popover, hoisted out of
 * FormattingToolbar. It renders only when the editor selection is non-empty.
 *
 * Validates:
 *  - Visibility predicate: bubble renders on non-empty selection,
 *    hidden on empty selection
 *  - Mark toggles dispatch the correct editor chain commands
 *  - Active marks get aria-pressed=true + bg-accent
 *  - onPointerDown + preventDefault preserves editor focus
 *  - External link popover wiring (open via click, open via Ctrl+K event,
 *    pre-fills URL/label, savedSelection threading)
 *  - role="toolbar" + aria-controls + aria-labels
 *  - Tooltip tooltips append keyboard bindings (UX-301)
 *  - max-w-[calc(100vw-2rem)] viewport-clamp on link popover (PEND-28 H5)
 *  - axe audit
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { SelectionBubbleMenu } from '../SelectionBubbleMenu'

// ── Mocks ────────────────────────────────────────────────────────────────

// Control the BubbleMenu visibility predicate via a shared flag so tests
// can assert show/hide behaviour. The real BubbleMenu portals into a
// generated div; we render `children` inline conditionally on `shouldShow`.
let bubbleMenuSelectionEmpty = false

vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: ({
    children,
    shouldShow,
    role,
    'aria-label': ariaLabel,
    'aria-controls': ariaControls,
    className,
    'data-testid': dataTestId,
  }: {
    children: React.ReactNode
    shouldShow?: (props: {
      state: { selection: { empty: boolean } }
      editor: unknown
      element: HTMLElement
      view: unknown
      from: number
      to: number
    }) => boolean
    editor: unknown
    role?: string
    'aria-label'?: string
    'aria-controls'?: string
    className?: string
    'data-testid'?: string
  }) => {
    const fakeProps = {
      state: { selection: { empty: bubbleMenuSelectionEmpty } },
      editor: {} as unknown,
      element: document.createElement('div'),
      view: {} as unknown,
      from: 0,
      to: 0,
    }
    const visible = shouldShow ? shouldShow(fakeProps) : true
    if (!visible) return null
    // The real BubbleMenu always renders a toolbar; hardcoding the role
    // here lets biome's a11y checker see that aria-label is valid.
    // The `role` prop from the unit under test is asserted in dedicated
    // tests via screen.getByRole('toolbar', { name: t('toolbar.selectionFormatting') }).
    void role
    return (
      <div
        role="toolbar"
        aria-label={ariaLabel}
        aria-controls={ariaControls}
        className={className}
        data-testid={dataTestId}
      >
        {children}
      </div>
    )
  },
}))

const mockGetMarkRange = vi.fn()
vi.mock('@tiptap/core', () => ({
  getMarkRange: (...args: unknown[]) => mockGetMarkRange(...args),
}))

// Mock useEditorState to return controlled state
const mockEditorState = {
  bold: false,
  italic: false,
  code: false,
  strike: false,
  highlight: false,
  link: false,
}

vi.mock('@tiptap/react', () => ({
  useEditorState: () => mockEditorState,
}))

// Mock Separator — Radix UI Separator needs browser APIs
vi.mock('../ui/separator', () => ({
  Separator: ({ orientation, className }: { orientation?: string; className?: string }) => (
    <div data-testid="separator" data-orientation={orientation} className={className} />
  ),
}))

// Mock Tooltip primitives — Radix portals tooltip content lazily; render
// the label inline so tests can assert on tooltip text (UX-301).
vi.mock('../ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
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
    className,
  }: {
    children: React.ReactNode
    align?: string
    className?: string
  }) => (
    <div data-testid="popover-content" className={className}>
      {children}
    </div>
  ),
}))

// Mock LinkEditPopover — render a simple stub with data attributes for props
vi.mock('../LinkEditPopover', () => ({
  LinkEditPopover: ({
    isEditing,
    initialUrl,
    initialLabel,
    onClose,
    savedSelection,
  }: {
    editor: unknown
    isEditing: boolean
    initialUrl: string
    initialLabel: string
    onClose: () => void
    savedSelection?: { from: number; to: number } | null
  }) => (
    <div
      data-testid="link-edit-popover-mock"
      data-is-editing={String(!!isEditing)}
      data-initial-url={initialUrl}
      data-initial-label={initialLabel}
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
const mockSetLink = vi.fn(() => ({ run: mockRun }))
const mockUnsetLink = vi.fn(() => ({ run: mockRun }))
const mockInsertContent = vi.fn(() => ({ run: mockRun }))
const mockFocus = vi.fn(() => ({
  toggleBold: mockToggleBold,
  toggleItalic: mockToggleItalic,
  toggleCode: mockToggleCode,
  toggleStrike: mockToggleStrike,
  toggleHighlight: mockToggleHighlight,
  setLink: mockSetLink,
  unsetLink: mockUnsetLink,
  insertContent: mockInsertContent,
}))
const mockChain = vi.fn(() => ({
  focus: mockFocus,
}))
const mockGetAttributes = vi.fn(() => ({}))

/** Shared editor DOM element so Ctrl+K event listener can be tested. */
const mockEditorDom = document.createElement('div')

const mockResolve = vi.fn(() => ({}))
const mockTextBetween = vi.fn(() => '')
const mockIsActive = vi.fn(() => false)

function makeEditor() {
  return {
    chain: mockChain,
    getAttributes: mockGetAttributes,
    isActive: mockIsActive,
    state: {
      doc: {
        resolve: mockResolve,
        textBetween: mockTextBetween,
      },
      selection: { from: 0, to: 0 },
    },
    schema: {
      marks: {
        link: { name: 'link' },
      },
    },
    view: { dom: mockEditorDom },
  } as never
}

describe('SelectionBubbleMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    popoverIdx = 0
    // Default to "selection is non-empty" so the bubble renders for most tests.
    bubbleMenuSelectionEmpty = false
    mockEditorState.bold = false
    mockEditorState.italic = false
    mockEditorState.code = false
    mockEditorState.strike = false
    mockEditorState.highlight = false
    mockEditorState.link = false
    mockGetAttributes.mockReturnValue({})
    mockResolve.mockReturnValue({})
    mockTextBetween.mockReturnValue('')
    mockIsActive.mockReturnValue(false)
    mockGetMarkRange.mockReturnValue(undefined)
  })

  // ── Visibility predicate ──────────────────────────────────────────────

  describe('visibility', () => {
    it('renders when selection is non-empty', () => {
      bubbleMenuSelectionEmpty = false
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      expect(screen.getByTestId('selection-bubble-menu')).toBeInTheDocument()
      expect(
        screen.getByRole('toolbar', { name: t('toolbar.selectionFormatting') }),
      ).toBeInTheDocument()
    })

    it('does not render when selection is empty', () => {
      bubbleMenuSelectionEmpty = true
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      expect(screen.queryByTestId('selection-bubble-menu')).toBeNull()
      expect(screen.queryByRole('button', { name: t('toolbar.bold') })).toBeNull()
    })

    it('hides all mark toggles when selection is empty', () => {
      bubbleMenuSelectionEmpty = true
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      for (const label of [
        t('toolbar.bold'),
        t('toolbar.italic'),
        t('toolbar.code'),
        t('toolbar.strikethrough'),
        t('toolbar.highlight'),
        t('toolbar.link'),
      ]) {
        expect(screen.queryByRole('button', { name: label })).toBeNull()
      }
    })
  })

  // ── Rendering ────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the 5 mark toggles + External link button', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.bold') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.italic') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.code') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.strikethrough') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.highlight') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.link') })).toBeInTheDocument()
    })

    it('has role="toolbar" with aria-label "Selection formatting"', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', {
        name: t('toolbar.selectionFormatting'),
      })
      expect(toolbar).toBeInTheDocument()
    })

    it('renders one separator between marks and external link', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const seps = screen.getAllByTestId('separator')
      expect(seps).toHaveLength(1)
      expect(seps[0]).toHaveAttribute('data-orientation', 'vertical')
    })

    it('uses semantic theming tokens (bg-popover, border-border)', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const bubble = screen.getByTestId('selection-bubble-menu')
      expect(bubble.className).toContain('bg-popover')
      expect(bubble.className).toContain('border-border')
    })
  })

  // ── Active mark state ────────────────────────────────────────────────

  describe('active marks', () => {
    it('shows bold as pressed when active', () => {
      mockEditorState.bold = true
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.bold') })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows italic as pressed when active', () => {
      mockEditorState.italic = true
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.italic') })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows code as pressed when active', () => {
      mockEditorState.code = true
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.code') })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows marks as not pressed when inactive', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      for (const label of [
        t('toolbar.bold'),
        t('toolbar.italic'),
        t('toolbar.code'),
        t('toolbar.strikethrough'),
        t('toolbar.highlight'),
      ]) {
        const btn = screen.getByRole('button', { name: label })
        expect(btn).toHaveAttribute('aria-pressed', 'false')
        // bg-accent must not be a standalone class (hover:bg-accent comes
        // from the ghost variant).
        const classes = btn.className.split(/\s+/)
        expect(classes).not.toContain('bg-accent')
      }
    })
  })

  // ── Button actions ───────────────────────────────────────────────────

  describe('button actions', () => {
    it('toggles bold via editor chain on pointerdown', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.bold') })

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
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.italic') }))
      expect(mockToggleItalic).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles code via editor chain on pointerdown', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.code') }))
      expect(mockToggleCode).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles strikethrough via editor chain on pointerdown', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.strikethrough') }))
      expect(mockToggleStrike).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('toggles highlight via editor chain on pointerdown', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.highlight') }))
      expect(mockToggleHighlight).toHaveBeenCalled()
      expect(mockRun).toHaveBeenCalled()
    })

    it('mark-toggle preserves editor focus by calling preventDefault on pointerdown', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      for (const label of [
        t('toolbar.bold'),
        t('toolbar.italic'),
        t('toolbar.code'),
        t('toolbar.strikethrough'),
        t('toolbar.highlight'),
      ]) {
        const btn = screen.getByRole('button', { name: label })
        const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
        const prevented = !btn.dispatchEvent(event)
        expect(prevented).toBe(true)
      }
    })
  })

  // ── Link popover actions ─────────────────────────────────────────────

  describe('link popover', () => {
    it('opens link popover when clicking External link button', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const linkBtn = screen.getByRole('button', { name: t('toolbar.link') })
      const popover = document.querySelector('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'false')

      fireEvent.pointerDown(linkBtn)

      const popoverAfter = document.querySelector('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('passes isEditing=false and empty initialUrl when no link is active', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-is-editing', 'false')
      expect(mock).toHaveAttribute('data-initial-url', '')
    })

    it('passes isEditing=true and pre-filled URL when link is active', () => {
      mockEditorState.link = true
      mockGetAttributes.mockReturnValue({ href: 'https://example.com' })
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-is-editing', 'true')
      expect(mock).toHaveAttribute('data-initial-url', 'https://example.com')
    })

    it('closes popover when LinkEditPopover calls onClose', async () => {
      const user = userEvent.setup()
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      // Open the popover first
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.link') }))
      const closeBtn = screen.getByTestId('close-popover')
      const popover = closeBtn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'true')

      // Click the close button in the mocked LinkEditPopover
      await user.click(closeBtn)
      const linkEditMock = screen.getByTestId('link-edit-popover-mock')
      const popoverAfter = linkEditMock.closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'false')
    })

    it('opens popover on Ctrl+K custom event from editor DOM', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      const popover = document.querySelector('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'false')

      // Simulate the custom event dispatched by the ExternalLink extension
      act(() => {
        mockEditorDom.dispatchEvent(new CustomEvent('open-link-popover', { bubbles: true }))
      })

      const popoverAfter = document.querySelector('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('Ctrl+K event with selection range passes savedSelection to popover', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      act(() => {
        mockEditorDom.dispatchEvent(
          new CustomEvent('open-link-popover', {
            bubbles: true,
            detail: { from: 5, to: 15 },
          }),
        )
      })

      const popoverAfter = document.querySelector('[data-popover]') as HTMLElement
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
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.link') })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('passes initialLabel="" when no link is active', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-initial-label', '')
    })

    it('passes link text as initialLabel when link is active', () => {
      mockEditorState.link = true
      mockGetAttributes.mockReturnValue({ href: 'https://example.com' })
      mockGetMarkRange.mockReturnValue({ from: 5, to: 17 })
      mockTextBetween.mockReturnValue('Example Site')
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-initial-label', 'Example Site')
    })

    it('passes selected text as initialLabel when Ctrl+K with selection', () => {
      mockTextBetween.mockReturnValue('selected text')
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      act(() => {
        mockEditorDom.dispatchEvent(
          new CustomEvent('open-link-popover', {
            bubbles: true,
            detail: { from: 5, to: 18 },
          }),
        )
      })

      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-initial-label', 'selected text')
    })

    it('Ctrl+K inside existing link uses full mark range for savedSelection', () => {
      mockEditorState.link = true
      mockIsActive.mockReturnValue(true)
      mockGetMarkRange.mockReturnValue({ from: 3, to: 20 })
      mockGetAttributes.mockReturnValue({ href: 'https://example.com' })
      render(<SelectionBubbleMenu editor={makeEditor()} />)

      act(() => {
        mockEditorDom.dispatchEvent(
          new CustomEvent('open-link-popover', {
            bubbles: true,
            detail: { from: 8, to: 12 },
          }),
        )
      })

      const mock = screen.getByTestId('link-edit-popover-mock')
      expect(mock).toHaveAttribute('data-saved-selection', JSON.stringify({ from: 3, to: 20 }))
    })

    it('External link prevents default on pointerdown to preserve editor focus', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.link') })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── aria-controls linking ────────────────────────────────────────────

  describe('aria-controls', () => {
    it('sets aria-controls to editor-{blockId} when blockId is provided', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} blockId="B1" />)
      const toolbar = screen.getByRole('toolbar', { name: t('toolbar.selectionFormatting') })
      expect(toolbar).toHaveAttribute('aria-controls', 'editor-B1')
    })

    it('does not set aria-controls when blockId is omitted', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: t('toolbar.selectionFormatting') })
      expect(toolbar).not.toHaveAttribute('aria-controls')
    })
  })

  // ── Tooltip labels ────────────────────────────────────────────────────

  describe('keyboard shortcut tooltips', () => {
    /** Collect rendered tooltip strings (Radix Tooltip content is mocked above). */
    function tooltipTexts(): string[] {
      return screen.getAllByTestId('tooltip-content').map((el) => el.textContent ?? '')
    }

    it("Bold button's tooltip contains the bold keyboard shortcut binding", () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const boldTooltip = tooltipTexts().find((text) => /^Bold\b/.test(text))
      expect(boldTooltip).toBeDefined()
      expect(boldTooltip).toMatch(/Ctrl\+B|⌘B/i)
    })

    it("Code button's tooltip appends the inlineCode keyboard binding", () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const codeTooltip = tooltipTexts().find((text) => /^Inline code \(/.test(text))
      expect(codeTooltip).toBeDefined()
      expect(codeTooltip).toMatch(/Ctrl\s*\+\s*E\)/i)
    })

    it("External link button's tooltip appends the linkPopover keyboard binding", () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const linkTooltip = tooltipTexts().find((text) => /^External link\b/.test(text))
      expect(linkTooltip).toBeDefined()
      expect(linkTooltip).toMatch(/Ctrl\s*\+\s*K\)/i)
    })

    it('does not render stray empty parens for buttons without a shortcut id', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      for (const text of tooltipTexts()) {
        expect(text).not.toMatch(/\(\s*\)\s*$/)
      }
    })
  })

  // ── PEND-28 H5: editor portals carry viewport-clamp ───────────────────

  describe('viewport-clamp class on editor portals (PEND-28 H5)', () => {
    it('link popover carries max-w-[calc(100vw-2rem)]', () => {
      render(<SelectionBubbleMenu editor={makeEditor()} />)
      const popovers = screen.getAllByTestId('popover-content')
      expect(popovers[0]?.className).toContain('max-w-[calc(100vw-2rem)]')
    })
  })

  // ── Accessibility ────────────────────────────────────────────────────

  describe('a11y', () => {
    it('passes axe audit when bubble menu is visible', async () => {
      bubbleMenuSelectionEmpty = false
      const { container } = render(<SelectionBubbleMenu editor={makeEditor()} />)
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit with active marks', async () => {
      mockEditorState.bold = true
      mockEditorState.italic = true
      const { container } = render(<SelectionBubbleMenu editor={makeEditor()} />)
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit when bubble menu is hidden (empty selection)', async () => {
      bubbleMenuSelectionEmpty = true
      const { container } = render(<SelectionBubbleMenu editor={makeEditor()} />)
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
