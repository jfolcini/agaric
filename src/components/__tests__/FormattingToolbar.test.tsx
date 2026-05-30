/**
 * Tests for FormattingToolbar component.
 *
 * Validates the always-visible toolbar (post PEND-33 Layer A) — refs +
 * structure + metadata + history. Mark toggles + External Link are tested
 * separately in `SelectionBubbleMenu.test.tsx`.
 *
 * Validates:
 *  - Renders all 17 always-visible buttons (Internal link, Tag, Blockquote,
 *    Code block, Heading, Ordered list, Divider, Callout, Cycle priority,
 *    Date, Due Date, Scheduled Date, TODO, Properties, Undo, Redo, Discard)
 *  - Active states get aria-pressed=true + bg-accent
 *  - Undo/Redo disabled state reflects editor.can()
 *  - Clicking buttons calls the correct editor chain commands
 *  - Uses onPointerDown (not onClick) with preventDefault
 *  - Separators between button groups
 *  - Cycle priority button shows current priority state
 *  - Code block + Heading popovers open on click
 *  - a11y: role=toolbar, aria-labels, axe audit
 */

import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '../../lib/i18n'
import { FormattingToolbar } from '../FormattingToolbar'

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock useEditorState to return controlled state
const mockEditorState = {
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

// `CodeLanguageSelector` routes through this helper (see
// `toggle-code-block-safely.ts`). Forward to the editor's `chain()` —
// minus the `.focus('end')` re-anchor (which is the upstream tiptap
// 3.23.6 workaround) — so the existing mock chain assertions
// (`mockToggleCodeBlock`, `mockUpdateAttributes`, `mockRun`) continue
// to fire exactly as if `editor.chain().focus().toggleCodeBlock(attrs).updateAttributes(...).run()`
// were called directly. The helper itself is unit-tested in
// `src/editor/__tests__/use-roving-editor.test.ts`.
vi.mock('@/editor/toggle-code-block-safely', () => ({
  toggleCodeBlockSafely: (editor: { chain: () => unknown }, attributes?: unknown) => {
    // oxlint-disable-next-line typescript/no-explicit-any -- traversing the test's mock chain
    const c = editor.chain() as any
    if (attributes) {
      c.focus().toggleCodeBlock().updateAttributes('codeBlock', attributes).run()
    } else {
      c.focus().toggleCodeBlock().run()
    }
  },
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
    ...rest
  }: {
    children: React.ReactNode
    align?: string
    className?: string
    [key: string]: unknown
  }) => {
    // Forward unknown props (data-testid, data-editor-portal, id, …) so
    // the overflow popover (which sets its own data-testid) keeps its
    // identity. When no caller-supplied testid is present the mock
    // defaults to 'popover-content' for parity with previous behaviour.
    const callerTestId = (rest as Record<string, unknown>)['data-testid']
    return (
      <div className={className} {...rest} data-testid={callerTestId ?? 'popover-content'}>
        {children}
      </div>
    )
  },
}))

// ── Editor mock helpers ──────────────────────────────────────────────────

const mockRun = vi.fn()
const mockToggleCodeBlock = vi.fn(() => ({ run: mockRun, updateAttributes: mockUpdateAttributes }))
const mockToggleBlockquote = vi.fn(() => ({ run: mockRun }))
const mockToggleHeading = vi.fn(() => ({ run: mockRun }))
const mockInsertContent = vi.fn(() => ({ run: mockRun }))
const mockUndo = vi.fn(() => ({ run: mockRun }))
const mockRedo = vi.fn(() => ({ run: mockRun }))
const mockUpdateAttributes = vi.fn(() => ({ run: mockRun }))
const mockFocus = vi.fn(() => ({
  toggleCodeBlock: mockToggleCodeBlock,
  toggleBlockquote: mockToggleBlockquote,
  toggleHeading: mockToggleHeading,
  insertContent: mockInsertContent,
  undo: mockUndo,
  redo: mockRedo,
  updateAttributes: mockUpdateAttributes,
}))
const mockChain = vi.fn(() => ({
  focus: mockFocus,
}))
const mockGetAttributes = vi.fn(() => ({}))
const mockResolve = vi.fn(() => ({}))
const mockTextBetween = vi.fn(() => '')
const mockIsActive = vi.fn(() => false)
const mockResolveBlockLinkFromSelection = vi.fn(() => true)

