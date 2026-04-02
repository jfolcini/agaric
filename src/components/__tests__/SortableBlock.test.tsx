import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

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
  CalendarDays: (props: { size: number; className?: string }) => (
    <svg
      data-testid="calendar-days-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
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

// Mock BlockContextMenu to avoid importing all its lucide-react icons
vi.mock('../BlockContextMenu', () => ({
  BlockContextMenu: ({
    onClose,
    blockId,
  }: {
    onClose: () => void
    blockId: string
    position: { x: number; y: number }
  }) => (
    <div data-testid="block-context-menu" role="menu" aria-label="Block actions">
      <button type="button" role="menuitem" onClick={onClose} data-testid="close-context-menu">
        Close
      </button>
      <span data-testid="context-menu-block-id">{blockId}</span>
    </div>
  ),
}))

import userEvent from '@testing-library/user-event'
import { SortableBlock } from '../SortableBlock'

// Create a minimal mock sortable return value
function makeSortable() {
  return {
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }
}

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
    const handle = screen.getByRole('button', { name: /reorder block/i })
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

    const handle = screen.getByLabelText('Reorder block (drag or use keyboard)')
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

  it('renders a spacer matching chevron width when hasChildren is false', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren={false}
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const spacer = inlineControls?.querySelector('.w-\\[18px\\]')
    expect(spacer).toBeInTheDocument()
    expect(spacer?.tagName.toLowerCase()).toBe('div')
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

describe('gutter alignment', () => {
  it('collapse toggle has mt-1.5 for first-line alignment', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )
    const collapseBtn = screen.getByRole('button', { name: /collapse/i })
    expect(collapseBtn.className).toContain('mt-1.5')
  })

  it('task marker has mt-1.5 for first-line alignment', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const marker = screen.getByRole('button', { name: /set as todo/i })
    expect(marker.className).toContain('mt-1.5')
  })

  it('drag handle has mt-1.5 and p-0.5 for alignment', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const handle = screen.getByRole('button', { name: /drag/i })
    expect(handle.className).toContain('mt-1.5')
    expect(handle.className).toContain('p-0.5')
  })

  it('delete button has mt-1.5 and p-0.5 for alignment', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )
    const deleteBtn = screen.getByRole('button', { name: /delete/i })
    expect(deleteBtn.className).toContain('mt-1.5')
    expect(deleteBtn.className).toContain('p-0.5')
  })

  it('due date chip has mt-1.5 for vertical alignment with gutter elements', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2026-12-25"
      />,
    )
    const chip = container.querySelector('.due-date-chip')
    expect(chip?.className).toContain('mt-1.5')
  })
})

// =========================================================================
// Priority badge tests
// =========================================================================

