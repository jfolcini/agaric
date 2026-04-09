/**
 * Tests for EditableBlock component.
 *
 * Validates:
 *  - Renders StaticBlock when not focused (isFocused=false)
 *  - Renders EditorContent when focused (isFocused=true)
 *  - handleFocus mounts the roving editor with correct blockId/content
 *  - handleFocus unmounts previous block before mounting new one
 *  - handleBlur unmounts and saves changed content via edit()
 *  - handleBlur calls splitBlock when content contains newlines
 *  - handleBlur does not save when content is unchanged (unmount returns null)
 *  - a11y compliance for both states
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { EDITOR_PORTAL_SELECTORS, EditableBlock } from '../EditableBlock'

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock shouldSplitOnBlur from use-roving-editor — controls split detection
const mockShouldSplitOnBlur = vi.fn((md: string) => md.includes('\n'))
vi.mock('../../editor/use-roving-editor', () => ({
  shouldSplitOnBlur: (...args: unknown[]) => mockShouldSplitOnBlur(...(args as [string])),
}))

// Mock EditorContent — TipTap doesn't render in jsdom so we stub it
vi.mock('@tiptap/react', () => ({
  EditorContent: ({ editor }: { editor: unknown }) =>
    editor != null ? <div data-testid="editor-content">TipTap Editor</div> : null,
}))

// Mock FormattingToolbar — tested separately in FormattingToolbar.test.tsx
vi.mock('../FormattingToolbar', () => ({
  FormattingToolbar: ({ blockId }: { blockId?: string }) => (
    <div data-testid="formatting-toolbar" data-block-id={blockId} />
  ),
}))

// Mock StaticBlock to keep tests focused on EditableBlock logic
vi.mock('../StaticBlock', () => ({
  StaticBlock: ({
    blockId,
    content,
    onFocus,
  }: {
    blockId: string
    content: string
    onFocus: (id: string) => void
  }) => (
    <button type="button" data-testid={`static-block-${blockId}`} onClick={() => onFocus(blockId)}>
      {content}
    </button>
  ),
}))

// Mock Tauri draft functions used by useDraftAutosave
const mockSaveDraft = vi.fn().mockResolvedValue(undefined)
const mockDeleteDraft = vi.fn().mockResolvedValue(undefined)
const mockFlushDraft = vi.fn().mockResolvedValue(undefined)
const mockAddAttachment = vi.fn().mockResolvedValue({
  id: 'ATT_1',
  block_id: 'BLK_1',
  filename: 'test.png',
  mime_type: 'image/png',
  size_bytes: 7,
  fs_path: '/tmp/test.png',
  created_at: '2024-01-01T00:00:00Z',
})
vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual('@/lib/tauri')
  return {
    ...actual,
    saveDraft: (...args: unknown[]) => mockSaveDraft(...args),
    deleteDraft: (...args: unknown[]) => mockDeleteDraft(...args),
    flushDraft: (...args: unknown[]) => mockFlushDraft(...args),
    addAttachment: (...args: unknown[]) => mockAddAttachment(...args),
  }
})

// Mock block store — capture calls to setFocused (focus stays on global store)
const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

const mockEdit = vi.fn()
const mockSplitBlock = vi.fn()
const mockSetFocused = vi.fn()
const _mockBlockStore = {
  setFocused: mockSetFocused,
}
vi.mock('../../stores/blocks', () => ({
  useBlockStore: (selector?: (s: typeof _mockBlockStore) => unknown) =>
    selector ? selector(_mockBlockStore) : _mockBlockStore,
}))

// Mock per-page block store — capture calls to edit, splitBlock
const _mockPageStore = {
  edit: mockEdit,
  splitBlock: mockSplitBlock,
  blocks: [] as Array<{ id: string; priority?: string | null }>,
}
vi.mock('../../stores/page-blocks', () => ({
  usePageBlockStore: (selector?: (s: typeof _mockPageStore) => unknown) =>
    selector ? selector(_mockPageStore) : _mockPageStore,
}))

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a minimal mock roving editor handle. */
function makeRovingEditor(
  overrides: Partial<{
    editor: unknown
    activeBlockId: string | null
    mount: ReturnType<typeof vi.fn>
    unmount: ReturnType<typeof vi.fn>
    getMarkdown: ReturnType<typeof vi.fn>
    originalMarkdown: string
  }> = {},
) {
  return {
    editor: 'editor' in overrides ? overrides.editor : { fake: true },
    mount: overrides.mount ?? vi.fn(),
    unmount: overrides.unmount ?? vi.fn(() => null),
    activeBlockId: overrides.activeBlockId ?? null,
    getMarkdown: overrides.getMarkdown ?? vi.fn(() => null),
    originalMarkdown: overrides.originalMarkdown ?? 'existing content',
  }
}