function makeEditor() {
  return {
    chain: mockChain,
    getAttributes: mockGetAttributes,
    isActive: mockIsActive,
    commands: {
      resolveBlockLinkFromSelection: mockResolveBlockLinkFromSelection,
    },
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
    view: { dom: document.createElement('div') },
  } as never
}

describe('FormattingToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    popoverIdx = 0
    mockEditorState.codeBlock = false
    mockEditorState.codeBlockLanguage = ''
    mockEditorState.blockquote = false
    mockEditorState.headingLevel = 0
    mockEditorState.canUndo = false
    mockEditorState.canRedo = false
    mockGetAttributes.mockReturnValue({})
    mockResolve.mockReturnValue({})
    mockTextBetween.mockReturnValue('')
    mockIsActive.mockReturnValue(false)
  })

  // ── Rendering ────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders as an always-visible toolbar div', () => {
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)
      expect(container.querySelector('.formatting-toolbar')).toBeInTheDocument()
    })

    it('has role="toolbar" with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: t('toolbar.formatting') })
      expect(toolbar).toBeInTheDocument()
    })

    it('renders all seventeen always-visible buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      expect(screen.getByRole('button', { name: t('toolbar.internalLink') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.insertTag') })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.blockquote') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.headingLevel') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.orderedList') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.divider') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.callout') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.cyclePriority') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.insertDate') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.setDueDate') })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: t('toolbar.setScheduledDate') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.todoToggle') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.properties') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.undo') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.redo') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.discard') })).toBeInTheDocument()
    })

    it('does not render the moved mark toggles or external link', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // Bold / Italic / Code / Strike / Highlight / External Link all live in
      // SelectionBubbleMenu now (PEND-33 Layer A).
      expect(screen.queryByRole('button', { name: t('toolbar.bold') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('toolbar.italic') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('toolbar.code') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('toolbar.strikethrough') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('toolbar.highlight') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('toolbar.link') })).toBeNull()
    })

    it('renders separators between button groups', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const seps = screen.getAllByTestId('separator')
      // After PEND-33 Layer A: refs+blocks → structure → priority+metadata
      // → history. Three separators between four groups.
      expect(seps).toHaveLength(3)
      for (const sep of seps) {
        expect(sep).toHaveAttribute('data-orientation', 'vertical')
      }
    })
  })

  // ── Undo/Redo disabled state ─────────────────────────────────────────

  describe('undo/redo state', () => {
    it('disables Undo when canUndo is false', () => {
      mockEditorState.canUndo = false
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.undo') })).toBeDisabled()
    })

    it('enables Undo when canUndo is true', () => {
      mockEditorState.canUndo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.undo') })).not.toBeDisabled()
    })

    it('disables Redo when canRedo is false', () => {
      mockEditorState.canRedo = false
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.redo') })).toBeDisabled()
    })

    it('enables Redo when canRedo is true', () => {
      mockEditorState.canRedo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.redo') })).not.toBeDisabled()
    })
  })

  // ── Button actions ───────────────────────────────────────────────────

  describe('button actions', () => {
    it('triggers undo via editor chain on pointerdown', () => {
      mockEditorState.canUndo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.undo') }))

      expect(mockUndo).toHaveBeenCalled() // no-args by contract
      expect(mockRun).toHaveBeenCalled() // no-args by contract
    })

    it('triggers redo via editor chain on pointerdown', () => {
      mockEditorState.canRedo = true
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.redo') }))

      expect(mockRedo).toHaveBeenCalled() // no-args by contract
      expect(mockRun).toHaveBeenCalled() // no-args by contract
    })

    it('toggles blockquote via editor chain on pointerdown', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.blockquote') }))

      expect(mockToggleBlockquote).toHaveBeenCalled() // no-args by contract
      expect(mockRun).toHaveBeenCalled() // no-args by contract
    })
  })

  // ── Code block popover ──────────────────────────────────────────────

  describe('code block popover', () => {
    it('shows a persistent "Code" label so the button does not read as icon-only (#215 P2-8)', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
      expect(btn.textContent).toContain('Code')
    })

    it('toggles code block via editor chain', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // Code block button is a popover — click opens it, select "Plain text" to toggle
      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
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
      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
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
      mockEditorState.codeBlock = true
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
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.cyclePriority') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('cycle-priority', spy)
    })

    it('shows "P" with no dot when no priority is set', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.cyclePriority') })
      expect(btn.textContent).toBe('P')
      expect(btn.querySelector('.rounded-full')).toBeNull()
      expect(btn).toHaveAttribute('aria-pressed', 'false')
    })

    it('shows "P1" with red dot for priority 1', () => {
      render(<FormattingToolbar editor={makeEditor()} currentPriority="1" />)
      const btn = screen.getByRole('button', { name: t('toolbar.cyclePriority') })
      expect(btn.textContent).toContain('P1')
      const dot = btn.querySelector('.rounded-full')
      expect(dot).toBeInTheDocument()
      expect(dot?.className).toContain('bg-priority-urgent')
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
    })

    it('shows "P2" with yellow dot for priority 2', () => {
      render(<FormattingToolbar editor={makeEditor()} currentPriority="2" />)
      const btn = screen.getByRole('button', { name: t('toolbar.cyclePriority') })
      expect(btn.textContent).toContain('P2')
      const dot = btn.querySelector('.rounded-full')
      expect(dot).toBeInTheDocument()
      expect(dot?.className).toContain('bg-priority-high')
      expect(btn).toHaveAttribute('aria-pressed', 'true')
    })

    it('shows "P3" with blue dot for priority 3', () => {
      render(<FormattingToolbar editor={makeEditor()} currentPriority="3" />)
      const btn = screen.getByRole('button', { name: t('toolbar.cyclePriority') })
      expect(btn.textContent).toContain('P3')
      const dot = btn.querySelector('.rounded-full')
      expect(dot).toBeInTheDocument()
      expect(dot?.className).toContain('bg-priority-normal')
      expect(btn).toHaveAttribute('aria-pressed', 'true')
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.cyclePriority') })
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
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.insertDate') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-date-picker', spy)
    })

    it('date button prevents default to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.insertDate') })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── Internal link button ───────────────────────────────────────────

  describe('internal link button', () => {
    it('inserts [[ into the editor to trigger the block link picker', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.internalLink') }))
      expect(mockInsertContent).toHaveBeenCalledWith('[[')
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.internalLink') })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })

    it('inserts [[ when no text is selected', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.internalLink') }))

      expect(mockInsertContent).toHaveBeenCalledWith('[[')
      expect(mockRun).toHaveBeenCalled() // no-args by contract
      expect(mockResolveBlockLinkFromSelection).not.toHaveBeenCalled()
    })

    it('calls resolveBlockLinkFromSelection when text is selected', () => {
      const editor = makeEditor()
      // oxlint-disable-next-line typescript/no-explicit-any -- test mock mutation
      ;(editor as any).state.selection = { from: 5, to: 15 }

      render(<FormattingToolbar editor={editor} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.internalLink') }))

      expect(mockResolveBlockLinkFromSelection).toHaveBeenCalled() // no-args by contract
      expect(mockInsertContent).not.toHaveBeenCalled()
    })
  })

  // ── Tag button ─────────────────────────────────────────────────────

  describe('tag button', () => {
    it('inserts @ into the editor to trigger the tag picker', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.insertTag') }))
      expect(mockInsertContent).toHaveBeenCalledWith('@')
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.insertTag') })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const prevented = !btn.dispatchEvent(event)
      expect(prevented).toBe(true)
    })
  })

  // ── Tooltip labels (via aria-labels) ───────────────────────────────

  describe('tooltip labels', () => {
    it('all buttons have correct aria-labels', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      expect(screen.getByRole('button', { name: t('toolbar.internalLink') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.insertTag') })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.blockquote') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.headingLevel') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.orderedList') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.divider') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.callout') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.cyclePriority') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.insertDate') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.setDueDate') })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: t('toolbar.setScheduledDate') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.todoToggle') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.undo') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.redo') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.discard') })).toBeInTheDocument()
    })
  })

  // ── #46: aria-controls linking ────────────────────────────────────────

  describe('aria-controls', () => {
    it('sets aria-controls to editor-{blockId} when blockId is provided', () => {
      render(<FormattingToolbar editor={makeEditor()} blockId="B1" />)
      const toolbar = screen.getByRole('toolbar', { name: t('toolbar.formatting') })
      expect(toolbar).toHaveAttribute('aria-controls', 'editor-B1')
    })

    it('does not set aria-controls when blockId is omitted', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: t('toolbar.formatting') })
      expect(toolbar).not.toHaveAttribute('aria-controls')
    })
  })

  // ── #611: Due Date button ─────────────────────────────────────────────

  describe('due date button', () => {
    it('renders with aria-label "Set due date"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.setDueDate') })).toBeInTheDocument()
    })

    it('dispatches open-due-date-picker custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('open-due-date-picker', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.setDueDate') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-due-date-picker', spy)
    })
  })

  // ── #631: Scheduled Date button ─────────────────────────────────────────

  describe('scheduled date button', () => {
    it('renders with aria-label "Set scheduled date"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(
        screen.getByRole('button', { name: t('toolbar.setScheduledDate') }),
      ).toBeInTheDocument()
    })

    it('dispatches open-scheduled-date-picker custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('open-scheduled-date-picker', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.setScheduledDate') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('open-scheduled-date-picker', spy)
    })
  })

  // ── #612: TODO cycle button ───────────────────────────────────────────

  describe('TODO cycle button', () => {
    it('renders with aria-label "Toggle TODO state"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.todoToggle') })).toBeInTheDocument()
    })

    it('dispatches toggle-todo-state custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('toggle-todo-state', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.todoToggle') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('toggle-todo-state', spy)
    })
  })

  // ── UX-90: Structure buttons (Ordered List, Divider, Callout) ─────────

  describe('structure buttons', () => {
    it('renders Ordered list button with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.orderedList') })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', t('toolbar.orderedList'))
    })

    it('renders Divider button with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.divider') })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', t('toolbar.divider'))
    })

    it('renders Callout button with aria-label', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.callout') })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', t('toolbar.callout'))
    })

    it('dispatches insert-ordered-list event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('insert-ordered-list', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.orderedList') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('insert-ordered-list', spy)
    })

    it('dispatches insert-divider event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('insert-divider', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.divider') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('insert-divider', spy)
    })

    it('callout button opens a type picker; selecting a variant dispatches insert-callout with the type (#215)', () => {
      const spy = vi.fn()
      document.addEventListener('insert-callout', spy as EventListener)
      render(<FormattingToolbar editor={makeEditor()} />)
      // The button now opens a popover of the 5 variants (mock renders content
      // inline); selecting one dispatches the chosen type.
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.callout') }))
      fireEvent.pointerDown(screen.getByTestId('callout-type-warning'))
      expect(spy).toHaveBeenCalledOnce()
      expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({
        type: 'warning',
      })
      document.removeEventListener('insert-callout', spy as EventListener)
    })

    it('prevents default on pointerdown to preserve editor focus', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      for (const label of [t('toolbar.orderedList'), t('toolbar.divider'), t('toolbar.callout')]) {
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
      const btn = screen.getByRole('button', { name: t('toolbar.headingLevel') })
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-pressed', 'true')
      expect(btn.className).toContain('bg-accent')
      expect(btn.textContent).toContain('2')
    })

    it('heading button uses icon-xs size matching other toolbar buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.headingLevel') })
      // icon-xs size class includes size-6
      expect(btn.className).toContain('size-6')
    })

    it('shows H1-H6 and Paragraph options in popover content', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // The popover content is always rendered in our mock
      const popoverContents = screen.getAllByTestId('popover-content')
      // The heading popover is the second popover-content (after code block)
      const headingPopover = popoverContents[1] as HTMLElement
      expect(headingPopover).toBeInTheDocument()
      for (let i = 1; i <= 6; i++) {
        expect(headingPopover.textContent).toContain(`H${i}`)
      }
      expect(headingPopover.textContent).toContain(t('toolbar.paragraph'))
    })
  })

  // ── #590-A4: Discard button ───────────────────────────────────────────

  describe('discard button', () => {
    it('renders with aria-label "Discard changes"', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.discard') })).toBeInTheDocument()
    })

    it('dispatches discard-block-edit custom event on pointerdown', () => {
      const spy = vi.fn()
      document.addEventListener('discard-block-edit', spy)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.discard') }))
      expect(spy).toHaveBeenCalledOnce()
      document.removeEventListener('discard-block-edit', spy)
    })
  })

  // ── #590-B7: Toolbar overflow handling ────────────────────────────────

  describe('toolbar overflow', () => {
    it('renders toolbar with formatting role', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByRole('toolbar', { name: t('toolbar.formatting') })
      expect(toolbar).toBeInTheDocument()
      expect(toolbar).toHaveClass('formatting-toolbar')
    })

    it('does not render the More overflow trigger when nothing overflows', () => {
      // Default jsdom container width is 0 → hook returns all visible,
      // no overflow trigger rendered (PEND-33 Layer B).
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.queryByRole('button', { name: t('toolbar.more') })).toBeNull()
    })

    it('renders an off-screen sentinel for ResizeObserver-driven measurement', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const sentinel = screen.getByTestId('toolbar-sentinel')
      expect(sentinel).toBeInTheDocument()
      expect(sentinel).toHaveAttribute('aria-hidden', 'true')
      // Each item in the flattened list (18 buttons + 3 separators = 21)
      // must have a measurable child carrying its data-toolbar-item-key.
      // (#213 PR4 added the insert-block-ref button.)
      const measurableChildren = sentinel.querySelectorAll('[data-toolbar-item-key]')
      expect(measurableChildren.length).toBe(21)
    })
  })

  // ── PEND-33 L9: Overflow popover (priority-driven) ────────────────────

  describe('PEND-33 Layer B overflow popover', () => {
    /**
     * Force the `useToolbarOverflow` hook into the overflowed branch by
     * injecting a non-no-op `ResizeObserver` that fires a tight content
     * width at observe-time, plus a per-element width spy on the
     * sentinel children. The spy reads from `data-toolbar-item-key`
     * (set by the toolbar) and falls back to 30 px when not specified.
     */
    function withTightLayout(containerWidth: number, opts?: { itemWidth?: number }): () => void {
      const itemWidth = opts?.itemWidth ?? 40
      const Original = globalThis.ResizeObserver
      class FiringRO {
        cb: ResizeObserverCallback
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb
        }
        observe(target: Element): void {
          // Synthetic entry — fire on next microtask so the React render
          // has settled.
          queueMicrotask(() => {
            this.cb(
              [
                {
                  contentRect: { width: containerWidth, height: 0 },
                  target,
                } as unknown as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver,
            )
          })
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal('ResizeObserver', FiringRO)
      const spy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          // Only return non-zero for sentinel item wrappers.
          if (this.hasAttribute('data-toolbar-item-key')) {
            return { width: itemWidth, height: 0 } as DOMRect
          }
          return { width: 0, height: 0 } as DOMRect
        })
      return () => {
        vi.stubGlobal('ResizeObserver', Original)
        spy.mockRestore()
      }
    }

    it('renders the More trigger when items do not all fit', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        // Wait a microtask for the synthetic ResizeObserver fire + state update.
        await new Promise((r) => setTimeout(r, 0))
        const moreBtn = await screen.findByRole('button', { name: t('toolbar.more') })
        expect(moreBtn).toBeInTheDocument()
        expect(moreBtn).toHaveAttribute('aria-haspopup', 'dialog')
        expect(moreBtn).toHaveAttribute('aria-expanded', 'false')
        expect(moreBtn).toHaveAttribute('aria-controls')
      } finally {
        restore()
      }
    })

    it('More trigger flips aria-expanded after click', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        const moreBtn = await screen.findByRole('button', { name: t('toolbar.more') })
        expect(moreBtn).toHaveAttribute('aria-expanded', 'false')
        fireEvent.pointerDown(moreBtn)
        expect(moreBtn).toHaveAttribute('aria-expanded', 'true')
      } finally {
        restore()
      }
    })

    it('overflow popover surfaces the lowest-priority items first (Discard ahead of higher-priority buttons)', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })
        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        // Discard has priority 30 — the lowest of the 17-button set, so
        // it must be present in the overflow.
        const discardInOverflow = Array.from(overflowMenu.querySelectorAll('button')).find(
          (b) => b.getAttribute('aria-label') === t('toolbar.discard'),
        )
        expect(discardInOverflow).toBeDefined()
      } finally {
        restore()
      }
    })

    it('Undo/Redo (priority 100) NEVER move into the overflow popover', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })
        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        const overflowLabels = Array.from(overflowMenu.querySelectorAll('button')).map((b) =>
          b.getAttribute('aria-label'),
        )
        expect(overflowLabels).not.toContain(t('toolbar.undo'))
        expect(overflowLabels).not.toContain(t('toolbar.redo'))
      } finally {
        restore()
      }
    })

    it('clicking an overflow row dispatches the underlying action', async () => {
      const restore = withTightLayout(120)
      try {
        const spy = vi.fn()
        document.addEventListener('insert-divider', spy)
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })
        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        const dividerRow = Array.from(overflowMenu.querySelectorAll('button')).find(
          (b) => b.getAttribute('aria-label') === t('toolbar.divider'),
        ) as HTMLElement | undefined
        expect(dividerRow).toBeDefined()
        if (dividerRow) {
          fireEvent.pointerDown(dividerRow)
        }
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'insert-divider' }))
        document.removeEventListener('insert-divider', spy)
      } finally {
        restore()
      }
    })

    it('callout overflow row opens the type picker; selecting a variant dispatches the type (#215)', async () => {
      const restore = withTightLayout(120)
      try {
        const spy = vi.fn()
        document.addEventListener('insert-callout', spy as EventListener)
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })
        fireEvent.pointerDown(screen.getByTestId('callout-type-tip'))
        expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({ type: 'tip' })
        document.removeEventListener('insert-callout', spy as EventListener)
      } finally {
        restore()
      }
    })

    it('overflow popover uses MenuPopoverContent canonical width via data-editor-portal', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })
        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        // MenuPopoverContent emits the canonical menu width.
        expect(overflowMenu.className).toContain('w-64')
        // data-editor-portal lets the editor's click-outside detection
        // treat the overflow popover the same as the existing
        // heading / code-block popovers.
        expect(overflowMenu).toHaveAttribute('data-editor-portal')
      } finally {
        restore()
      }
    })

    it('heading popover inside overflow closes both popovers on H2 selection (MAINT-221)', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })

        const moreBtn = screen.getByRole('button', { name: t('toolbar.more') })
        fireEvent.pointerDown(moreBtn)
        expect(moreBtn).toHaveAttribute('aria-expanded', 'true')

        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        const headingBtn = Array.from(overflowMenu.querySelectorAll('button')).find(
          (b) => b.getAttribute('aria-label') === t('toolbar.headingLevel'),
        ) as HTMLElement | undefined
        expect(headingBtn).toBeDefined()

        const headingPopover = (headingBtn as Element).closest('[data-popover]') as HTMLElement

        expect(headingPopover).toHaveAttribute('data-open', 'false')

        fireEvent.pointerDown(headingBtn as Element)
        expect(headingPopover).toHaveAttribute('data-open', 'true')

        const h2Btn = Array.from(headingPopover.querySelectorAll('button')).find(
          (b) => b.textContent === 'H2',
        ) as HTMLElement | undefined
        expect(h2Btn).toBeDefined()
        fireEvent.pointerDown(h2Btn as Element)

        expect(headingPopover).toHaveAttribute('data-open', 'false')
        expect(overflowMenu.closest('[data-popover]')).toHaveAttribute('data-open', 'false')
      } finally {
        restore()
      }
    })

    it('code block popover inside overflow closes both popovers on Plain text selection (MAINT-221)', async () => {
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })

        const moreBtn = screen.getByRole('button', { name: t('toolbar.more') })
        fireEvent.pointerDown(moreBtn)

        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        const codeBtn = Array.from(overflowMenu.querySelectorAll('button')).find(
          (b) => b.getAttribute('aria-label') === t('toolbar.codeBlockLanguage'),
        ) as HTMLElement | undefined
        expect(codeBtn).toBeDefined()

        const codePopover = (codeBtn as Element).closest('[data-popover]') as HTMLElement

        expect(codePopover).toHaveAttribute('data-open', 'false')

        fireEvent.pointerDown(codeBtn as Element)
        expect(codePopover).toHaveAttribute('data-open', 'true')

        const plainTextBtn = Array.from(codePopover.querySelectorAll('button')).find(
          (b) => b.textContent === 'Plain text',
        ) as HTMLElement | undefined
        expect(plainTextBtn).toBeDefined()
        fireEvent.pointerDown(plainTextBtn as Element)

        expect(codePopover).toHaveAttribute('data-open', 'false')
        expect(overflowMenu.closest('[data-popover]')).toHaveAttribute('data-open', 'false')
      } finally {
        restore()
      }
    })
  })

  // ── UX-62: Code block language popover ────────────────────────────────

  describe('code block language popover', () => {
    it('renders code block language popover button', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
      expect(btn).toBeInTheDocument()
    })

    it('opens code block language popover on click', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
      const popover = btn.closest('[data-popover]') as HTMLElement
      expect(popover).toHaveAttribute('data-open', 'false')

      fireEvent.pointerDown(btn)

      const popoverAfter = screen
        .getByRole('button', { name: t('toolbar.codeBlockLanguage') })
        .closest('[data-popover]') as HTMLElement
      expect(popoverAfter).toHaveAttribute('data-open', 'true')
    })

    it('shows language options in popover content', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const popoverContents = screen.getAllByTestId('popover-content')
      // The code block popover is the first PopoverContent now (External Link
      // moved to SelectionBubbleMenu in PEND-33 Layer A).
      const codeBlockPopover = popoverContents[0] as HTMLElement
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
      const codeBlockPopover = popoverContents[0] as HTMLElement
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
      const codeBlockPopover = popoverContents[0] as HTMLElement
      const buttons = codeBlockPopover.querySelectorAll('button')
      const jsBtn = Array.from(buttons).find((b) => b.textContent === 'javascript')
      expect(jsBtn).toBeDefined()

      fireEvent.pointerDown(jsBtn as HTMLElement)

      expect(mockToggleCodeBlock).toHaveBeenCalled() // no-args by contract
      expect(mockUpdateAttributes).toHaveBeenCalledWith('codeBlock', { language: 'javascript' })
    })

    it('updates language when already in code block', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'python'
      render(<FormattingToolbar editor={makeEditor()} />)

      const popoverContents = screen.getAllByTestId('popover-content')
      const codeBlockPopover = popoverContents[0] as HTMLElement
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

      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
      expect(btn.textContent).toContain('JS')
    })

    it('shows short label for typescript', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'typescript'
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
      expect(btn.textContent).toContain('TS')
    })

    it('does not show short label when no language is set', () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = ''
      render(<FormattingToolbar editor={makeEditor()} />)

      const btn = screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') })
      // Should only have the icon, no text label
      expect(btn.querySelector('.text-\\[10px\\]')).toBeNull()
    })

    it('a11y: no violations with code block popover open', async () => {
      mockEditorState.codeBlock = true
      mockEditorState.codeBlockLanguage = 'python'
      const { container } = render(<FormattingToolbar editor={makeEditor()} />)

      // Open the popover
      fireEvent.pointerDown(screen.getByRole('button', { name: t('toolbar.codeBlockLanguage') }))

      expect(await axe(container)).toHaveNoViolations()
    })
  })

  // ── PEND-28 H5: editor portals carry viewport-clamp ───────────────────
  // Each `data-editor-portal` PopoverContent must declare
  // `max-w-[calc(100vw-2rem)]` so it never overflows the viewport on
  // narrow screens (mirrors the Radix baseline in `ui/popover.tsx`).
  describe('viewport-clamp class on editor portals (PEND-28 H5)', () => {
    it('code-block language popover carries max-w-[calc(100vw-2rem)]', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const popovers = screen.getAllByTestId('popover-content')
      // Code-block popover is the first PopoverContent (External link moved
      // to SelectionBubbleMenu in PEND-33 Layer A).
      expect(popovers[0]?.className).toContain('max-w-[calc(100vw-2rem)]')
    })

    it('heading-level popover carries max-w-[calc(100vw-2rem)]', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const popovers = screen.getAllByTestId('popover-content')
      // Heading popover is the second PopoverContent.
      expect(popovers[1]?.className).toContain('max-w-[calc(100vw-2rem)]')
    })
  })
})