describe('SortableBlock priority badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('displays "1" for priority 1', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority 1/i })
    expect(badge).toHaveTextContent('1')
  })

  it('displays "2" for priority 2', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="2"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority 2/i })
    expect(badge).toHaveTextContent('2')
  })

  it('displays "3" for priority 3', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="3"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority 3/i })
    expect(badge).toHaveTextContent('3')
  })

  it('does not render priority badge when no priority is set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority={null}
      />,
    )

    expect(container.querySelector('.priority-badge')).not.toBeInTheDocument()
  })

  it('calls onTogglePriority with blockId when clicked', async () => {
    const user = userEvent.setup()
    const onTogglePriority = vi.fn()

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
        onTogglePriority={onTogglePriority}
      />,
    )

    const badge = screen.getByRole('button', { name: /priority 1/i })
    await user.click(badge)

    expect(onTogglePriority).toHaveBeenCalledOnce()
    expect(onTogglePriority).toHaveBeenCalledWith('BLOCK_42')
  })

  it('does not crash when onTogglePriority is not provided', async () => {
    const user = userEvent.setup()

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority 1/i })
    // Should not throw
    await user.click(badge)
  })

  it('applies red styling for priority 1', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const badge = container.querySelector('.priority-badge > div')
    expect(badge?.className).toContain('bg-red-100')
    expect(badge?.className).toContain('text-red-700')
    expect(badge?.className).toContain('ring-2')
    expect(badge?.className).toContain('ring-red-400')
  })

  it('applies yellow styling for priority 2', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="2"
      />,
    )

    const badge = container.querySelector('.priority-badge > div')
    expect(badge?.className).toContain('bg-yellow-100')
    expect(badge?.className).toContain('text-yellow-700')
  })

  it('applies blue styling for priority 3', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="3"
      />,
    )

    const badge = container.querySelector('.priority-badge > div')
    expect(badge?.className).toContain('bg-blue-100')
    expect(badge?.className).toContain('text-blue-700')
    expect(badge?.className).toContain('border-dashed')
    expect(badge?.className).toContain('border-blue-400')
  })

  it('does not render priority badge when priority is null (hidden)', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority={null}
      />,
    )

    expect(container.querySelector('.priority-badge')).not.toBeInTheDocument()
  })

  it('renders priority badge when priority is set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="2"
      />,
    )

    const badge = container.querySelector('.priority-badge')
    expect(badge).toBeInTheDocument()
  })

  it('has proper aria-label with priority level when set', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="2"
      />,
    )

    expect(screen.getByRole('button', { name: 'Priority 2. Click to cycle.' })).toBeInTheDocument()
  })

  it('priority badge has correct aria-label for priority 1', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    expect(screen.getByRole('button', { name: /Priority 1.*Click to cycle/i })).toBeInTheDocument()
  })

  it('priority badge has correct aria-label for priority 3', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="3"
      />,
    )

    expect(screen.getByRole('button', { name: /Priority 3.*Click to cycle/i })).toBeInTheDocument()
  })

  it('priority badge has mt-1.5 for first-line alignment', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const badge = container.querySelector('.priority-badge')
    expect(badge?.className).toContain('mt-1.5')
  })
})

// =========================================================================
// Visibility / hover / focus tests
// =========================================================================

describe('SortableBlock visibility controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('applies block-active class when isFocused is true', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={true}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.firstElementChild?.className).toContain('block-active')
  })

  it('does not apply block-active class when isFocused is false', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.firstElementChild?.className).not.toContain('block-active')
  })

  it('drag handle has opacity-0 class (hidden by default)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).toContain('opacity-0')
  })

  it('drag handle has group-hover:opacity-100 class for hover reveal', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).toContain('group-hover:opacity-100')
  })

  it('drag handle has [.block-active_&]:opacity-100 class for focus reveal', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).toContain('[.block-active_&]:opacity-100')
  })

  it('delete handle has opacity-0 class (hidden by default)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).toContain('opacity-0')
  })

  it('delete handle has group-hover:opacity-100 class for hover reveal', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).toContain('group-hover:opacity-100')
  })

  it('collapse toggle does NOT have opacity-0 class (always visible when hasChildren)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )

    const collapseBtn = screen.getByRole('button', { name: /collapse children/i })
    expect(collapseBtn.className).not.toContain('opacity-0')
  })

  it('priority badge is not rendered when no priority is set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority={null}
      />,
    )

    expect(container.querySelector('.priority-badge')).not.toBeInTheDocument()
  })

  it('wrapper has group class for group-hover to work', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.firstElementChild?.className).toContain('group')
  })
})

// =========================================================================
// Inline controls container tests
// =========================================================================

