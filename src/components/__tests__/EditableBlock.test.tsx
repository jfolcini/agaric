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

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { EDITOR_PORTAL_SELECTORS, EditableBlock } from '../EditableBlock'

// ── Mocks ────────────────────────────────────────────────────────────────

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

// Mock block store — capture calls to edit, splitBlock, setFocused
const mockEdit = vi.fn()
const mockSplitBlock = vi.fn()
const mockSetFocused = vi.fn()
const _mockStore = {
  setFocused: mockSetFocused,
  edit: mockEdit,
  splitBlock: mockSplitBlock,
  blocks: [] as Array<{ id: string; priority?: string | null }>,
}
vi.mock('../../stores/blocks', () => ({
  useBlockStore: (selector?: (s: typeof _mockStore) => unknown) =>
    selector ? selector(_mockStore) : _mockStore,
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
})
