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

import { EditableBlock } from '@/components/editor/EditableBlock'
import { EDITOR_PORTAL_SELECTOR } from '@/hooks/useEditorBlur'

// ── Mocks ────────────────────────────────────────────────────────────────

// Mock shouldSplitOnBlur from use-roving-editor — controls split detection
const mockShouldSplitOnBlur = vi.fn((md: string) => md.includes('\n'))
vi.mock('@/editor/use-roving-editor', () => ({
  shouldSplitOnBlur: (...args: unknown[]) => mockShouldSplitOnBlur(...(args as [string])),
}))

// Mock EditorContent — TipTap doesn't render in jsdom so we stub it
vi.mock('@tiptap/react', () => ({
  EditorContent: ({ editor }: { editor: unknown }) =>
    editor != null ? <div data-testid="editor-content">TipTap Editor</div> : null,
}))

// Mock FormattingToolbar — tested separately in FormattingToolbar.test.tsx
vi.mock('@/components/FormattingToolbar', () => ({
  FormattingToolbar: ({ blockId }: { blockId?: string }) => (
    <div data-testid="formatting-toolbar" data-block-id={blockId} />
  ),
}))

// Mock SelectionBubbleMenu — tested separately in SelectionBubbleMenu.test.tsx
vi.mock('@/components/editor-toolbar/SelectionBubbleMenu', () => ({
  SelectionBubbleMenu: ({ blockId }: { blockId?: string }) => (
    <div data-testid="selection-bubble-menu" data-block-id={blockId} />
  ),
}))