describe('SortableBlock inline controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('has an inline-controls container', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.querySelector('.inline-controls')).toBeInTheDocument()
  })

  it('chevron is inside inline-controls, not the gutter', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const collapseBtn = inlineControls?.querySelector('.collapse-toggle')
    expect(collapseBtn).toBeInTheDocument()
  })

  it('checkbox is inside inline-controls', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const marker = inlineControls?.querySelector('.task-marker')
    expect(marker).toBeInTheDocument()
  })

  it('priority badge is inside inline-controls when set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const badge = inlineControls?.querySelector('.priority-badge')
    expect(badge).toBeInTheDocument()
  })

  it('gutter width is w-[44px]', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const gutter = container.querySelector('.w-\\[44px\\]')
    expect(gutter).toBeInTheDocument()
  })

  it('outer wrapper uses gap-1 for uniform spacing between gutter and inline controls', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block')
    expect(wrapper?.className).toContain('gap-1')
    expect(wrapper?.className).not.toContain('gap-0')
  })

  it('gutter uses gap-1 between grip and delete', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const gutter = container.querySelector('.w-\\[44px\\]')
    expect(gutter?.className).toContain('gap-1')
  })

  it('gutter has no flex-1 spacer between grip and delete', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const gutter = container.querySelector('.w-\\[44px\\]')
    // Gutter should have exactly 2 children (grip + delete), no spacer div
    const children = gutter?.children
    expect(children?.length).toBe(2)
    // Both should be buttons
    expect(children?.[0]?.tagName).toBe('BUTTON')
    expect(children?.[1]?.tagName).toBe('BUTTON')
  })

  it('inline controls use gap-1 between items', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
        onTogglePriority={vi.fn()}
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('gap-1')
  })

  it('all control buttons share mt-1.5 for vertical alignment', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={true}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
        onToggleTodo={vi.fn()}
        priority="1"
        onTogglePriority={vi.fn()}
      />,
    )

    const grip = container.querySelector('.drag-handle')
    const del = container.querySelector('.delete-handle')
    const checkbox = container.querySelector('.task-marker')
    const badge = container.querySelector('.priority-badge')

    expect(grip?.className).toContain('mt-1.5')
    expect(del?.className).toContain('mt-1.5')
    expect(checkbox?.className).toContain('mt-1.5')
    expect(badge?.className).toContain('mt-1.5')
  })
})

// =========================================================================
// A11y enhancements tests
// =========================================================================

describe('SortableBlock a11y enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('chevron has aria-expanded=true when not collapsed', () => {
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

    const collapseBtn = screen.getByRole('button', { name: /collapse children/i })
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true')
  })

  it('chevron has aria-expanded=false when collapsed', () => {
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

    const collapseBtn = screen.getByRole('button', { name: /expand children/i })
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'false')
  })

  it('drag handle has focus-visible:ring-2 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).toContain('focus-visible:ring-2')
  })

  it('delete button has focus-visible:ring-2 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).toContain('focus-visible:ring-2')
  })

  it('chevron has focus-visible:ring-2 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )

    const collapseBtn = screen.getByRole('button', { name: /collapse children/i })
    expect(collapseBtn.className).toContain('focus-visible:ring-2')
  })

  it('checkbox has focus-visible:ring-2 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const marker = screen.getByRole('button', { name: /set as todo/i })
    expect(marker.className).toContain('focus-visible:ring-2')
  })

  it('all buttons have active:scale-95 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
        hasChildren
        priority="1"
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    const collapseBtn = screen.getByRole('button', { name: /collapse children/i })
    const marker = screen.getByRole('button', { name: /set as todo/i })
    const badge = screen.getByRole('button', { name: /priority 1/i })

    for (const btn of [handle, deleteBtn, collapseBtn, marker, badge]) {
      expect(btn.className).toContain('active:scale-95')
    }
  })

  it('drag handle has focus-visible:opacity-100 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).toContain('focus-visible:opacity-100')
  })

  it('delete button has focus-visible:opacity-100 class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).toContain('focus-visible:opacity-100')
  })

  it('empty checkbox has border-muted-foreground/40 (not border-transparent)', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState={null}
      />,
    )

    const emptyCheckbox = container.querySelector('.task-checkbox-empty')
    expect(emptyCheckbox?.className).toContain('border-muted-foreground/40')
    expect(emptyCheckbox?.className).not.toContain('border-transparent')
  })

  it('has no a11y violations', async () => {
    mockUseSortable.mockReturnValue(makeSortable())

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello world"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// =========================================================================
// Long-press gesture & context menu tests (#183, #184)
// =========================================================================

describe('SortableBlock long-press and context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('long-press touch opens context menu after 400ms delay', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    // Context menu should not exist initially
    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()

    // Start touch
    fireEvent.touchStart(wrapper, {
      touches: [{ clientX: 100, clientY: 200 }],
    })

    // Before delay, no context menu
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()

    // After full delay (400ms), context menu should appear
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('block-context-menu')).toBeInTheDocument()
  })

  it('touch move beyond threshold cancels long-press', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    // Start touch at (100, 100)
    fireEvent.touchStart(wrapper, {
      touches: [{ clientX: 100, clientY: 100 }],
    })

    // Move beyond threshold (LONG_PRESS_MOVE_THRESHOLD = 10px)
    fireEvent.touchMove(wrapper, {
      touches: [{ clientX: 115, clientY: 100 }], // 15px away
    })

    // Advance past delay
    act(() => {
      vi.advanceTimersByTime(500)
    })

    // Context menu should NOT appear (gesture was cancelled)
    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()
  })

  it('touch end before delay clears the long-press timer', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    // Start touch
    fireEvent.touchStart(wrapper, {
      touches: [{ clientX: 100, clientY: 100 }],
    })

    // End touch before delay fires
    fireEvent.touchEnd(wrapper)

    // Advance past delay
    act(() => {
      vi.advanceTimersByTime(500)
    })

    // Context menu should NOT appear
    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()
  })

  it('right-click opens context menu', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    fireEvent.contextMenu(wrapper, { clientX: 50, clientY: 75 })

    expect(screen.getByTestId('block-context-menu')).toBeInTheDocument()
  })

  it('context menu receives correct blockId', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    fireEvent.contextMenu(wrapper, { clientX: 50, clientY: 75 })

    expect(screen.getByTestId('context-menu-block-id')).toHaveTextContent('BLOCK_42')
  })

  it('context menu closes when onClose callback is triggered', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    fireEvent.contextMenu(wrapper, { clientX: 50, clientY: 75 })
    expect(screen.getByTestId('block-context-menu')).toBeInTheDocument()

    // Click close button (triggers onClose callback)
    fireEvent.click(screen.getByTestId('close-context-menu'))

    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()
  })
})

