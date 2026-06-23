/**
 * Tests for FormattingToolbar component.
 *
 * Validates the always-visible toolbar (post Layer A) — refs +
 * structure + metadata + history. Mark toggles + External Link are tested
 * separately in `SelectionBubbleMenu.test.tsx`.
 *
 * Validates:
 *  - Renders all 18 always-visible buttons (Format, Internal link, Tag,
 *    Blockquote, Code block, Heading, Ordered list, Divider, Callout, Cycle
 *    priority, Date, Due Date, Scheduled Date, TODO, Properties, Undo, Redo,
 *    Discard)
 *  - Active states get aria-pressed=true + bg-accent
 *  - Undo/Redo disabled state reflects editor.can()
 *  - Clicking buttons calls the correct editor chain commands
 *  - Uses onPointerDown (not onClick) with preventDefault
 *  - Separators between button groups
 *  - Cycle priority button shows current priority state
 *  - Code block + Heading popovers open on click
 *  - a11y: role=toolbar, aria-labels, axe audit
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '../../lib/i18n'
import { resetAllShortcuts, setCustomShortcut } from '../../lib/keyboard-config'
import type { ToolbarButtonConfig } from '../../lib/toolbar-config'
import { FormattingToolbar } from '../FormattingToolbar'
import { renderConfigButton, TOOLBAR_SHORTCUT_IDS } from '../FormattingToolbar/shared'

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock useEditorState to return controlled state
const mockEditorState = {
  codeBlock: false,
  codeBlockLanguage: '',
  blockquote: false,
  headingLevel: 0,
  isInsideTable: false,
  canUndo: false,
  canRedo: false,
}

vi.mock('@tiptap/react', () => ({
  useEditorState: () => mockEditorState,
}))

// #925 f3 — control coarse-pointer (touch) detection so the desktop suite stays
// on the inline layout and the touch test exercises the viewport-pinned path.
let mockIsTouch = false
vi.mock('@/hooks/useIsTouch', () => ({
  useIsTouch: () => mockIsTouch,
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
// The label inline so tests can assert on tooltip text.
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
    mockIsTouch = false
    mockEditorState.codeBlock = false
    mockEditorState.codeBlockLanguage = ''
    mockEditorState.blockquote = false
    mockEditorState.headingLevel = 0
    mockEditorState.isInsideTable = false
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

    it('renders the always-visible buttons; standalone block buttons are replaced by Turn into', () => {
      render(<FormattingToolbar editor={makeEditor()} />)

      // Present: Format + Turn into (#1960) lead the toolbar, then refs,
      // metadata, and history.
      for (const key of [
        'toolbar.format',
        'toolbar.turnInto',
        'toolbar.internalLink',
        'toolbar.insertTag',
        'toolbar.cyclePriority',
        'toolbar.insertDate',
        'toolbar.setDueDate',
        'toolbar.setScheduledDate',
        'toolbar.todoToggle',
        'toolbar.properties',
        'toolbar.undo',
        'toolbar.redo',
        'toolbar.discard',
      ]) {
        expect(screen.getByRole('button', { name: t(key) })).toBeInTheDocument()
      }

      // #1960 — the standalone block buttons were REPLACED by the Turn into
      // menu, so they no longer exist as toolbar buttons. (Their transforms
      // live inside the Turn into popover as menuitemradio entries, not buttons.)
      for (const key of [
        'toolbar.codeBlockLanguage',
        'toolbar.blockquote',
        'toolbar.headingLevel',
        'toolbar.orderedList',
        'toolbar.divider',
        'toolbar.callout',
      ]) {
        expect(screen.queryByRole('button', { name: t(key) })).toBeNull()
      }
    })

    it('exposes the mark toggles via the Format popover, not as inline buttons', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // #1958 — the mark toggles live inside the Format popover (and the
      // selection bubble), never as inline toolbar buttons. The Popover mock
      // always renders its content, so the toggles are in the DOM — but scoped
      // to the Format group, not the toolbar surface itself.
      const formatGroup = screen.getByRole('toolbar', { name: t('toolbar.format') })
      expect(
        within(formatGroup).getByRole('button', { name: t('toolbar.bold') }),
      ).toBeInTheDocument()
      expect(
        within(formatGroup).getByRole('button', { name: t('toolbar.italic') }),
      ).toBeInTheDocument()
      expect(
        within(formatGroup).getByRole('button', { name: t('toolbar.code') }),
      ).toBeInTheDocument()
      expect(
        within(formatGroup).getByRole('button', { name: t('toolbar.strikethrough') }),
      ).toBeInTheDocument()
      expect(
        within(formatGroup).getByRole('button', { name: t('toolbar.highlight') }),
      ).toBeInTheDocument()
      expect(
        within(formatGroup).getByRole('button', { name: t('toolbar.underline') }),
      ).toBeInTheDocument()
      // External Link still lives ONLY in the selection bubble — not in the
      // Format popover or the toolbar.
      expect(screen.queryByRole('button', { name: t('toolbar.link') })).toBeNull()
    })

    it('renders separators between button groups', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const seps = screen.getAllByTestId('separator')
      // After Layer A: refs+blocks → structure → priority+metadata
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
  })

  // ── Turn into menu (#1960) ───────────────────────────────────────────

  describe('turn into menu', () => {
    it('renders the Turn into button', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.getByRole('button', { name: t('toolbar.turnInto') })).toBeInTheDocument()
    })

    it('lists block-type transforms as menuitemradio entries', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      // The Popover mock always renders content, so the menu is in the DOM.
      const menu = screen.getByRole('menu', { name: t('toolbar.turnInto') })
      for (const key of [
        'contextMenu.turnIntoType.bulletList',
        'contextMenu.turnIntoType.numberedList',
        'contextMenu.turnIntoType.quote',
        'contextMenu.turnIntoType.code',
        'contextMenu.turnIntoType.callout',
      ]) {
        expect(within(menu).getByRole('menuitemradio', { name: t(key) })).toBeInTheDocument()
      }
    })

    it('dispatches turn-into-block with the chosen type on pointerdown', () => {
      const events: CustomEvent[] = []
      const handler = (e: Event) => events.push(e as CustomEvent)
      document.addEventListener('turn-into-block', handler)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(
        screen.getByRole('menuitemradio', { name: t('contextMenu.turnIntoType.bulletList') }),
      )
      document.removeEventListener('turn-into-block', handler)
      expect(events).toHaveLength(1)
      expect(events[0]?.detail).toEqual({ type: 'bullet-list' })
    })

    it('dispatches insert-divider for the Divider entry', () => {
      const events: CustomEvent[] = []
      const handler = (e: Event) => events.push(e as CustomEvent)
      document.addEventListener('insert-divider', handler)
      render(<FormattingToolbar editor={makeEditor()} />)
      fireEvent.pointerDown(screen.getByRole('menuitem', { name: t('toolbar.divider') }))
      document.removeEventListener('insert-divider', handler)
      expect(events).toHaveLength(1)
    })

    it('marks the active block type as checked', () => {
      mockEditorState.headingLevel = 2
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(
        screen.getByRole('menuitemradio', { name: t('contextMenu.turnIntoType.h2') }),
      ).toHaveAttribute('aria-checked', 'true')
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

    it('shows "P" with a neutral hollow dot when no priority is set (#217)', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const btn = screen.getByRole('button', { name: t('toolbar.cyclePriority') })
      expect(btn.textContent).toBe('P')
      // #217 — unset renders a hollow outline dot (interactive "no priority"
      // affordance), NOT a colored priority dot and NOT nothing.
      const dot = btn.querySelector('.rounded-full')
      expect(dot).not.toBeNull()
      expect(dot?.className).toContain('border')
      expect(dot?.className).not.toContain('bg-priority')
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

      expect(screen.getByRole('button', { name: t('toolbar.format') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.turnInto') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.internalLink') })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('toolbar.insertTag') })).toBeInTheDocument()
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
      // No overflow trigger rendered (Layer B).
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.queryByRole('button', { name: t('toolbar.more') })).toBeNull()
    })

    it('renders an off-screen sentinel for ResizeObserver-driven measurement', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      const sentinel = screen.getByTestId('toolbar-sentinel')
      expect(sentinel).toBeInTheDocument()
      expect(sentinel).toHaveAttribute('aria-hidden', 'true')
      // Each item in the flattened list (17 buttons + 3 separators = 20) must
      // have a measurable child carrying its data-toolbar-item-key. #1960
      // replaced the 6 standalone block buttons (code/heading/blockquote/
      // ordered-list/divider/callout) with the single Format + Turn into pair,
      // dropping the count from 21 buttons to 16; #281 then added the emoji
      // button, bringing it to 17.
      const measurableChildren = sentinel.querySelectorAll('[data-toolbar-item-key]')
      expect(measurableChildren.length).toBe(20)
    })
  })

  // ── Overflow popover (priority-driven) ────────────────────

  describe(' Layer B overflow popover', () => {
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

    it('#217 A2 — overflow popover renders dividers between groups', async () => {
      // Very tight layout → most buttons overflow, spanning multiple toolbar
      // groups, so at least one inter-group divider must render (the popover
      // is no longer a flat ungrouped list).
      const restore = withTightLayout(120)
      try {
        render(<FormattingToolbar editor={makeEditor()} />)
        await screen.findByRole('button', { name: t('toolbar.more') })
        const overflowMenu = screen.getByTestId('toolbar-overflow-menu')
        const dividers = overflowMenu.querySelectorAll('[data-testid="overflow-group-divider"]')
        expect(dividers.length).toBeGreaterThan(0)
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
  })

  // ── Table ops (#215) — contextual trigger ──────────────────────────────
  describe('table operations trigger', () => {
    it('is absent when the selection is not inside a table', () => {
      render(<FormattingToolbar editor={makeEditor()} />)
      expect(screen.queryByRole('button', { name: 'Table' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('table-op-delete-table')).not.toBeInTheDocument()
    })

    it('appears when the selection is inside a table cell', () => {
      mockEditorState.isInsideTable = true
      render(<FormattingToolbar editor={makeEditor()} />)
      // The trigger button (label "Table") is present...
      expect(screen.getAllByRole('button', { name: 'Table' }).length).toBeGreaterThan(0)
      // ...and the popover content exposes the row/column/table operations.
      expect(screen.getByTestId('table-op-insert-row-above')).toBeInTheDocument()
      expect(screen.getByTestId('table-op-insert-column-right')).toBeInTheDocument()
      expect(screen.getByTestId('table-op-delete-row')).toBeInTheDocument()
      expect(screen.getByTestId('table-op-delete-table')).toBeInTheDocument()
    })
  })

  // ── #925 f3 — pin the touch toolbar above the soft keyboard ─────────────
  //
  // On coarse-pointer (touch) the inline per-block toolbar is repositioned to
  // `position: fixed` at the layout-viewport bottom and lifted above the soft
  // keyboard via `visualViewport`. Desktop keeps the inline (`relative`) layout.
  // NOTE: final on-device placement wants a real-hardware eyeball — only the
  // positioning *logic* is unit-tested here.
  describe('#925 f3 — viewport-pinned toolbar on touch', () => {
    const realVV = Object.getOwnPropertyDescriptor(window, 'visualViewport')

    function mockVisualViewport(height: number): void {
      const listeners: Record<string, Set<() => void>> = {}
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: {
          height,
          offsetTop: 0,
          addEventListener: (type: string, cb: () => void) => {
            ;(listeners[type] ??= new Set()).add(cb)
          },
          removeEventListener: (type: string, cb: () => void) => {
            listeners[type]?.delete(cb)
          },
        },
      })
    }

    afterEach(() => {
      if (realVV) Object.defineProperty(window, 'visualViewport', realVV)
      else Reflect.deleteProperty(window, 'visualViewport')
    })

    it('desktop keeps the inline (relative) layout — not pinned', () => {
      mockIsTouch = false
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByTestId('formatting-toolbar')
      expect(toolbar.className).toContain('relative')
      expect(toolbar.className).not.toContain('fixed')
      expect(toolbar).not.toHaveAttribute('data-pinned')
    })

    it('touch pins the toolbar fixed at the viewport bottom', () => {
      mockIsTouch = true
      // No keyboard: visualViewport height == innerHeight → 0 inset.
      mockVisualViewport(window.innerHeight)
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByTestId('formatting-toolbar')
      expect(toolbar.className).toContain('fixed')
      expect(toolbar.className).not.toContain('relative')
      expect(toolbar).toHaveAttribute('data-pinned', 'true')
      expect(toolbar.style.bottom).toBe('0px')
    })

    it('touch lifts the toolbar above the soft keyboard by the keyboard inset', () => {
      mockIsTouch = true
      // Keyboard up: visualViewport shrank by 300px → bottom offset = 300px.
      mockVisualViewport(window.innerHeight - 300)
      render(<FormattingToolbar editor={makeEditor()} />)
      const toolbar = screen.getByTestId('formatting-toolbar')
      expect(toolbar.style.bottom).toBe('300px')
    })
  })

  // ── #1650 — config-button tooltips resolve shortcuts LIVE from the
  // rebindable catalog (mirroring SelectionBubbleMenu), instead of freezing
  // the chord inside the i18n tip string. ─────────────────────────────────
  describe('#1650 — live shortcut resolution in config-button tooltips', () => {
    // Minimal icon stub so `renderConfigButton` can render <btn.icon /> without
    // pulling in lucide; the tooltip text is what we assert on here.
    const IconStub = (): React.ReactElement => <span data-testid="icon" />

    function makeConfig(label: string, tip: string): ToolbarButtonConfig {
      return {
        icon: IconStub as unknown as ToolbarButtonConfig['icon'],
        label,
        tip,
        action: vi.fn(),
      }
    }

    // The tooltip is mocked (top of file) to render <TooltipContent> inline as
    // a `tooltip-content` testid, so we can read the resolved tooltip string.
    function renderButton(config: ToolbarButtonConfig): string {
      const { getByTestId } = render(
        renderConfigButton(config, {}, 'inline', t) as React.ReactElement,
      )
      return getByTestId('tooltip-content').textContent ?? ''
    }

    beforeEach(() => {
      localStorage.clear()
      resetAllShortcuts()
    })

    afterEach(() => {
      localStorage.clear()
      resetAllShortcuts()
    })

    it('maps the same mark actions to the same catalog ids the bubble menu uses', () => {
      // Mirror of SelectionBubbleMenu's BUBBLE_MENU_SHORTCUT_IDS. Bold/Italic
      // are intentionally absent (TipTap StarterKit defaults, not catalogued).
      expect(TOOLBAR_SHORTCUT_IDS).toEqual({
        'toolbar.code': 'inlineCode',
        'toolbar.strikethrough': 'strikethrough',
        'toolbar.highlight': 'highlight',
      })
    })

    it('renders the LIVE catalog chord (not a frozen i18n string) for a mapped button', () => {
      // 'toolbar.code' → 'inlineCode' (catalog default 'Ctrl + E').
      const tooltip = renderButton(makeConfig('toolbar.code', 'toolbar.codeTip'))
      // Label + live chord, sourced from the catalog — NOT the tip string.
      expect(tooltip).toBe(`${t('toolbar.code')} (Ctrl + E)`)
    })

    it('updates the tooltip when the shortcut is rebound (proves it derives from the catalog)', () => {
      setCustomShortcut('inlineCode', 'Ctrl + Shift + E')
      const tooltip = renderButton(makeConfig('toolbar.code', 'toolbar.codeTip'))
      expect(tooltip).toBe(`${t('toolbar.code')} (Ctrl + Shift + E)`)
      // And it is NOT the old hardcoded i18n chord.
      expect(tooltip).not.toContain('Ctrl+E')
    })

    it('never doubles the chord — the tip string carries no parenthesised chord', () => {
      const tooltip = renderButton(makeConfig('toolbar.code', 'toolbar.codeTip'))
      // Exactly one "(...)" group; the i18n tip no longer embeds a chord.
      expect(tooltip.match(/\(/g) ?? []).toHaveLength(1)
      expect(t('toolbar.codeTip')).toBe('Inline code')
      expect(t('toolbar.strikethroughTip')).toBe('Strikethrough')
      expect(t('toolbar.highlightTip')).toBe('Highlight')
    })

    it('keeps the plain tip for a button without a rebindable shortcut', () => {
      // 'toolbar.divider' is not in TOOLBAR_SHORTCUT_IDS → plain t(btn.tip).
      const tooltip = renderButton(makeConfig('toolbar.divider', 'toolbar.dividerTip'))
      expect(tooltip).toBe(t('toolbar.dividerTip'))
    })
  })
})
