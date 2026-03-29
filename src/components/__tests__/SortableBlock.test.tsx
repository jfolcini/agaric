import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @dnd-kit/sortable to control sortable state
const mockUseSortable = vi.fn()
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: (...args: unknown[]) => mockUseSortable(...args),
}))

// Mock @dnd-kit/utilities
vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (transform: unknown) => {
        if (!transform) return undefined
        const t = transform as { x: number; y: number; scaleX: number; scaleY: number }
        return `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})`
      },
    },
  },
}))

// Mock EditableBlock to keep tests focused on SortableBlock behavior
vi.mock('../EditableBlock', () => ({
  EditableBlock: (props: { blockId: string }) => (
    <div data-testid={`editable-block-${props.blockId}`}>EditableBlock</div>
  ),
}))

// Mock lucide-react
vi.mock('lucide-react', () => ({
  GripVertical: (props: { size: number }) => (
    <svg data-testid="grip-vertical-icon" width={props.size} height={props.size} />
  ),
  Trash2: (props: { size: number }) => (
    <svg data-testid="trash-icon" width={props.size} height={props.size} />
  ),
}))

import userEvent from '@testing-library/user-event'
import { SortableBlock } from '../SortableBlock'

// Create a minimal mock roving editor handle
function makeRovingEditor() {
  return {
    editor: null,
    mount: vi.fn(),
    unmount: vi.fn(() => null),
    activeBlockId: null,
  }
}

describe('SortableBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders EditableBlock inside', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(screen.getByTestId('editable-block-BLOCK_1')).toBeInTheDocument()
  })

  it('renders drag handle with GripVertical icon', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    // Drag handle button exists
    const handle = screen.getByRole('button', { name: /drag to reorder/i })
    expect(handle).toBeInTheDocument()

    // GripVertical icon rendered inside
    expect(screen.getByTestId('grip-vertical-icon')).toBeInTheDocument()
  })

  it('applies opacity: 0.5 during drag', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: { x: 0, y: 50, scaleX: 1, scaleY: 1 },
      transition: 'transform 200ms ease',
      isDragging: true,
    })

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.opacity).toBe('0.5')
  })

  it('applies opacity: 1 when not dragging', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.opacity).toBe('1')
  })

  it('applies transform style from useSortable', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: { x: 0, y: 100, scaleX: 1, scaleY: 1 },
      transition: 'transform 200ms ease',
      isDragging: false,
    })

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.transform).toContain('translate3d')
    expect(wrapper.style.transition).toBe('transform 200ms ease')
  })

  it('passes blockId to useSortable', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    render(
      <SortableBlock
        blockId="MY_BLOCK_ID"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(mockUseSortable).toHaveBeenCalledWith({ id: 'MY_BLOCK_ID' })
  })

  it('drag handle has correct aria-label for accessibility', () => {
    mockUseSortable.mockReturnValue({
      attributes: { role: 'button', tabIndex: 0 },
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByLabelText('Drag to reorder')
    expect(handle).toBeInTheDocument()
    expect(handle.tagName.toLowerCase()).toBe('button')
  })

  it('renders a delete button with trash icon', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    const onDelete = vi.fn()

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={onDelete}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn).toBeInTheDocument()
    expect(screen.getByTestId('trash-icon')).toBeInTheDocument()
  })

  it('calls onDelete with blockId when delete button is clicked', async () => {
    const user = userEvent.setup()
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    const onDelete = vi.fn()

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={onDelete}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    await user.click(deleteBtn)

    expect(onDelete).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledWith('BLOCK_42')
  })

  it('does not render delete button when onDelete is not provided', () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(screen.queryByRole('button', { name: /delete block/i })).not.toBeInTheDocument()
  })
})