// =========================================================================
// Drag-cancels-long-press tests (#116)
// =========================================================================

describe('SortableBlock drag cancels long-press', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears long-press timer when isDragging becomes true', () => {
    // Start with isDragging = false
    mockUseSortable.mockReturnValue({ ...makeSortable(), isDragging: false })

    const { container, rerender } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    // Start a touch (starts the long-press timer)
    fireEvent.touchStart(wrapper, {
      touches: [{ clientX: 100, clientY: 200 }],
    })

    // Simulate drag starting at 250ms (before long-press fires at 400ms)
    act(() => {
      vi.advanceTimersByTime(250)
    })

    // Re-render with isDragging = true (simulates dnd-kit activating drag)
    mockUseSortable.mockReturnValue({ ...makeSortable(), isDragging: true })
    rerender(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    // Advance past the original long-press delay
    act(() => {
      vi.advanceTimersByTime(200)
    })

    // Context menu should NOT appear because drag cancelled the timer
    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()
  })

  it('does not open context menu if drag is active when long-press timeout fires', () => {
    // Start with isDragging = true from the beginning
    mockUseSortable.mockReturnValue({ ...makeSortable(), isDragging: true })

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    // Start touch (even though drag is already active)
    fireEvent.touchStart(wrapper, {
      touches: [{ clientX: 100, clientY: 200 }],
    })

    // Advance past the long-press delay
    act(() => {
      vi.advanceTimersByTime(500)
    })

    // Context menu should NOT appear because isDraggingRef is true
    expect(screen.queryByTestId('block-context-menu')).not.toBeInTheDocument()
  })

  it('allows context menu when drag ends before long-press fires', () => {
    // Start not dragging
    mockUseSortable.mockReturnValue({ ...makeSortable(), isDragging: false })

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const wrapper = container.querySelector('.sortable-block') as HTMLElement

    // Start touch
    fireEvent.touchStart(wrapper, {
      touches: [{ clientX: 100, clientY: 200 }],
    })

    // Advance past the long-press delay (400ms) — no drag started
    act(() => {
      vi.advanceTimersByTime(400)
    })

    // Context menu SHOULD appear because isDragging was never true
    expect(screen.getByTestId('block-context-menu')).toBeInTheDocument()
  })
})