describe('EditableBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset shouldSplitOnBlur to default behavior (split on newlines)
    mockShouldSplitOnBlur.mockImplementation((md: string) => md.includes('\n'))
    // jsdom does not implement scrollIntoView — stub it globally
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn()
    }
  })

  // ── Conditional rendering ────────────────────────────────────────────

  describe('rendering', () => {
    it('renders StaticBlock when isFocused is false', () => {
      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={false}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      expect(screen.getByTestId('static-block-B1')).toBeInTheDocument()
      expect(screen.queryByTestId('editor-content')).not.toBeInTheDocument()
    })

    it('renders EditorContent when isFocused is true', () => {
      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      expect(screen.getByTestId('editor-content')).toBeInTheDocument()
      expect(screen.queryByTestId('static-block-B1')).not.toBeInTheDocument()
    })

    it('renders nothing for editor when rovingEditor.editor is null', () => {
      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor({ editor: null }) as never}
        />,
      )

      // EditorContent receives null → renders nothing
      expect(screen.queryByTestId('editor-content')).not.toBeInTheDocument()
    })

    it('applies data-block-id attribute on the editor wrapper', () => {
      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('[data-block-id="B1"]')
      expect(wrapper).not.toBeNull()
      expect(wrapper?.classList.contains('block-editor')).toBe(true)
    })
  })

  // ── Focus (click → mount) ────────────────────────────────────────────

  describe('handleFocus', () => {
    it('mounts roving editor on the clicked block with its content', async () => {
      const mockMount = vi.fn()
      const roving = makeRovingEditor({ mount: mockMount })

      render(
        <EditableBlock
          blockId="B1"
          content="Hello world"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      // Click the StaticBlock to focus
      await userEvent.click(screen.getByTestId('static-block-B1'))

      expect(mockSetFocused).toHaveBeenCalledWith('B1')
      expect(mockMount).toHaveBeenCalledWith('B1', 'Hello world')
    })

    it('unmounts previous block before mounting the new one', async () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'changed text')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'PREV_BLOCK',
      })

      render(
        <EditableBlock
          blockId="B2"
          content="New block"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      await userEvent.click(screen.getByTestId('static-block-B2'))

      // Should unmount previous first, then mount new
      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).toHaveBeenCalledWith('PREV_BLOCK', 'changed text')
      expect(mockSetFocused).toHaveBeenCalledWith('B2')
      expect(mockMount).toHaveBeenCalledWith('B2', 'New block')
    })

    it('calls splitBlock for previous block when unmount returns content with newlines', async () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'line1\nline2')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'PREV_BLOCK',
      })

      render(
        <EditableBlock
          blockId="B2"
          content="New"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      await userEvent.click(screen.getByTestId('static-block-B2'))

      expect(mockSplitBlock).toHaveBeenCalledWith('PREV_BLOCK', 'line1\nline2')
      expect(mockEdit).not.toHaveBeenCalled()
    })

    it('does not unmount when there is no previous active block', async () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn()
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: null,
      })

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      await userEvent.click(screen.getByTestId('static-block-B1'))

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockMount).toHaveBeenCalledWith('B1', 'Hello')
    })

    it('does not unmount when clicking the same block that is already active', async () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn()
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      await userEvent.click(screen.getByTestId('static-block-B1'))

      // Should not unmount from itself — only mount
      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockMount).toHaveBeenCalledWith('B1', 'Hello')
    })
  })

  // ── Blur (unmount → save) ────────────────────────────────────────────

  describe('handleBlur', () => {
    it('unmounts and saves when content changed', () => {
      const mockUnmount = vi.fn(() => 'updated text')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate blur on the editor wrapper via React event system
      const wrapper = container.querySelector('.block-editor')
      expect(wrapper).not.toBeNull()
      fireEvent.blur(wrapper as Element)

      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'updated text')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('calls splitBlock when unmounted content contains newlines', () => {
      const mockUnmount = vi.fn(() => 'line1\nline2\nline3')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      expect(wrapper).not.toBeNull()
      fireEvent.blur(wrapper as Element)

      expect(mockSplitBlock).toHaveBeenCalledWith('B1', 'line1\nline2\nline3')
      expect(mockEdit).not.toHaveBeenCalled()
    })

    it('does not save when content is unchanged (unmount returns null)', () => {
      const mockUnmount = vi.fn(() => null)
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="same text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      expect(wrapper).not.toBeNull()
      fireEvent.blur(wrapper as Element)

      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockSplitBlock).not.toHaveBeenCalled()
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('does not unmount when there is no active block', () => {
      const mockUnmount = vi.fn()
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: null,
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      expect(wrapper).not.toBeNull()
      fireEvent.blur(wrapper as Element)

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockSetFocused).not.toHaveBeenCalled()
    })

    it('does not split a code block with internal newlines (B-9)', () => {
      // A fenced code block has newlines but is a single top-level node —
      // shouldSplitOnBlur returns false, so edit() should be called, not splitBlock().
      const codeBlock = '```js\nconst a = 1\nconst b = 2\n```'
      mockShouldSplitOnBlur.mockReturnValue(false)

      const mockUnmount = vi.fn(() => codeBlock)
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      expect(mockShouldSplitOnBlur).toHaveBeenCalledWith(codeBlock)
      expect(mockEdit).toHaveBeenCalledWith('B1', codeBlock)
      expect(mockSplitBlock).not.toHaveBeenCalled()
    })

    it('splits multi-paragraph content on blur (B-9)', () => {
      // Two paragraphs separated by a blank line — shouldSplitOnBlur returns true.
      const multiParagraph = 'paragraph one\n\nparagraph two'
      mockShouldSplitOnBlur.mockReturnValue(true)

      const mockUnmount = vi.fn(() => multiParagraph)
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      expect(mockShouldSplitOnBlur).toHaveBeenCalledWith(multiParagraph)
      expect(mockSplitBlock).toHaveBeenCalledWith('B1', multiParagraph)
      expect(mockEdit).not.toHaveBeenCalled()
    })
  })

  // ── Accessibility ────────────────────────────────────────────────────

  describe('a11y', () => {
    it('passes axe audit when unfocused (StaticBlock)', async () => {
      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={false}
          rovingEditor={makeRovingEditor() as never}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit when focused (EditorContent)', async () => {
      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  // ── Blur guard for popovers ───────────────────────────────────────

  describe('blur guard', () => {
    it('does not unmount when a visible Radix popover is open in the DOM', () => {
      const mockUnmount = vi.fn(() => 'changed')
      const roving = makeRovingEditor({ activeBlockId: 'B1', unmount: mockUnmount })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate a Radix popover being open AND visible in the DOM
      const portal = document.createElement('div')
      portal.setAttribute('data-radix-popper-content-wrapper', '')
      ;(portal as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(portal)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(portal)
    })

    it('unmounts and saves when portal elements exist in DOM but are hidden', () => {
      const mockUnmount = vi.fn(() => 'changed')
      const roving = makeRovingEditor({ activeBlockId: 'B1', unmount: mockUnmount })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate a Radix popover that is in the DOM but hidden
      const portal = document.createElement('div')
      portal.setAttribute('data-radix-popper-content-wrapper', '')
      ;(portal as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false
      document.body.appendChild(portal)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      // Should unmount because the portal is not visible
      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'changed')
      expect(mockSetFocused).toHaveBeenCalledWith(null)

      document.body.removeChild(portal)
    })

    it('does not unmount when relatedTarget is inside a Radix popover', () => {
      const mockUnmount = vi.fn(() => 'changed')
      const roving = makeRovingEditor({ activeBlockId: 'B1', unmount: mockUnmount })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate relatedTarget being inside a Radix popover
      const portal = document.createElement('div')
      portal.setAttribute('data-radix-popper-content-wrapper', '')
      const input = document.createElement('input')
      portal.appendChild(input)
      document.body.appendChild(portal)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: input })

      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(portal)
    })
  })

  // ── #40: scrollIntoView on editor focus ──────────────────────────────

  describe('scrollIntoView on focus', () => {
    it('calls scrollIntoView with block: nearest when focused', async () => {
      const scrollIntoViewMock = vi.fn()

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor') as HTMLElement
      wrapper.scrollIntoView = scrollIntoViewMock

      // The useEffect with requestAnimationFrame fires after render.
      // Flush the rAF callback.
      await vi.waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })
      })
    })

    it('does not call scrollIntoView when not focused', () => {
      const scrollIntoViewMock = vi.fn()
      // Mock scrollIntoView on HTMLElement prototype for unfocused case
      const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
      HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={false}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      // StaticBlock renders instead — no section wrapper, no scrollIntoView
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    })
  })

  // ── #46: editor wrapper id and toolbar blockId ───────────────────────

  describe('aria-controls linking', () => {
    it('applies id="editor-{blockId}" on the editor wrapper section', () => {
      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('#editor-B1')
      expect(wrapper).not.toBeNull()
      expect(wrapper?.tagName).toBe('SECTION')
    })

    it('passes blockId to FormattingToolbar', () => {
      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const toolbar = screen.getByTestId('formatting-toolbar')
      expect(toolbar).toHaveAttribute('data-block-id', 'B1')
    })
  })

  // ── EDITOR_PORTAL_SELECTORS constant ──────────────────────────────

  describe('EDITOR_PORTAL_SELECTORS', () => {
    it('is exported and contains at least 5 entries', () => {
      expect(Array.isArray(EDITOR_PORTAL_SELECTORS)).toBe(true)
      expect(EDITOR_PORTAL_SELECTORS.length).toBeGreaterThanOrEqual(5)
    })

    it('includes expected selectors for suggestion popup and date picker', () => {
      expect(EDITOR_PORTAL_SELECTORS).toContain('.suggestion-popup')
      expect(EDITOR_PORTAL_SELECTORS).toContain('.date-picker-popup')
      expect(EDITOR_PORTAL_SELECTORS).toContain('[data-radix-popper-content-wrapper]')
    })

    it('includes .block-context-menu selector (B-15)', () => {
      expect(EDITOR_PORTAL_SELECTORS).toContain('.block-context-menu')
    })

    it('handleBlur does not unmount when relatedTarget is inside a suggestion popup', () => {
      const mockUnmount = vi.fn(() => 'changed')
      const roving = makeRovingEditor({ activeBlockId: 'B1', unmount: mockUnmount })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate relatedTarget being inside a suggestion popup
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      const btn = document.createElement('button')
      popup.appendChild(btn)
      document.body.appendChild(popup)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: btn })

      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(popup)
    })
  })

  // ── H-11: Auto-mount flushes previous editor ──────────────────────

  describe('auto-mount flush (H-11)', () => {
    it('unmounts and saves previous block on external focus change', () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'unsaved changes')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'OLD_BLOCK',
      })

      // Start unfocused, then re-render with isFocused=true
      const { rerender } = render(
        <EditableBlock
          blockId="B1"
          content="New block"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      rerender(
        <EditableBlock
          blockId="B1"
          content="New block"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Auto-mount effect should unmount old block and save changes
      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).toHaveBeenCalledWith('OLD_BLOCK', 'unsaved changes')
      expect(mockMount).toHaveBeenCalledWith('B1', 'New block')
    })

    it('calls splitBlock when previous block content has newlines', () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'line1\nline2')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'OLD_BLOCK',
      })

      const { rerender } = render(
        <EditableBlock blockId="B1" content="" isFocused={false} rovingEditor={roving as never} />,
      )

      rerender(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      expect(mockSplitBlock).toHaveBeenCalledWith('OLD_BLOCK', 'line1\nline2')
      expect(mockEdit).not.toHaveBeenCalled()
    })

    it('does not unmount when no previous active block', () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn()
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: null,
      })

      const { rerender } = render(
        <EditableBlock
          blockId="B1"
          content="text"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      rerender(
        <EditableBlock
          blockId="B1"
          content="text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      expect(mockUnmount).not.toHaveBeenCalled()
      expect(mockMount).toHaveBeenCalledWith('B1', 'text')
    })

    it('does not unmount when previous content is unchanged (unmount returns null)', () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => null)
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'OLD_BLOCK',
      })

      const { rerender } = render(
        <EditableBlock blockId="B1" content="" isFocused={false} rovingEditor={roving as never} />,
      )

      rerender(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockSplitBlock).not.toHaveBeenCalled()
      expect(mockMount).toHaveBeenCalledWith('B1', '')
    })

    it('auto-mount uses shouldSplitOnBlur, not naive newline check (M-5)', () => {
      // A code block has internal newlines but shouldSplitOnBlur returns false —
      // the auto-mount persist should call edit(), not splitBlock().
      const codeBlock = '```\nline1\nline2\n```'
      mockShouldSplitOnBlur.mockReturnValue(false)

      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => codeBlock)
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'OLD_BLOCK',
      })

      const { rerender } = render(
        <EditableBlock blockId="B1" content="" isFocused={false} rovingEditor={roving as never} />,
      )

      rerender(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      expect(mockShouldSplitOnBlur).toHaveBeenCalledWith(codeBlock)
      expect(mockEdit).toHaveBeenCalledWith('OLD_BLOCK', codeBlock)
      expect(mockSplitBlock).not.toHaveBeenCalled()
    })
  })

  // ── #581: Save content on blur for newly created blocks ───────────

  describe('new block blur save', () => {
    it('saves new block content on blur even when visible popup is in DOM', () => {
      const mockGetMarkdown = vi.fn(() => 'typed text')
      const mockUnmount = vi.fn(() => null)
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
        getMarkdown: mockGetMarkdown,
        originalMarkdown: '',
      })

      const { container } = render(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // Simulate a visible suggestion popup being open in the DOM
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      // Content should be saved even though popup causes early return
      expect(mockGetMarkdown).toHaveBeenCalled()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'typed text')
      // Editor stays mounted (popup guard still triggers early return)
      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(popup)
    })

    it('does not double-save when blur handler runs normally for new blocks', () => {
      const mockGetMarkdown = vi.fn(() => 'typed text')
      const mockUnmount = vi.fn(() => 'typed text')
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
        getMarkdown: mockGetMarkdown,
        originalMarkdown: '',
      })

      const { container } = render(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // No popup in DOM — blur runs fully (early save + unmount save)
      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      // Early save fires once (from the new-block guard)
      // Then unmount fires and saves again — both calls go to edit()
      expect(mockEdit).toHaveBeenCalledWith('B1', 'typed text')
      expect(mockUnmount).toHaveBeenCalledOnce()
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('does not early-save when block had existing content', () => {
      const mockGetMarkdown = vi.fn(() => 'updated')
      const mockUnmount = vi.fn(() => 'updated')
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
        getMarkdown: mockGetMarkdown,
        originalMarkdown: 'original',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Visible popup in the DOM — should early return WITHOUT saving
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      // originalMarkdown is not empty, so the early-save guard should NOT fire
      expect(mockGetMarkdown).not.toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(popup)
    })

    it('does not early-save when getMarkdown returns empty string', () => {
      const mockGetMarkdown = vi.fn(() => '')
      const mockUnmount = vi.fn(() => null)
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        unmount: mockUnmount,
        getMarkdown: mockGetMarkdown,
        originalMarkdown: '',
      })

      const { container } = render(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // Visible popup in DOM — triggers early return
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      // getMarkdown returned empty string — nothing to save
      expect(mockGetMarkdown).toHaveBeenCalled()
      expect(mockEdit).not.toHaveBeenCalled()

      document.body.removeChild(popup)
    })
  })

  // ── B-5 / B-6: flushSync ensures store renders before unmount ─────

  describe('flushSync on blur (B-5, B-6)', () => {
    it('calls edit() before setFocused(null) on blur so StaticBlock sees updated content', () => {
      const callOrder: string[] = []
      mockEdit.mockImplementation(() => {
        callOrder.push('edit')
      })
      mockSetFocused.mockImplementation(() => {
        callOrder.push('setFocused')
      })

      const mockUnmount = vi.fn(() => 'updated text')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      expect(mockEdit).toHaveBeenCalledWith('B1', 'updated text')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
      // edit must be called before setFocused so the store is updated
      // before React transitions to the StaticBlock
      expect(callOrder).toEqual(['edit', 'setFocused'])
    })

    it('calls splitBlock() before setFocused(null) when content has newlines', () => {
      const callOrder: string[] = []
      mockSplitBlock.mockImplementation(() => {
        callOrder.push('splitBlock')
      })
      mockSetFocused.mockImplementation(() => {
        callOrder.push('setFocused')
      })

      const mockUnmount = vi.fn(() => 'line1\nline2')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      expect(mockSplitBlock).toHaveBeenCalledWith('B1', 'line1\nline2')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
      expect(callOrder).toEqual(['splitBlock', 'setFocused'])
    })

    it('content is preserved after blur (not stale/empty) — B-5 regression', () => {
      // Simulate: block has content, user arrows away, blur fires.
      // After blur, edit() must have been called so the store has the latest text.
      const mockUnmount = vi.fn(() => 'ArrowRight content')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="ArrowRight content"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      // The store update must happen (not be skipped or deferred)
      expect(mockEdit).toHaveBeenCalledWith('B1', 'ArrowRight content')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })
  })

  // ── Error paths ──────────────────────────────────────────────────────

  describe('error paths', () => {
    /**
     * Store methods (edit, splitBlock) are called fire-and-forget in the
     * component. In production the store catches internally, but if a
     * rejected promise escapes, the blur / focus sequence must still
     * complete. We suppress unhandled rejections in these tests so they
     * don't pollute the test runner output.
     */
    let rejectHandler: ((e: PromiseRejectionEvent) => void) | null = null

    afterEach(() => {
      if (rejectHandler) {
        window.removeEventListener('unhandledrejection', rejectHandler)
        rejectHandler = null
      }
    })

    function suppressUnhandledRejections() {
      rejectHandler = (e: PromiseRejectionEvent) => e.preventDefault()
      window.addEventListener('unhandledrejection', rejectHandler)
    }

    // ── Store method rejections ──────────────────────────────────────

    it('continues blur sequence when edit() rejects', () => {
      suppressUnhandledRejections()
      mockEdit.mockRejectedValueOnce(new Error('backend error'))

      const mockUnmount = vi.fn(() => 'updated text')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      // edit was called (and will reject), but blur still completes
      expect(mockEdit).toHaveBeenCalledWith('B1', 'updated text')
      expect(mockDeleteDraft).toHaveBeenCalledWith('B1')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('continues blur sequence when splitBlock() rejects', () => {
      suppressUnhandledRejections()
      mockSplitBlock.mockRejectedValueOnce(new Error('split failed'))

      const mockUnmount = vi.fn(() => 'line1\nline2')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      expect(mockSplitBlock).toHaveBeenCalledWith('B1', 'line1\nline2')
      expect(mockDeleteDraft).toHaveBeenCalledWith('B1')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('continues focus transition when edit() rejects for previous block', async () => {
      suppressUnhandledRejections()
      mockEdit.mockRejectedValueOnce(new Error('save failed'))

      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'unsaved changes')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'PREV_BLOCK',
      })

      render(
        <EditableBlock
          blockId="B2"
          content="New block"
          isFocused={false}
          rovingEditor={roving as never}
        />,
      )

      await userEvent.click(screen.getByTestId('static-block-B2'))

      // edit was called for previous block (and rejects)
      expect(mockEdit).toHaveBeenCalledWith('PREV_BLOCK', 'unsaved changes')
      // Focus transition still completes
      expect(mockSetFocused).toHaveBeenCalledWith('B2')
      expect(mockMount).toHaveBeenCalledWith('B2', 'New block')
    })

    it('continues auto-mount when splitBlock() rejects for previous block', () => {
      suppressUnhandledRejections()
      mockSplitBlock.mockRejectedValueOnce(new Error('split failed'))

      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'line1\nline2')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'OLD_BLOCK',
      })

      const { rerender } = render(
        <EditableBlock blockId="B1" content="" isFocused={false} rovingEditor={roving as never} />,
      )

      rerender(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // splitBlock was called for old block (and rejects)
      expect(mockSplitBlock).toHaveBeenCalledWith('OLD_BLOCK', 'line1\nline2')
      // Auto-mount still completes
      expect(mockMount).toHaveBeenCalledWith('B1', '')
    })

    // ── Draft operation rejections (caught by useDraftAutosave .catch) ─

    it('handles saveDraft rejection gracefully during editing', async () => {
      vi.useFakeTimers()
      mockSaveDraft.mockRejectedValueOnce(new Error('IPC failure'))

      const mockGetMarkdown = vi.fn(() => 'typed content')
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        getMarkdown: mockGetMarkdown,
      })

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Advance past the 500ms polling interval so liveContent gets set
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Advance past the 2s debounce — saveDraft fires and rejects
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      // saveDraft was called — rejection caught by hook's .catch()
      expect(mockSaveDraft).toHaveBeenCalledWith('B1', 'typed content')

      vi.useRealTimers()
    })

    it('handles deleteDraft rejection gracefully on blur', () => {
      mockDeleteDraft.mockRejectedValueOnce(new Error('IPC failure'))

      const mockUnmount = vi.fn(() => 'updated text')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      // deleteDraft was called via discardDraft() — rejection caught by hook
      expect(mockDeleteDraft).toHaveBeenCalledWith('B1')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('handles flushDraft rejection gracefully on unmount', async () => {
      vi.useFakeTimers()
      mockFlushDraft.mockRejectedValueOnce(new Error('IPC failure'))

      const mockGetMarkdown = vi.fn(() => 'unsaved')
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        getMarkdown: mockGetMarkdown,
      })

      const { unmount } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Advance past polling interval so content is set
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Unmount triggers cleanup — flushDraft fires and rejects
      unmount()

      expect(mockFlushDraft).toHaveBeenCalledWith('B1')

      vi.useRealTimers()
    })
  })

  // ── F-18: Draft autosave integration ──────────────────────────────

  describe('draft autosave', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('calls saveDraft after 2s of editing', async () => {
      const mockGetMarkdown = vi.fn(() => 'typed content')
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        getMarkdown: mockGetMarkdown,
      })

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Advance past the 500ms polling interval so liveContent gets set
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Now advance 2s for the debounce in useDraftAutosave to fire
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      // saveDraft should have been called with the polled content
      expect(mockSaveDraft).toHaveBeenCalledWith('B1', 'typed content')
    })

    it('calls deleteDraft on blur after successful save', () => {
      const mockUnmount = vi.fn(() => 'updated text')
      const mockGetMarkdown = vi.fn(() => 'updated text')
      const roving = makeRovingEditor({
        unmount: mockUnmount,
        activeBlockId: 'B1',
        getMarkdown: mockGetMarkdown,
      })

      const { container } = render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor')
      fireEvent.blur(wrapper as Element)

      // discardDraft calls deleteDraft internally
      expect(mockDeleteDraft).toHaveBeenCalledWith('B1')
    })

    it('flushes draft on unmount without blur', async () => {
      const mockGetMarkdown = vi.fn(() => 'unsaved content')
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        getMarkdown: mockGetMarkdown,
      })

      const { unmount } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Advance past polling interval so content is set
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Unmount without blur — useDraftAutosave cleanup calls flushDraft
      unmount()

      expect(mockFlushDraft).toHaveBeenCalledWith('B1')
    })
  })

  // ── F-27: Drag-and-drop and paste file attachments ─────────────────

  describe('drag-and-drop and paste file attachments', () => {
    function makeFileWithPath(name: string, type: string, path: string): File {
      const file = new File(['content'], name, { type })
      Object.defineProperty(file, 'path', { value: path, writable: false })
      return file
    }

    it('shows drag-over styling when files are dragged over', () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.dragOver(wrapper, {
        dataTransfer: { types: ['Files'], files: [] },
      })

      expect(wrapper.className).toContain('ring-2')
      expect(wrapper.className).toContain('ring-primary')
    })

    it('removes drag-over styling on drag leave', () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.dragOver(wrapper, {
        dataTransfer: { types: ['Files'], files: [] },
      })
      expect(wrapper.className).toContain('ring-2')

      // Simulate drag leave — relatedTarget outside the wrapper
      fireEvent.dragLeave(wrapper, { relatedTarget: document.body })

      expect(wrapper.className).not.toContain('ring-2')
    })

    it('calls addAttachment on file drop', async () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFileWithPath('test.png', 'image/png', '/tmp/test.png')
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockAddAttachment).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'test.png',
        mimeType: 'image/png',
        sizeBytes: 7,
        fsPath: '/tmp/test.png',
      })
    })

    it('shows success toast after file drop', async () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFileWithPath('test.png', 'image/png', '/tmp/test.png')
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('test.png'))
    })

    it('shows error toast when file path is missing', async () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      // File without .path property (no Tauri path)
      const file = new File(['content'], 'test.png', { type: 'image/png' })
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockToastError).toHaveBeenCalled()
      expect(mockAddAttachment).not.toHaveBeenCalled()
    })

    it('shows error toast on addAttachment failure', async () => {
      mockAddAttachment.mockRejectedValueOnce(new Error('backend error'))

      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFileWithPath('test.png', 'image/png', '/tmp/test.png')
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockAddAttachment).toHaveBeenCalled()
      expect(mockToastError).toHaveBeenCalled()
    })

    it('handles paste with image files', async () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFileWithPath('screenshot.png', 'image/png', '/tmp/screenshot.png')
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.paste(wrapper, {
          clipboardData: { files: [file] },
        })
      })

      expect(mockAddAttachment).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'screenshot.png',
        mimeType: 'image/png',
        sizeBytes: 7,
        fsPath: '/tmp/screenshot.png',
      })
      expect(mockToastSuccess).toHaveBeenCalled()
    })

    it('ignores paste without files', async () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.paste(wrapper, {
          clipboardData: { files: [] },
        })
      })

      // No files in clipboard — addAttachment should NOT be called
      expect(mockAddAttachment).not.toHaveBeenCalled()
    })

    it('passes axe audit in drag-over state (ring-2 feedback)', async () => {
      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = container.querySelector('.block-editor') as HTMLElement

      // Trigger drag-over visual state
      fireEvent.dragOver(wrapper, {
        dataTransfer: { types: ['Files'], files: [] },
      })

      // Verify the drag-over styling is active before running axe
      expect(wrapper.className).toContain('ring-2')

      expect(await axe(container)).toHaveNoViolations()
    })

    it('calls addAttachment for each file in a multi-file drop', async () => {
      mockAddAttachment
        .mockResolvedValueOnce({
          id: 'ATT_1',
          block_id: 'BLK_1',
          filename: 'photo.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 7,
          fs_path: '/tmp/photo.jpg',
          created_at: '2024-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({
          id: 'ATT_2',
          block_id: 'BLK_1',
          filename: 'notes.pdf',
          mime_type: 'application/pdf',
          size_bytes: 7,
          fs_path: '/tmp/notes.pdf',
          created_at: '2024-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({
          id: 'ATT_3',
          block_id: 'BLK_1',
          filename: 'data.csv',
          mime_type: 'text/csv',
          size_bytes: 7,
          fs_path: '/tmp/data.csv',
          created_at: '2024-01-01T00:00:00Z',
        })

      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file1 = makeFileWithPath('photo.jpg', 'image/jpeg', '/tmp/photo.jpg')
      const file2 = makeFileWithPath('notes.pdf', 'application/pdf', '/tmp/notes.pdf')
      const file3 = makeFileWithPath('data.csv', 'text/csv', '/tmp/data.csv')
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file1, file2, file3], types: ['Files'] },
        })
      })

      expect(mockAddAttachment).toHaveBeenCalledTimes(3)
      expect(mockAddAttachment).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 7,
        fsPath: '/tmp/photo.jpg',
      })
      expect(mockAddAttachment).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'notes.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 7,
        fsPath: '/tmp/notes.pdf',
      })
      expect(mockAddAttachment).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'data.csv',
        mimeType: 'text/csv',
        sizeBytes: 7,
        fsPath: '/tmp/data.csv',
      })
      expect(mockToastSuccess).toHaveBeenCalledTimes(3)
    })

    it('handles drop of file with special characters in name', async () => {
      const specialName = 'café résumé (2).pdf'
      mockAddAttachment.mockResolvedValueOnce({
        id: 'ATT_SP',
        block_id: 'BLK_1',
        filename: specialName,
        mime_type: 'application/pdf',
        size_bytes: 7,
        fs_path: `/tmp/${specialName}`,
        created_at: '2024-01-01T00:00:00Z',
      })

      const { container } = render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFileWithPath(specialName, 'application/pdf', `/tmp/${specialName}`)
      const wrapper = container.querySelector('.block-editor') as HTMLElement

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockAddAttachment).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: specialName,
        mimeType: 'application/pdf',
        sizeBytes: 7,
        fsPath: `/tmp/${specialName}`,
      })
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining(specialName))
      expect(mockToastError).not.toHaveBeenCalled()
    })
  })
})
