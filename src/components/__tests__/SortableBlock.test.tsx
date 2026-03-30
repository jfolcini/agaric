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
  Check: (props: { size: number; className?: string }) => (
    <svg
      data-testid="check-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  ChevronRight: (props: { size: number; className?: string }) => (
    <svg
      data-testid="chevron-right-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
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

  it('applies opacity: 0.7 during drag', () => {
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
    expect(wrapper.style.opacity).toBe('0.7')
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

describe('SortableBlock collapse/expand chevron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })
  })

  it('renders ChevronRight when hasChildren is true', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )

    expect(screen.getByTestId('chevron-right-icon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /collapse children/i })).toBeInTheDocument()
  })

  it('does not render ChevronRight when hasChildren is false', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren={false}
      />,
    )

    expect(screen.queryByTestId('chevron-right-icon')).not.toBeInTheDocument()
  })

  it('renders a spacer when hasChildren is false', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren={false}
      />,
    )

    expect(container.querySelector('.collapse-spacer')).toBeInTheDocument()
  })

  it('does not render a spacer when hasChildren is true', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )

    expect(container.querySelector('.collapse-spacer')).not.toBeInTheDocument()
  })

  it('applies rotate-90 class when expanded (not collapsed)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        isCollapsed={false}
      />,
    )

    const chevron = screen.getByTestId('chevron-right-icon')
    expect(chevron.getAttribute('class')).toContain('rotate-90')
  })

  it('does not apply rotate-90 class when collapsed', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        isCollapsed
      />,
    )

    const chevron = screen.getByTestId('chevron-right-icon')
    expect(chevron.getAttribute('class')).not.toContain('rotate-90')
  })

  it('shows "Collapse children" aria-label when expanded', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        isCollapsed={false}
      />,
    )

    expect(screen.getByRole('button', { name: 'Collapse children' })).toBeInTheDocument()
  })

  it('shows "Expand children" aria-label when collapsed', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        isCollapsed
      />,
    )

    expect(screen.getByRole('button', { name: 'Expand children' })).toBeInTheDocument()
  })

  it('calls onToggleCollapse with blockId when chevron is clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        onToggleCollapse={onToggle}
      />,
    )

    const collapseBtn = screen.getByRole('button', { name: /collapse children/i })
    await user.click(collapseBtn)

    expect(onToggle).toHaveBeenCalledOnce()
    expect(onToggle).toHaveBeenCalledWith('BLOCK_42')
  })
})

describe('SortableBlock task marker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })
  })

  it('renders ghost checkbox when todoState is null (no task)', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState={null}
      />,
    )

    const marker = container.querySelector('.task-marker')
    expect(marker).toBeInTheDocument()
    // Ghost checkbox visible on hover
    expect(container.querySelector('.task-checkbox-empty')).toBeInTheDocument()
  })

  it('renders ghost checkbox when todoState is undefined', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const marker = container.querySelector('.task-marker')
    expect(marker).toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-empty')).toBeInTheDocument()
  })

  it('renders unchecked checkbox for TODO state', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
      />,
    )

    const todoCheckbox = container.querySelector('.task-checkbox-todo')
    expect(todoCheckbox).toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-doing')).not.toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-done')).not.toBeInTheDocument()
  })

  it('renders indeterminate checkbox for DOING state', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DOING"
      />,
    )

    const doingCheckbox = container.querySelector('.task-checkbox-doing')
    expect(doingCheckbox).toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-todo')).not.toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-done')).not.toBeInTheDocument()
  })

  it('renders checked checkbox with Check icon for DONE state', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DONE"
      />,
    )

    const doneCheckbox = container.querySelector('.task-checkbox-done')
    expect(doneCheckbox).toBeInTheDocument()
    expect(screen.getByTestId('check-icon')).toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-todo')).not.toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-doing')).not.toBeInTheDocument()
  })

  it('has "Set as TODO" aria-label when no task state', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState={null}
      />,
    )

    expect(screen.getByRole('button', { name: 'Set as TODO' })).toBeInTheDocument()
  })

  it('has descriptive aria-label when task state is set', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DOING"
      />,
    )

    expect(screen.getByRole('button', { name: 'Task: DOING. Click to cycle.' })).toBeInTheDocument()
  })

  it('calls onToggleTodo with blockId when task marker is clicked', async () => {
    const user = userEvent.setup()
    const onToggleTodo = vi.fn()

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
        onToggleTodo={onToggleTodo}
      />,
    )

    const marker = screen.getByRole('button', { name: /task: todo/i })
    await user.click(marker)

    expect(onToggleTodo).toHaveBeenCalledOnce()
    expect(onToggleTodo).toHaveBeenCalledWith('BLOCK_42')
  })

  it('does not crash when onToggleTodo is not provided', async () => {
    const user = userEvent.setup()

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
      />,
    )

    const marker = screen.getByRole('button', { name: /task: todo/i })
    // Should not throw
    await user.click(marker)
  })

  it('applies border-muted-foreground class to TODO checkbox', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
      />,
    )

    const checkbox = container.querySelector('.task-checkbox-todo')
    expect(checkbox?.getAttribute('class')).toContain('border-muted-foreground')
  })

  it('applies border-blue-500 class to DOING checkbox', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DOING"
      />,
    )

    const checkbox = container.querySelector('.task-checkbox-doing')
    expect(checkbox?.getAttribute('class')).toContain('border-blue-500')
  })

  it('applies border-green-600 and bg-green-600 class to DONE checkbox', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DONE"
      />,
    )

    const checkbox = container.querySelector('.task-checkbox-done')
    expect(checkbox?.getAttribute('class')).toContain('border-green-600')
    expect(checkbox?.getAttribute('class')).toContain('bg-green-600')
  })

  it('applies line-through and opacity-50 to content when DONE', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DONE"
      />,
    )

    // The content wrapper div should have line-through and opacity-50
    const contentWrapper = container.querySelector('.line-through')
    expect(contentWrapper).toBeInTheDocument()
    expect(contentWrapper?.getAttribute('class')).toContain('opacity-50')
  })

  it('does not apply line-through when todoState is not DONE', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
      />,
    )

    expect(container.querySelector('.line-through')).not.toBeInTheDocument()
  })
})