// =========================================================================
// Due date chip tests (#565)
// =========================================================================

describe('SortableBlock due date chip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('does not render due date chip when dueDate is null', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate={null}
      />,
    )

    expect(container.querySelector('.due-date-chip')).not.toBeInTheDocument()
  })

  it('does not render due date chip when dueDate is undefined', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.querySelector('.due-date-chip')).not.toBeInTheDocument()
  })

  it('renders due date chip with CalendarDays icon when dueDate is set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2025-06-15"
      />,
    )

    expect(container.querySelector('.due-date-chip')).toBeInTheDocument()
    expect(screen.getByTestId('calendar-days-icon')).toBeInTheDocument()
  })

  it('formats current-year date as "Mon DD" (no year)', () => {
    const now = new Date()
    const year = now.getFullYear()
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate={`${year}-03-15`}
      />,
    )

    // Should show "Mar 15" without year
    expect(screen.getByText('Mar 15')).toBeInTheDocument()
  })

  it('formats past-year date as "Mon DD, YYYY"', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2023-12-25"
      />,
    )

    expect(screen.getByText('Dec 25, 2023')).toBeInTheDocument()
  })

  it('has aria-label with formatted date', () => {
    const now = new Date()
    const year = now.getFullYear()
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate={`${year}-07-04`}
      />,
    )

    const chip = screen.getByLabelText('Due Jul 4')
    expect(chip).toBeInTheDocument()
  })

  it('due date chip is inside inline-controls', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2025-06-15"
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const chip = inlineControls?.querySelector('.due-date-chip')
    expect(chip).toBeInTheDocument()
  })

  it('applies red styling for overdue dates', () => {
    // Use a date far in the past to ensure it's always overdue
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2020-01-01"
      />,
    )

    const chip = container.querySelector('.due-date-chip')
    expect(chip?.className).toContain('bg-red-100')
    expect(chip?.className).toContain('text-red-700')
  })

  it('applies muted styling for future dates', () => {
    // Use a date far in the future
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2099-12-31"
      />,
    )

    const chip = container.querySelector('.due-date-chip')
    expect(chip?.className).toContain('bg-muted')
    expect(chip?.className).toContain('text-muted-foreground')
  })

  it('renders due date chip after priority badge when both are set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
        dueDate="2025-06-15"
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const priorityBadge = inlineControls?.querySelector('.priority-badge')
    const dueChip = inlineControls?.querySelector('.due-date-chip')
    expect(priorityBadge).toBeInTheDocument()
    expect(dueChip).toBeInTheDocument()

    // Priority badge should come before due date chip in DOM order
    const children = Array.from(inlineControls?.children ?? [])
    const priorityIdx = children.indexOf(priorityBadge as Element)
    const dueIdx = children.indexOf(dueChip as Element)
    expect(priorityIdx).toBeLessThan(dueIdx)
  })

  it('renders invalid date string as-is without crashing', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="not-a-date"
      />,
    )

    const chip = container.querySelector('.due-date-chip')
    expect(chip).toBeInTheDocument()
    expect(chip?.textContent).toContain('not-a-date')
  })

  it('applies amber styling for today due date', () => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate={todayStr}
      />,
    )

    const chip = container.querySelector('.due-date-chip')
    expect(chip?.className).toContain('bg-amber-100')
    expect(chip?.className).toContain('text-amber-700')
  })

  it('renders all three indicators simultaneously', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
        priority="1"
        dueDate="2026-06-15"
      />,
    )

    // Task checkbox is visible
    const todoCheckbox = container.querySelector('.task-checkbox-todo')
    expect(todoCheckbox).toBeInTheDocument()

    // Priority badge is visible
    const priorityBadge = container.querySelector('.priority-badge')
    expect(priorityBadge).toBeInTheDocument()

    // Due date chip is visible
    const dueChip = container.querySelector('.due-date-chip')
    expect(dueChip).toBeInTheDocument()
  })

  it('has no a11y violations with all indicators', async () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
        priority="1"
        dueDate="2026-06-15"
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