// Mock LinkPreviewTooltip — tested separately in LinkPreviewTooltip.test.tsx (UX-165)
vi.mock('@/components/LinkPreviewTooltip', () => ({
  LinkPreviewTooltip: () => <div data-testid="link-preview-tooltip-mock" />,
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
const mockAddAttachmentWithBytes = vi.fn().mockResolvedValue({
  id: 'ATT_1',
  block_id: 'BLK_1',
  filename: 'test.png',
  mime_type: 'image/png',
  size_bytes: 7,
  fs_path: 'attachments/ATT_1',
  created_at: '2024-01-01T00:00:00Z',
})
vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual('@/lib/tauri')
  return {
    ...actual,
    saveDraft: (...args: unknown[]) => mockSaveDraft(...args),
    deleteDraft: (...args: unknown[]) => mockDeleteDraft(...args),
    flushDraft: (...args: unknown[]) => mockFlushDraft(...args),
    addAttachmentWithBytes: (...args: unknown[]) => mockAddAttachmentWithBytes(...args),
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
vi.mock('@/stores/blocks', () => ({
  useBlockStore: (selector?: (s: typeof _mockBlockStore) => unknown) =>
    selector ? selector(_mockBlockStore) : _mockBlockStore,
}))

// Mock per-page block store — capture calls to edit, splitBlock
const _mockPageStore = {
  edit: mockEdit,
  splitBlock: mockSplitBlock,
  blocks: [] as Array<{ id: string; priority?: string | null }>,
  // PEND-20 G — `EditableBlock`'s priority selector reads from `blocksById`.
  // Provide an empty Map so `selector(s).priority` is `undefined`, matching
  // the original `blocks.find(...)` behavior on an empty array.
  blocksById: new Map<string, { id: string; priority?: string | null }>(),
}
vi.mock('@/stores/page-blocks', () => ({
  usePageBlockStore: (selector?: (s: typeof _mockPageStore) => unknown) =>
    selector ? selector(_mockPageStore) : _mockPageStore,
  usePageBlockStoreApi: () => ({ getState: () => _mockPageStore }),
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
    setOnMarkdownChange: ReturnType<typeof vi.fn>
  }> = {},
) {
  return {
    editor: 'editor' in overrides ? overrides.editor : { fake: true },
    mount: overrides.mount ?? vi.fn(),
    unmount: overrides.unmount ?? vi.fn(() => null),
    activeBlockId: overrides.activeBlockId ?? null,
    getMarkdown: overrides.getMarkdown ?? vi.fn(() => null),
    originalMarkdown: overrides.originalMarkdown ?? 'existing content',
    setOnMarkdownChange: overrides.setOnMarkdownChange ?? vi.fn(),
  }
}

/**
 * The focused block's editor wrapper `<section>`, looked up by the stable
 * `data-testid="block-editor"` (EditableBlock.tsx). Replaces the brittle
 * `container.querySelector('.block-editor')` / `'#editor-B1'` lookups (#1027):
 * a CSS-class/ID rename used to make those return `null`, silently skipping the
 * blur/focus/drag simulation rather than failing. `getByTestId` throws a
 * descriptive error when the wrapper is absent, so the simulation can never be
 * silently no-op'd.
 */
function getBlockEditorWrapper(): HTMLElement {
  return screen.getByTestId('block-editor')
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

    it('applies the block-selected recipe when isSelected (UX-302, recipe unified UX-929)', () => {
      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          isSelected={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      // UX-929 F4: selection now uses the single `block-selected` @utility
      // (src/index.css) instead of the inlined ring-primary/bg-primary cluster.
      const wrapper = screen.getByTestId('block-editor')
      expect(wrapper.className).toContain('block-selected')
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

      render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate blur on the editor wrapper via React event system
      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="same text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate a Radix popover being open AND visible in the DOM
      const portal = document.createElement('div')
      portal.setAttribute('data-editor-portal', '')
      ;(portal as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(portal)

      const editorWrapper = getBlockEditorWrapper()
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(portal)
    })

    it('unmounts and saves when portal elements exist in DOM but are hidden', () => {
      const mockUnmount = vi.fn(() => 'changed')
      const roving = makeRovingEditor({ activeBlockId: 'B1', unmount: mockUnmount })

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate a Radix popover that is in the DOM but hidden
      const portal = document.createElement('div')
      portal.setAttribute('data-editor-portal', '')
      ;(portal as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false
      document.body.appendChild(portal)

      const editorWrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate relatedTarget being inside a Radix popover
      const portal = document.createElement('div')
      portal.setAttribute('data-editor-portal', '')
      const input = document.createElement('input')
      portal.appendChild(input)
      document.body.appendChild(portal)

      const editorWrapper = getBlockEditorWrapper()
      fireEvent.blur(editorWrapper, { relatedTarget: input })

      expect(mockUnmount).not.toHaveBeenCalled()

      document.body.removeChild(portal)
    })
  })

  // ── #40: scrollIntoView on editor focus ──────────────────────────────

  describe('scrollIntoView on focus', () => {
    it('calls scrollIntoView with block: nearest when focused', async () => {
      const scrollIntoViewMock = vi.fn()

      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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
      render(
        <EditableBlock
          blockId="B1"
          content="Hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      // Look the wrapper up by its stable test id, then assert the id attribute
      // (the aria-controls target) and that it is a <section> (#1027).
      const wrapper = getBlockEditorWrapper()
      expect(wrapper).toHaveAttribute('id', 'editor-B1')
      expect(wrapper.tagName).toBe('SECTION')
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

  // ── EDITOR_PORTAL_SELECTOR constant (PEND-30 L-3) ─────────────────

  describe('EDITOR_PORTAL_SELECTOR', () => {
    it('is exported as the single canonical attribute selector', () => {
      expect(EDITOR_PORTAL_SELECTOR).toBe('[data-editor-portal]')
    })

    it('handleBlur does not unmount when relatedTarget is inside a suggestion popup', () => {
      const mockUnmount = vi.fn(() => 'changed')
      const roving = makeRovingEditor({ activeBlockId: 'B1', unmount: mockUnmount })

      render(
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
      popup.setAttribute('data-editor-portal', '')
      const btn = document.createElement('button')
      popup.appendChild(btn)
      document.body.appendChild(popup)

      const editorWrapper = getBlockEditorWrapper()
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

    // #770 gap 1 — a programmatic focus move (auto-mount path) does NOT go
    // through useEditorBlur's discardDraft(), so the previous block's
    // debounced `block_drafts` row would survive to the next boot and be
    // replayed by flush_all_drafts as an edit_block op (possibly clobbering
    // newer content). persistUnmount must delete the previous block's draft
    // row so nothing is flushable at boot.
    it('deletes the previous block draft row on a programmatic focus move (gap 1)', () => {
      const mockMount = vi.fn()
      const mockUnmount = vi.fn(() => 'unsaved changes')
      const roving = makeRovingEditor({
        mount: mockMount,
        unmount: mockUnmount,
        activeBlockId: 'OLD_BLOCK',
      })

      const { rerender } = render(
        <EditableBlock blockId="B1" content="x" isFocused={false} rovingEditor={roving as never} />,
      )
      rerender(
        <EditableBlock blockId="B1" content="x" isFocused={true} rovingEditor={roving as never} />,
      )

      expect(mockEdit).toHaveBeenCalledWith('OLD_BLOCK', 'unsaved changes')
      // The orphan draft row for the block we moved AWAY from must be dropped.
      expect(mockDeleteDraft).toHaveBeenCalledWith('OLD_BLOCK')
    })

    // Gap 1 corner: even when the previous content is unchanged (unmount
    // returns null) a >2 s pause may have persisted a draft row, so the
    // delete must still fire.
    it('deletes the previous block draft row even when content is unchanged (gap 1)', () => {
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

      expect(mockEdit).not.toHaveBeenCalled()
      expect(mockDeleteDraft).toHaveBeenCalledWith('OLD_BLOCK')
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

      render(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // Simulate a visible suggestion popup being open in the DOM
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      popup.setAttribute('data-editor-portal', '')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const editorWrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // No popup in DOM — blur runs fully (early save + unmount save)
      const editorWrapper = getBlockEditorWrapper()
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

      render(
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
      popup.setAttribute('data-editor-portal', '')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const editorWrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock blockId="B1" content="" isFocused={true} rovingEditor={roving as never} />,
      )

      // Visible popup in DOM — triggers early return
      const popup = document.createElement('div')
      popup.classList.add('suggestion-popup')
      popup.setAttribute('data-editor-portal', '')
      ;(popup as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true
      document.body.appendChild(popup)

      const editorWrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="ArrowRight content"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
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

      let onChange: ((md: string) => void) | null = null
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        setOnMarkdownChange: vi.fn((cb: ((md: string) => void) | null) => {
          onChange = cb
        }),
      })

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Fire an update so liveContent is set
      await act(async () => {
        onChange?.('typed content')
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

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
      fireEvent.blur(wrapper as Element)

      // deleteDraft was called via discardDraft() — rejection caught by hook
      expect(mockDeleteDraft).toHaveBeenCalledWith('B1')
      expect(mockSetFocused).toHaveBeenCalledWith(null)
    })

    it('handles flushDraft rejection gracefully on unmount', async () => {
      vi.useFakeTimers()
      mockFlushDraft.mockRejectedValueOnce(new Error('IPC failure'))

      let onChange: ((md: string) => void) | null = null
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        setOnMarkdownChange: vi.fn((cb: ((md: string) => void) | null) => {
          onChange = cb
        }),
      })

      const { unmount } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Fire an update so liveContent is set
      await act(async () => {
        onChange?.('unsaved')
      })

      // Unmount triggers cleanup — flushDraft fires and rejects.
      // The final flush is chained on the gap-2 saveDraft promise (#770), so
      // it lands a couple of microtask turns after unmount.
      unmount()
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

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
      // Capture the markdown-change callback the component registers (#536:
      // event-driven via TipTap onUpdate instead of a 500ms poll).
      let onChange: ((md: string) => void) | null = null
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        setOnMarkdownChange: vi.fn((cb: ((md: string) => void) | null) => {
          onChange = cb
        }),
      })

      render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Simulate a TipTap update firing with new content.
      await act(async () => {
        onChange?.('typed content')
      })

      // Now advance 2s for the debounce in useDraftAutosave to fire
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      // saveDraft should have been called with the edited content
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

      render(
        <EditableBlock
          blockId="B1"
          content="original text"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
      fireEvent.blur(wrapper as Element)

      // discardDraft calls deleteDraft internally
      expect(mockDeleteDraft).toHaveBeenCalledWith('B1')
    })

    it('flushes draft on unmount without blur', async () => {
      let onChange: ((md: string) => void) | null = null
      const roving = makeRovingEditor({
        activeBlockId: 'B1',
        setOnMarkdownChange: vi.fn((cb: ((md: string) => void) | null) => {
          onChange = cb
        }),
      })

      const { unmount } = render(
        <EditableBlock
          blockId="B1"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Fire an update so liveContent is set
      await act(async () => {
        onChange?.('unsaved content')
      })

      // Unmount without blur — useDraftAutosave cleanup calls flushDraft.
      // The final flush is chained on the gap-2 saveDraft promise (#770), so
      // it lands a couple of microtask turns after unmount.
      unmount()
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mockFlushDraft).toHaveBeenCalledWith('B1')
    })

    // ── #1015 (C1): focus-transition race must NOT disable autosave ────
    //
    // On a block→block focus switch React runs the markdown-change
    // subscription effect BEFORE the auto-mount effect, so at registration
    // time `rovingEditor.activeBlockId` still points at the OLD block. The
    // old guard (`activeBlockId !== blockId` early-return) therefore skipped
    // registration on the newly-focused block, silently disabling its draft
    // autosave. We model that exact moment by rendering a focused block whose
    // `activeBlockId` reports the previous block.
    it('registers the markdown-change callback even when activeBlockId still points at the old block (#1015)', async () => {
      let onChange: ((md: string) => void) | null = null
      const mockSetOnMarkdownChange = vi.fn((cb: ((md: string) => void) | null) => {
        if (cb) onChange = cb
      })
      const roving = makeRovingEditor({
        // The destination block is focused, but the roving editor has not yet
        // re-mounted — activeBlockId is still the previously-focused block.
        activeBlockId: 'OLD_BLOCK',
        setOnMarkdownChange: mockSetOnMarkdownChange,
      })

      render(
        <EditableBlock
          blockId="NEW_BLOCK"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Regression: with the old early-return guard this was never called.
      expect(mockSetOnMarkdownChange).toHaveBeenCalled()
      expect(onChange).toBeTypeOf('function')

      // Once the editor actually mounts on the new block, edits autosave.
      roving.activeBlockId = 'NEW_BLOCK'
      await act(async () => {
        onChange?.('typed on new block')
      })
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockSaveDraft).toHaveBeenCalledWith('NEW_BLOCK', 'typed on new block')
    })

    // The identity check now lives inside the callback: a markdown-change
    // event that arrives while activeBlockId still reports a different block
    // must be ignored, so it can't write the new block's keystrokes under a
    // stale id.
    it('ignores markdown-change events while activeBlockId does not match the block (#1015)', async () => {
      let onChange: ((md: string) => void) | null = null
      const roving = makeRovingEditor({
        activeBlockId: 'OLD_BLOCK',
        setOnMarkdownChange: vi.fn((cb: ((md: string) => void) | null) => {
          if (cb) onChange = cb
        }),
      })

      render(
        <EditableBlock
          blockId="NEW_BLOCK"
          content="original"
          isFocused={true}
          rovingEditor={roving as never}
        />,
      )

      // Event fires before the mount swaps activeBlockId → must be dropped.
      await act(async () => {
        onChange?.('stale fire')
      })
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(mockSaveDraft).not.toHaveBeenCalled()
    })
  })

  // ── F-27: Drag-and-drop and paste file attachments ─────────────────

  describe('drag-and-drop and paste file attachments', () => {
    // PEND-76 F2 — the upload path reads the file to bytes and ships them over
    // IPC; the browser file's absolute path is no longer used. Files carry
    // real byte content (`'content'` → 7 bytes) so we can assert on the bytes.
    const CONTENT_BYTES = [99, 111, 110, 116, 101, 110, 116]
    function makeFile(name: string, type: string): File {
      return new File(['content'], name, { type })
    }

    it('shows drag-over styling when files are dragged over', () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
      fireEvent.dragOver(wrapper, {
        dataTransfer: { types: ['Files'], files: [] },
      })

      expect(wrapper.className).toContain('ring-2')
      expect(wrapper.className).toContain('ring-primary')
    })

    it('removes drag-over styling on drag leave', () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()
      fireEvent.dragOver(wrapper, {
        dataTransfer: { types: ['Files'], files: [] },
      })
      expect(wrapper.className).toContain('ring-2')

      // Simulate drag leave — relatedTarget outside the wrapper
      fireEvent.dragLeave(wrapper, { relatedTarget: document.body })

      expect(wrapper.className).not.toContain('ring-2')
    })

    it('calls addAttachmentWithBytes on file drop', async () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFile('test.png', 'image/png')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'test.png',
        mimeType: 'image/png',
        bytes: expect.any(Uint8Array),
      })
      const arg = mockAddAttachmentWithBytes.mock.calls[0]?.[0] as { bytes: Uint8Array }
      expect(Array.from(arg.bytes)).toEqual(CONTENT_BYTES)
    })

    it('shows success toast after file drop', async () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFile('test.png', 'image/png')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('test.png'))
    })

    it('rejects a disallowed file type without calling the add IPC', async () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      // Disallowed MIME type (not on the backend allow-list).
      const file = makeFile('evil.exe', 'application/x-msdownload')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockToastError).toHaveBeenCalled()
      expect(mockAddAttachmentWithBytes).not.toHaveBeenCalled()
    })

    it('shows error toast on addAttachmentWithBytes failure', async () => {
      mockAddAttachmentWithBytes.mockRejectedValueOnce(new Error('backend error'))

      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFile('test.png', 'image/png')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'test.png',
        mimeType: 'image/png',
        bytes: expect.any(Uint8Array),
      })
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('attach file'))
    })

    it('handles paste with image files', async () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFile('screenshot.png', 'image/png')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.paste(wrapper, {
          clipboardData: { files: [file] },
        })
      })

      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'screenshot.png',
        mimeType: 'image/png',
        bytes: expect.any(Uint8Array),
      })
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('screenshot.png'))
    })

    it('ignores paste without files', async () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.paste(wrapper, {
          clipboardData: { files: [] },
        })
      })

      // No files in clipboard — the add IPC should NOT be called
      expect(mockAddAttachmentWithBytes).not.toHaveBeenCalled()
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

      const wrapper = getBlockEditorWrapper()

      // Trigger drag-over visual state
      fireEvent.dragOver(wrapper, {
        dataTransfer: { types: ['Files'], files: [] },
      })

      // Verify the drag-over styling is active before running axe
      expect(wrapper.className).toContain('ring-2')

      expect(await axe(container)).toHaveNoViolations()
    })

    it('calls addAttachmentWithBytes for each file in a multi-file drop', async () => {
      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file1 = makeFile('photo.jpg', 'image/jpeg')
      const file2 = makeFile('notes.pdf', 'application/pdf')
      const file3 = makeFile('data.csv', 'text/csv')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file1, file2, file3], types: ['Files'] },
        })
      })

      expect(mockAddAttachmentWithBytes).toHaveBeenCalledTimes(3)
      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        bytes: expect.any(Uint8Array),
      })
      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'notes.pdf',
        mimeType: 'application/pdf',
        bytes: expect.any(Uint8Array),
      })
      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: 'data.csv',
        mimeType: 'text/csv',
        bytes: expect.any(Uint8Array),
      })
      expect(mockToastSuccess).toHaveBeenCalledTimes(3)
    })

    it('handles drop of file with special characters in name', async () => {
      const specialName = 'café résumé (2).pdf'

      render(
        <EditableBlock
          blockId="BLK_1"
          content="hello"
          isFocused={true}
          rovingEditor={makeRovingEditor() as never}
        />,
      )

      const file = makeFile(specialName, 'application/pdf')
      const wrapper = getBlockEditorWrapper()

      await act(async () => {
        fireEvent.drop(wrapper, {
          dataTransfer: { files: [file], types: ['Files'] },
        })
      })

      expect(mockAddAttachmentWithBytes).toHaveBeenCalledWith({
        blockId: 'BLK_1',
        filename: specialName,
        mimeType: 'application/pdf',
        bytes: expect.any(Uint8Array),
      })
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining(specialName))
      expect(mockToastError).not.toHaveBeenCalled()
    })
  })
})
