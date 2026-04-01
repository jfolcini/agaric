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
import { EditableBlock } from '../EditableBlock'

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
vi.mock('../../stores/blocks', () => ({
  useBlockStore: () => ({
    setFocused: mockSetFocused,
    edit: mockEdit,
    splitBlock: mockSplitBlock,
  }),
}))

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a minimal mock roving editor handle. */
function makeRovingEditor(
  overrides: Partial<{
    editor: unknown
    activeBlockId: string | null
    mount: ReturnType<typeof vi.fn>
    unmount: ReturnType<typeof vi.fn>
  }> = {},
) {
  return {
    editor: 'editor' in overrides ? overrides.editor : { fake: true },
    mount: overrides.mount ?? vi.fn(),
    unmount: overrides.unmount ?? vi.fn(() => null),
    activeBlockId: overrides.activeBlockId ?? null,
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
    it('does not unmount when a Radix popover is open in the DOM', () => {
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

      // Simulate a Radix popover being open in the DOM
      const portal = document.createElement('div')
      portal.setAttribute('data-radix-popper-content-wrapper', '')
      document.body.appendChild(portal)

      const editorWrapper = container.querySelector('.block-editor') as HTMLElement
      fireEvent.blur(editorWrapper, { relatedTarget: null })

      expect(mockUnmount).not.toHaveBeenCalled()

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
})
