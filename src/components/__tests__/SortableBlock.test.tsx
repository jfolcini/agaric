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

// Mock PropertyChip with a simple rendering that passes through onClick and onKeyClick
vi.mock('../PropertyChip', () => ({
  PropertyChip: (props: {
    propKey: string
    value: string
    onClick?: () => void
    onKeyClick?: () => void
  }) => (
    <button
      type="button"
      data-testid={`property-chip-${props.propKey}`}
      className="property-chip"
      onClick={props.onClick}
    >
      <button
        data-testid={`property-key-${props.propKey}`}
        type="button"
        onClick={(e: { stopPropagation: () => void }) => {
          e.stopPropagation()
          props.onKeyClick?.()
        }}
      >
        {props.propKey}:
      </button>
      <span>{props.value}</span>
    </button>
  ),
}))

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Calendar: (props: { size: number; className?: string }) => (
    <svg
      data-testid="calendar-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
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
  Clock: (props: { size: number; className?: string }) => (
    <svg
      data-testid="clock-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  GripVertical: (props: { size: number }) => (
    <svg data-testid="grip-vertical-icon" width={props.size} height={props.size} />
  ),
  Paperclip: (props: { size: number; className?: string }) => (
    <svg
      data-testid="paperclip-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  Repeat: (props: { size: number; className?: string }) => (
    <svg
      data-testid="repeat-icon"
      width={props.size}
      height={props.size}
      className={props.className}
    />
  ),
  Trash2: (props: { size: number }) => (
    <svg data-testid="trash-icon" width={props.size} height={props.size} />
  ),
  X: (props: { size: number; className?: string }) => (
    <svg data-testid="x-icon" width={props.size} height={props.size} className={props.className} />
  ),
}))

// Mock AttachmentList to avoid its own hook/tauri dependencies
vi.mock('../AttachmentList', () => ({
  AttachmentList: ({ blockId }: { blockId: string }) => (
    <div data-testid={`attachment-list-${blockId}`}>AttachmentList</div>
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

// Mock tauri setProperty, listPropertyDefs, listBlocks, and listAttachments
const mockSetProperty = vi.fn().mockResolvedValue({})
const mockListPropertyDefs = vi.fn().mockResolvedValue([])
const mockListBlocks = vi.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false })
const mockListAttachments = vi.fn().mockResolvedValue([])
vi.mock('../../lib/tauri', () => ({
  setProperty: (...args: unknown[]) => mockSetProperty(...args),
  listPropertyDefs: (...args: unknown[]) => mockListPropertyDefs(...args),
  listBlocks: (...args: unknown[]) => mockListBlocks(...args),
  listAttachments: (...args: unknown[]) => mockListAttachments(...args),
}))

// Mock sonner toast
const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
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
    getMarkdown: vi.fn(() => null),
    originalMarkdown: '',
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

  it('calls onDelete with blockId when delete button is pointer-downed', async () => {
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
    fireEvent.pointerDown(deleteBtn)

    expect(onDelete).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledWith('BLOCK_42')
  })

  it('delete button stopPropagation on pointerDown prevents parent activation', () => {
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
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const stopSpy = vi.spyOn(event, 'stopPropagation')
    deleteBtn.dispatchEvent(event)

    expect(stopSpy).toHaveBeenCalled()
    expect(onDelete).toHaveBeenCalledWith('BLOCK_1')
  })

  it('delete button responds to keyboard activation (Enter/Space)', async () => {
    mockUseSortable.mockReturnValue({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    })

    const onDelete = vi.fn()
    const user = userEvent.setup()

    render(
      <SortableBlock
        blockId="BLOCK_KB"
        content="keyboard test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={onDelete}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    await user.click(deleteBtn)

    expect(onDelete).toHaveBeenCalledWith('BLOCK_KB')
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

describe('SortableBlock history button', () => {
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

  it('does not render history button when onShowHistory is not provided', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(screen.queryByRole('button', { name: /block history/i })).not.toBeInTheDocument()
  })

  it('renders history button when onShowHistory is provided', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onShowHistory={vi.fn()}
      />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn).toBeInTheDocument()
    expect(screen.getByTestId('clock-icon')).toBeInTheDocument()
  })

  it('calls onShowHistory with blockId when history button is clicked', async () => {
    const user = userEvent.setup()
    const onShowHistory = vi.fn()

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onShowHistory={onShowHistory}
      />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    await user.click(historyBtn)

    expect(onShowHistory).toHaveBeenCalledOnce()
    expect(onShowHistory).toHaveBeenCalledWith('BLOCK_42')
  })

  it('history button has correct hover opacity classes', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onShowHistory={vi.fn()}
      />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn.className).toContain('opacity-0')
    expect(historyBtn.className).toContain('group-hover:opacity-100')
  })
})

describe('SortableBlock gutter button pointer-events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('delete button has pointer-events-none when invisible (opacity-0)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_PE"
        content="pointer-events test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).toContain('opacity-0')
    expect(deleteBtn.className).toContain('pointer-events-none')
    expect(deleteBtn.className).toContain('group-hover:pointer-events-auto')
  })

  it('drag handle has pointer-events-none when invisible (opacity-0)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_PE"
        content="pointer-events test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).toContain('opacity-0')
    expect(dragHandle.className).toContain('pointer-events-none')
    expect(dragHandle.className).toContain('group-hover:pointer-events-auto')
  })

  it('history button has pointer-events-none when invisible (opacity-0)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_PE"
        content="pointer-events test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onShowHistory={vi.fn()}
      />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn.className).toContain('opacity-0')
    expect(historyBtn.className).toContain('pointer-events-none')
    expect(historyBtn.className).toContain('group-hover:pointer-events-auto')
  })

  it('gutter div has relative z-10 so overflowing buttons paint above siblings', () => {
    render(
      <SortableBlock
        blockId="BLOCK_Z"
        content="z-index test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
        onShowHistory={vi.fn()}
      />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    const gutterDiv = dragHandle.parentElement as HTMLElement
    expect(gutterDiv.className).toContain('relative')
    expect(gutterDiv.className).toContain('z-10')
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

  it('does not render spacer when hasChildren is false', () => {
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
    const spacer = inlineControls?.querySelector('.w-5')
    expect(spacer).not.toBeInTheDocument()
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

  it('applies border-task-doing class to DOING checkbox', () => {
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
    expect(checkbox?.getAttribute('class')).toContain('border-task-doing')
  })

  it('applies border-task-done and bg-task-done class to DONE checkbox', () => {
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
    expect(checkbox?.getAttribute('class')).toContain('border-task-done')
    expect(checkbox?.getAttribute('class')).toContain('bg-task-done')
  })

  it('applies border-task-cancelled class to CANCELLED checkbox (UX-202)', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="CANCELLED"
      />,
    )

    const checkbox = container.querySelector('.task-checkbox-cancelled')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox?.getAttribute('class')).toContain('border-task-cancelled')
    expect(checkbox?.getAttribute('data-testid')).toBe('task-checkbox-cancelled')
  })

  it('applies line-through and opacity-50 to content when CANCELLED (UX-202)', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="CANCELLED"
      />,
    )

    const contentWrapper = container.querySelector('.line-through')
    expect(contentWrapper).toBeInTheDocument()
    expect(contentWrapper?.getAttribute('class')).toContain('opacity-50')
  })

  it('does not apply CANCELLED strikethrough when block is focused (UX-202)', () => {
    render(
      <SortableBlock
        blockId="B1"
        content="cancelled task"
        isFocused={true}
        depth={0}
        rovingEditor={makeRovingEditor()}
        todoState="CANCELLED"
      />,
    )
    const editableBlock = screen.getByTestId('editable-block-B1')
    const contentWrapper = editableBlock.parentElement
    expect(contentWrapper?.className).not.toContain('line-through')
    expect(contentWrapper?.className).not.toContain('opacity-50')
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

  it('applies transition classes to task content wrapper', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="DONE"
      />,
    )

    const contentWrapper = container.querySelector('.line-through')
    expect(contentWrapper).toBeInTheDocument()
    expect(contentWrapper?.className).toContain('transition-')
    expect(contentWrapper?.className).toContain('duration-200')
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

  it('does not apply DONE strikethrough/opacity when block is focused', () => {
    render(
      <SortableBlock
        blockId="B1"
        content="done task"
        isFocused={true}
        depth={0}
        rovingEditor={makeRovingEditor()}
        todoState="DONE"
      />,
    )
    // The content wrapper should NOT have line-through when focused
    const editableBlock = screen.getByTestId('editable-block-B1')
    const contentWrapper = editableBlock.parentElement
    expect(contentWrapper?.className).not.toContain('line-through')
    expect(contentWrapper?.className).not.toContain('opacity-50')
    // Transition classes should still be present
    expect(contentWrapper?.className).toContain('transition-')
    expect(contentWrapper?.className).toContain('duration-200')
  })

  it('applies DONE strikethrough/opacity when block is not focused', () => {
    render(
      <SortableBlock
        blockId="B1"
        content="done task"
        isFocused={false}
        depth={0}
        rovingEditor={makeRovingEditor()}
        todoState="DONE"
      />,
    )
    const editableBlock = screen.getByTestId('editable-block-B1')
    const contentWrapper = editableBlock.parentElement
    expect(contentWrapper?.className).toContain('line-through')
    expect(contentWrapper?.className).toContain('opacity-50')
    // Transition classes should be present
    expect(contentWrapper?.className).toContain('transition-')
    expect(contentWrapper?.className).toContain('duration-200')
  })
})

describe('gutter alignment', () => {
  it('gutter container uses items-center for vertical alignment', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )
    const gutter = container.querySelector('.w-\\[68px\\]')
    expect(gutter).toBeInTheDocument()
    expect(gutter?.className).toContain('items-center')
  })

  it('inline-controls container uses items-center for vertical alignment', () => {
    mockUseSortable.mockReturnValue(makeSortable())
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('items-center')
  })

  it('drag handle has p-0.5 for alignment', () => {
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
    expect(handle.className).toContain('p-0.5')
    expect(handle.className).not.toContain('mt-1')
  })

  it('delete button has p-0.5 for alignment', () => {
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
    expect(deleteBtn.className).toContain('p-0.5')
    expect(deleteBtn.className).not.toContain('mt-1')
  })

  it('due date chip does not have mt-1 (alignment via container pt-1)', () => {
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
    expect(chip?.className).not.toContain('mt-1')
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

  it('displays "P1" for priority 1', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority P1/i })
    expect(badge).toHaveTextContent('P1')
  })

  it('displays "P2" for priority 2', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="2"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority P2/i })
    expect(badge).toHaveTextContent('P2')
  })

  it('displays "P3" for priority 3', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="3"
      />,
    )

    const badge = screen.getByRole('button', { name: /priority P3/i })
    expect(badge).toHaveTextContent('P3')
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

    const badge = screen.getByRole('button', { name: /priority P1/i })
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

    const badge = screen.getByRole('button', { name: /priority P1/i })
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

    const badge = container.querySelector('.priority-badge > span')
    expect(badge?.className).toContain('bg-priority-urgent')
    expect(badge?.className).toContain('text-priority-foreground')
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

    const badge = container.querySelector('.priority-badge > span')
    expect(badge?.className).toContain('bg-priority-high')
    expect(badge?.className).toContain('text-priority-foreground')
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

    const badge = container.querySelector('.priority-badge > span')
    expect(badge?.className).toContain('bg-priority-normal')
    expect(badge?.className).toContain('text-priority-foreground')
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

    expect(screen.getByRole('button', { name: 'Priority P2. Click to cycle.' })).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: /Priority P1.*Click to cycle/i })).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: /Priority P3.*Click to cycle/i })).toBeInTheDocument()
  })

  it('priority badge does not have mt-1 (alignment via container pt-1)', () => {
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
    expect(badge?.className).not.toContain('mt-1')
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

  it('drag handle has no per-button coarse-pointer classes for touch devices', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).not.toContain('max-sm:hidden')
    expect(handle.className).not.toContain('max-sm:flex')
  })

  it('history button has no per-button coarse-pointer classes for touch devices', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onShowHistory={vi.fn()}
      />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn.className).not.toContain('max-sm:hidden')
    expect(historyBtn.className).not.toContain('max-sm:flex')
  })

  it('delete handle has no per-button coarse-pointer classes for touch devices', () => {
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
    expect(deleteBtn.className).not.toContain('max-sm:hidden')
    expect(deleteBtn.className).not.toContain('max-sm:flex')
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

  it('gutter width is w-[68px]', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const gutter = container.querySelector('.w-\\[68px\\]')
    expect(gutter).toBeInTheDocument()
  })

  it('outer wrapper uses gap-1 for uniform spacing between sections', () => {
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

    const gutter = container.querySelector('.w-\\[68px\\]')
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

    const gutter = container.querySelector('.w-\\[68px\\]')
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

  it('alignment handled by items-center instead of per-element mt-1', () => {
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

    // Individual elements no longer have mt-1
    expect(grip?.className).not.toContain('mt-1')
    expect(del?.className).not.toContain('mt-1')
    expect(checkbox?.className).not.toContain('mt-1')
    expect(badge?.className).not.toContain('mt-1')

    // Containers use items-center instead
    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('items-center')
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

  it('drag handle has focus-ring class', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const handle = screen.getByRole('button', { name: /reorder block/i })
    expect(handle.className).toContain('focus-ring')
  })

  it('delete button has focus-ring class', () => {
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
    expect(deleteBtn.className).toContain('focus-ring')
  })

  it('chevron has focus-visible ring classes', () => {
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
    expect(collapseBtn.className).toContain('focus-visible:ring-[3px]')
    expect(collapseBtn.className).toContain('focus-visible:ring-ring/50')
    expect(collapseBtn.className).toContain('focus-visible:outline-hidden')
  })

  it('checkbox has focus-visible ring classes', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const marker = screen.getByRole('button', { name: /set as todo/i })
    expect(marker.className).toContain('focus-visible:ring-[3px]')
    expect(marker.className).toContain('focus-visible:ring-ring/50')
    expect(marker.className).toContain('focus-visible:outline-hidden')
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
    const badge = screen.getByRole('button', { name: /priority P1/i })

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

    // Click close button (triggers onClose callback via mock boundary)
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
    expect(chip?.className).toContain('bg-destructive/10')
    expect(chip?.className).toContain('text-destructive')
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
    expect(chip?.className).toContain('bg-status-pending')
    expect(chip?.className).toContain('text-status-pending-foreground')
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

// =========================================================================
// Scheduled date chip tests (#592)
// =========================================================================

describe('SortableBlock scheduled date chip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('does not render scheduled chip when scheduledDate is null', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate={null}
      />,
    )

    expect(container.querySelector('.scheduled-chip')).not.toBeInTheDocument()
  })

  it('does not render scheduled chip when scheduledDate is undefined', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.querySelector('.scheduled-chip')).not.toBeInTheDocument()
  })

  it('renders scheduled chip with Calendar icon when scheduledDate is set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate="2025-06-15"
      />,
    )

    expect(container.querySelector('.scheduled-chip')).toBeInTheDocument()
    expect(screen.getByTestId('calendar-icon')).toBeInTheDocument()
  })

  it('shows formatted date text for current year', () => {
    const now = new Date()
    const year = now.getFullYear()
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate={`${year}-03-15`}
      />,
    )

    // Should show "Mar 15" without year
    expect(screen.getByText('Mar 15')).toBeInTheDocument()
  })

  it('shows formatted date text with year for past year', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate="2023-12-25"
      />,
    )

    expect(screen.getByText('Dec 25, 2023')).toBeInTheDocument()
  })

  it('has correct aria-label with formatted date', () => {
    const now = new Date()
    const year = now.getFullYear()
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate={`${year}-07-04`}
      />,
    )

    const chip = screen.getByLabelText('Scheduled Jul 4')
    expect(chip).toBeInTheDocument()
  })

  it('scheduled chip is inside inline-controls', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate="2025-06-15"
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const chip = inlineControls?.querySelector('.scheduled-chip')
    expect(chip).toBeInTheDocument()
  })

  it('applies purple styling for scheduled date', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate="2025-06-15"
      />,
    )

    const chip = container.querySelector('.scheduled-chip')
    expect(chip?.className).toContain('bg-date-scheduled')
    expect(chip?.className).toContain('text-date-scheduled-foreground')
  })

  it('renders both due date and scheduled date chips when both are set', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2025-06-15"
        scheduledDate="2025-06-10"
      />,
    )

    expect(container.querySelector('.due-date-chip')).toBeInTheDocument()
    expect(container.querySelector('.scheduled-chip')).toBeInTheDocument()
  })
})

// =========================================================================
// Property chips tests
// =========================================================================

describe('SortableBlock property chips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('renders property chips when properties are provided', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'effort', value: '2h' },
          { key: 'assignee', value: 'Alice' },
        ]}
      />,
    )

    expect(screen.getByTestId('property-chip-effort')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-assignee')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-effort')).toHaveTextContent('effort:2h')
    expect(screen.getByTestId('property-chip-assignee')).toHaveTextContent('assignee:Alice')
  })

  it('does not render property chips when properties is undefined', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    expect(container.querySelector('.property-chip')).not.toBeInTheDocument()
  })

  it('does not render property chips when properties is empty', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[]}
      />,
    )

    expect(container.querySelector('.property-chip')).not.toBeInTheDocument()
  })

  it('shows at most 3 property chips', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'effort', value: '2h' },
          { key: 'assignee', value: 'Alice' },
          { key: 'location', value: 'Office' },
          { key: 'repeat', value: 'weekly' },
        ]}
      />,
    )

    expect(screen.getByTestId('property-chip-effort')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-assignee')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-location')).toBeInTheDocument()
    expect(screen.queryByTestId('property-chip-repeat')).not.toBeInTheDocument()
  })

  it('shows overflow "+N" indicator when more than 3 non-repeat properties', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'effort', value: '2h' },
          { key: 'assignee', value: 'Alice' },
          { key: 'location', value: 'Office' },
          { key: 'context', value: '@phone' },
        ]}
      />,
    )

    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('shows correct overflow count for 5 properties (repeat rendered separately)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'effort', value: '2h' },
          { key: 'assignee', value: 'Alice' },
          { key: 'location', value: 'Office' },
          { key: 'repeat', value: 'weekly' },
          { key: 'custom', value: 'test' },
        ]}
      />,
    )

    // repeat is rendered as icon, 4 non-repeat properties: 3 shown + 1 overflow
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByTestId('repeat-icon')).toBeInTheDocument()
  })

  it('does not show overflow indicator when 3 or fewer properties', () => {
    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'effort', value: '2h' },
          { key: 'assignee', value: 'Alice' },
        ]}
      />,
    )

    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it('property chips are inside inline-controls', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'effort', value: '2h' }]}
      />,
    )

    const inlineControls = container.querySelector('.inline-controls')
    const chip = inlineControls?.querySelector('.property-chip')
    expect(chip).toBeInTheDocument()
  })

  it('does not render created_at or completed_at as inline property chips', () => {
    render(
      <SortableBlock
        blockId="B1"
        content="test block"
        isFocused={false}
        depth={0}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'created_at', value: '2024-01-01' },
          { key: 'completed_at', value: '2024-01-02' },
          { key: 'effort', value: '2h' },
        ]}
      />,
    )
    // created_at and completed_at should be filtered out
    expect(screen.queryByTestId('property-chip-created_at')).not.toBeInTheDocument()
    expect(screen.queryByTestId('property-chip-completed_at')).not.toBeInTheDocument()
    // Other properties should still render
    expect(screen.getByTestId('property-chip-effort')).toBeInTheDocument()
  })
})

// =========================================================================
// Property chip click-to-edit tests
// =========================================================================

describe('SortableBlock property chip click-to-edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
    mockSetProperty.mockResolvedValue({})
  })

  it('clicking a property chip shows edit input', async () => {
    const user = userEvent.setup()

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'effort', value: '2h' }]}
      />,
    )

    // No input initially
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    // Click the property chip
    const chip = screen.getByTestId('property-chip-effort')
    await user.click(chip)

    // Input should now be visible with the property value
    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('2h')
  })

  it('clicking a select-type property chip shows options dropdown', async () => {
    const user = userEvent.setup()

    // Mock listPropertyDefs to return a select-type definition for 'status'
    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'status',
        value_type: 'select',
        options: JSON.stringify(['Backlog', 'In Progress', 'Done']),
        created_at: '2025-01-01T00:00:00Z',
      },
    ])

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'status', value: 'Backlog' }]}
      />,
    )

    // No dropdown initially
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()

    // Click the property chip
    const chip = screen.getByTestId('property-chip-status')
    await user.click(chip)

    // Wait for the select options dropdown to appear
    await waitFor(() => {
      expect(screen.getByTestId('select-options-dropdown')).toBeInTheDocument()
    })

    // Verify all options are rendered as buttons
    expect(screen.getByRole('button', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'In Progress' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()

    // No text input should be shown
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('clicking a select option calls setProperty and closes dropdown', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'priority_level',
        value_type: 'select',
        options: JSON.stringify(['Low', 'Medium', 'High']),
        created_at: '2025-01-01T00:00:00Z',
      },
    ])

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'priority_level', value: 'Low' }]}
      />,
    )

    // Click the property chip to open the dropdown
    const chip = screen.getByTestId('property-chip-priority_level')
    await user.click(chip)

    // Wait for the dropdown
    await waitFor(() => {
      expect(screen.getByTestId('select-options-dropdown')).toBeInTheDocument()
    })

    // Click the 'High' option
    const highOption = screen.getByRole('button', { name: 'High' })
    await user.click(highOption)

    // setProperty should have been called with the selected value
    expect(mockSetProperty).toHaveBeenCalledWith({
      blockId: 'BLOCK_42',
      key: 'priority_level',
      valueText: 'High',
    })

    // Dropdown should be closed
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()
  })

  it('highlights the currently selected option in the dropdown', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'category',
        value_type: 'select',
        options: JSON.stringify(['Bug', 'Feature', 'Chore']),
        created_at: '2025-01-01T00:00:00Z',
      },
    ])

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'category', value: 'Feature' }]}
      />,
    )

    const chip = screen.getByTestId('property-chip-category')
    await user.click(chip)

    await waitFor(() => {
      expect(screen.getByTestId('select-options-dropdown')).toBeInTheDocument()
    })

    // The currently selected option should have the highlight classes
    const featureBtn = screen.getByRole('button', { name: 'Feature' })
    expect(featureBtn.className).toContain('bg-accent')
    expect(featureBtn.className).toContain('font-medium')

    // Other options should NOT have the highlight classes
    const bugBtn = screen.getByRole('button', { name: 'Bug' })
    expect(bugBtn.className).not.toContain('font-medium')
  })

  it('shows text input for non-select property even when defs exist', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'status',
        value_type: 'select',
        options: JSON.stringify(['Backlog', 'Done']),
        created_at: '2025-01-01T00:00:00Z',
      },
    ])

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'effort', value: '2h' }]}
      />,
    )

    const chip = screen.getByTestId('property-chip-effort')
    await user.click(chip)

    // Should show text input, not dropdown, because 'effort' is not a select-type
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()
  })

  it('property edit popover has role="dialog" when open', async () => {
    const user = userEvent.setup()

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'effort', value: '2h' }]}
      />,
    )

    // No dialog initially
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Click the property chip to open the edit popover
    const chip = screen.getByTestId('property-chip-effort')
    await user.click(chip)

    // The popover should now be visible as a dialog (non-modal — no focus trap)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).not.toHaveAttribute('aria-modal')
    expect(dialog).toHaveAttribute('aria-label', 'Edit property')
  })
})

// =========================================================================
// Vertical alignment regression tests (#644 task 0b)
// =========================================================================

describe('SortableBlock vertical alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('sortable-block row has gap-1 for uniform inter-section spacing', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const row = container.querySelector('.sortable-block')
    expect(row?.className).toContain('gap-1')
  })

  it('gutter and inline-controls both use items-center for vertical alignment', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        priority="1"
        dueDate="2026-06-15"
        scheduledDate="2026-06-10"
      />,
    )

    // Find gutter via w-[68px] class selector
    const gutter = container.querySelector('.w-\\[68px\\]')
    expect(gutter?.className).toContain('items-center')

    // inline-controls has items-center
    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('items-center')
  })

  it('no element inside gutter or inline-controls uses mt-1', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        todoState="TODO"
        priority="1"
        dueDate="2026-06-15"
        scheduledDate="2026-06-10"
        properties={[
          { key: 'repeat', value: '+1w' },
          { key: 'effort', value: '2h' },
        ]}
      />,
    )

    // Check all elements that previously had mt-1
    const dragHandle = container.querySelector('.drag-handle')
    const collapseToggle = container.querySelector('.collapse-toggle')
    const taskMarker = container.querySelector('.task-marker')
    const priorityBadge = container.querySelector('.priority-badge')
    const dueDateChip = container.querySelector('.due-date-chip')
    const scheduledChip = container.querySelector('.scheduled-chip')
    const repeatIndicator = container.querySelector('.repeat-indicator')

    for (const el of [
      dragHandle,
      collapseToggle,
      taskMarker,
      priorityBadge,
      dueDateChip,
      scheduledChip,
      repeatIndicator,
    ]) {
      expect(el).toBeInTheDocument()
      expect(el?.className).not.toContain('mt-1')
    }
  })

  it('chevron icon uses size 16 (matching other gutter icons)', () => {
    render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
      />,
    )

    const chevron = screen.getByTestId('chevron-right-icon')
    expect(chevron.classList.contains('h-4')).toBe(true)
    expect(chevron.classList.contains('w-4')).toBe(true)
  })

  it('gutter and inline-controls use same gap value', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        priority="1"
      />,
    )

    const gutter = container.querySelector('.w-\\[68px\\]')
    const inlineControls = container.querySelector('.inline-controls')

    // Both containers use the same gap-1 value
    expect(gutter?.className).toContain('gap-1')
    expect(inlineControls?.className).toContain('gap-1')
  })

  it('renders all indicators simultaneously without layout issues', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="Full indicators"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        todoState="DOING"
        priority="2"
        dueDate="2026-06-15"
        scheduledDate="2026-06-10"
        properties={[
          { key: 'repeat', value: '+1w' },
          { key: 'effort', value: '2h' },
        ]}
      />,
    )

    // All indicators are rendered
    expect(container.querySelector('.collapse-toggle')).toBeInTheDocument()
    expect(container.querySelector('.task-checkbox-doing')).toBeInTheDocument()
    expect(container.querySelector('.priority-badge')).toBeInTheDocument()
    expect(container.querySelector('.due-date-chip')).toBeInTheDocument()
    expect(container.querySelector('.scheduled-chip')).toBeInTheDocument()
    expect(container.querySelector('.repeat-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('property-chip-effort')).toBeInTheDocument()

    // inline-controls has correct structure
    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('flex')
    expect(inlineControls?.className).toContain('items-center')
    expect(inlineControls?.className).toContain('gap-1')
  })

  it('has no a11y violations with all alignment changes', async () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="a11y check"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        hasChildren
        todoState="TODO"
        priority="1"
        dueDate="2026-06-15"
        scheduledDate="2026-06-10"
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// =========================================================================
// Due date chip click-to-edit (#645-6)
// =========================================================================

describe('SortableBlock due date chip click-to-edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('clicking due date chip dispatches open-due-date-picker event', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    document.addEventListener('open-due-date-picker', handler)

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2026-06-15"
      />,
    )

    const chip = container.querySelector('.due-date-chip') as HTMLElement
    expect(chip).toBeInTheDocument()
    await user.click(chip)

    expect(handler).toHaveBeenCalledOnce()
    document.removeEventListener('open-due-date-picker', handler)
  })

  it('clicking scheduled date chip dispatches open-scheduled-date-picker event', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    document.addEventListener('open-scheduled-date-picker', handler)

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate="2026-06-10"
      />,
    )

    const chip = container.querySelector('.scheduled-chip') as HTMLElement
    expect(chip).toBeInTheDocument()
    await user.click(chip)

    expect(handler).toHaveBeenCalledOnce()
    document.removeEventListener('open-scheduled-date-picker', handler)
  })

  it('due date chip has cursor-pointer class', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate="2026-06-15"
      />,
    )

    const chip = container.querySelector('.due-date-chip')
    expect(chip?.className).toContain('cursor-pointer')
  })

  it('scheduled date chip has cursor-pointer class', () => {
    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate="2026-06-10"
      />,
    )

    const chip = container.querySelector('.scheduled-chip')
    expect(chip?.className).toContain('cursor-pointer')
  })
})

// =========================================================================
// Property key rename tests (#645-7c)
// =========================================================================

describe('SortableBlock property key rename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('clicking property key label opens key rename input', async () => {
    const user = userEvent.setup()

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'effort', value: '2h' }]}
      />,
    )

    const keyLabel = screen.getByTestId('property-key-effort')
    await user.click(keyLabel)

    const keyEditor = container.querySelector('.property-key-editor input')
    expect(keyEditor).toBeInTheDocument()
  })

  it('renaming a property key creates new key and deletes old key', async () => {
    const user = userEvent.setup()
    mockSetProperty.mockResolvedValue({})

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'effort', value: '2h' }]}
      />,
    )

    // Click key label to open rename input
    const keyLabel = screen.getByTestId('property-key-effort')
    await user.click(keyLabel)

    const input = container.querySelector('.property-key-editor input') as HTMLInputElement
    expect(input).toBeInTheDocument()

    // Clear and type new key name
    await user.clear(input)
    await user.type(input, 'duration')

    // Blur to trigger save
    await act(async () => {
      fireEvent.blur(input)
    })

    // Should call setProperty twice: once to create new key, once to delete old key
    await waitFor(() => {
      expect(mockSetProperty).toHaveBeenCalledTimes(2)
    })
    expect(mockSetProperty).toHaveBeenCalledWith({
      blockId: 'BLOCK_42',
      key: 'duration',
      valueText: '2h',
    })
    expect(mockSetProperty).toHaveBeenCalledWith({
      blockId: 'BLOCK_42',
      key: 'effort',
      valueText: null,
    })
  })
})

// =========================================================================
// Ref property picker tests (#645-7b)
// =========================================================================

describe('SortableBlock ref property picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
    mockSetProperty.mockResolvedValue({})
  })

  it('ref property shows page picker instead of text input', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'related',
        value_type: 'ref',
        options: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ])
    mockListBlocks.mockResolvedValue({
      items: [
        { id: 'PAGE_1', content: 'Meeting Notes', block_type: 'page' },
        { id: 'PAGE_2', content: 'Project Plan', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'related', value: 'PAGE_1' }]}
      />,
    )

    // No picker initially
    expect(screen.queryByTestId('ref-picker')).not.toBeInTheDocument()

    // Click the property chip
    const chip = screen.getByTestId('property-chip-related')
    await user.click(chip)

    // Wait for the ref picker to appear
    await waitFor(() => {
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
    })

    // Should have search input, not a plain text input
    expect(screen.getByTestId('ref-search-input')).toBeInTheDocument()

    // Should show page list
    expect(screen.getByRole('button', { name: 'Meeting Notes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Project Plan' })).toBeInTheDocument()

    // No select-options-dropdown or plain text input
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()
  })

  it('ref picker search filters pages', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'parent_page',
        value_type: 'ref',
        options: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ])
    mockListBlocks.mockResolvedValue({
      items: [
        { id: 'PAGE_A', content: 'Alpha Document', block_type: 'page' },
        { id: 'PAGE_B', content: 'Beta Report', block_type: 'page' },
        { id: 'PAGE_C', content: 'Gamma Analysis', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'parent_page', value: '' }]}
      />,
    )

    // Click the property chip
    const chip = screen.getByTestId('property-chip-parent_page')
    await user.click(chip)

    await waitFor(() => {
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
    })

    // All three pages visible initially
    expect(screen.getByRole('button', { name: 'Alpha Document' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Beta Report' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gamma Analysis' })).toBeInTheDocument()

    // Type in search
    const searchInput = screen.getByTestId('ref-search-input')
    await user.type(searchInput, 'beta')

    // Only Beta Report should remain
    expect(screen.queryByRole('button', { name: 'Alpha Document' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Beta Report' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gamma Analysis' })).not.toBeInTheDocument()
  })

  it('ref picker selects page and calls setProperty with valueRef', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'linked',
        value_type: 'ref',
        options: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ])
    mockListBlocks.mockResolvedValue({
      items: [
        { id: 'PAGE_X', content: 'Design Doc', block_type: 'page' },
        { id: 'PAGE_Y', content: 'Sprint Retro', block_type: 'page' },
      ],
      next_cursor: null,
      has_more: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_42"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'linked', value: '' }]}
      />,
    )

    // Click the property chip to open picker
    const chip = screen.getByTestId('property-chip-linked')
    await user.click(chip)

    await waitFor(() => {
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
    })

    // Click "Sprint Retro"
    const pageBtn = screen.getByRole('button', { name: 'Sprint Retro' })
    await user.click(pageBtn)

    // setProperty should have been called with valueRef
    expect(mockSetProperty).toHaveBeenCalledWith({
      blockId: 'BLOCK_42',
      key: 'linked',
      valueRef: 'PAGE_Y',
    })

    // Picker should be closed
    expect(screen.queryByTestId('ref-picker')).not.toBeInTheDocument()
  })

  it('ref picker closes on Escape', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'source',
        value_type: 'ref',
        options: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ])
    mockListBlocks.mockResolvedValue({
      items: [{ id: 'PAGE_1', content: 'Some Page', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'source', value: '' }]}
      />,
    )

    // Click the property chip
    const chip = screen.getByTestId('property-chip-source')
    await user.click(chip)

    await waitFor(() => {
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
    })

    // Press Escape in the search input
    const searchInput = screen.getByTestId('ref-search-input')
    await user.type(searchInput, '{Escape}')

    // Picker should be dismissed
    await waitFor(() => {
      expect(screen.queryByTestId('ref-picker')).not.toBeInTheDocument()
    })
  })

  it('ref picker shows "No pages found" when search has no matches', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockResolvedValue([
      {
        key: 'ref_prop',
        value_type: 'ref',
        options: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ])
    mockListBlocks.mockResolvedValue({
      items: [{ id: 'PAGE_1', content: 'Only Page', block_type: 'page' }],
      next_cursor: null,
      has_more: false,
    })

    render(
      <SortableBlock
        blockId="BLOCK_1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'ref_prop', value: '' }]}
      />,
    )

    const chip = screen.getByTestId('property-chip-ref_prop')
    await user.click(chip)

    await waitFor(() => {
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
    })

    // Type something that doesn't match any page
    const searchInput = screen.getByTestId('ref-search-input')
    await user.type(searchInput, 'zzzznonexistent')

    // Should show "No pages found"
    expect(screen.getByTestId('ref-no-results')).toBeInTheDocument()
    expect(screen.getByText('No pages found')).toBeInTheDocument()
  })
})

// =========================================================================
// UX-M20: Heading alignment — gutter/inline padding adjusts for headings
// =========================================================================

describe('SortableBlock heading alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('gutter uses items-center for h1 blocks', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="# Heading"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const gutter = container.querySelector(`.w-\\[68px\\]`)
    expect(gutter?.className).toContain('items-center')

    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('items-center')
  })

  it('gutter uses items-center for h2 blocks', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="## Heading"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const gutter = container.querySelector(`.w-\\[68px\\]`)
    expect(gutter?.className).toContain('items-center')

    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('items-center')
  })

  it('gutter uses items-center for non-heading blocks', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="normal text"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const gutter = container.querySelector(`.w-\\[68px\\]`)
    expect(gutter?.className).toContain('items-center')

    const inlineControls = container.querySelector('.inline-controls')
    expect(inlineControls?.className).toContain('items-center')
  })

  it('gutter uses items-center for h3 blocks', () => {
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="### Heading 3"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )
    const gutter = container.querySelector(`.w-\\[68px\\]`)
    expect(gutter?.className).toContain('items-center')
  })
})

// =========================================================================
// UX-M21: Date pill tooltips — title & aria-label attributes
// =========================================================================

describe('SortableBlock date pill tooltips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('due date chip has title and aria-label', () => {
    const now = new Date()
    const year = now.getFullYear()
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        dueDate={`${year}-07-04`}
      />,
    )
    const chip = container.querySelector('.due-date-chip')
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveAttribute('title', 'Due Jul 4')
    expect(chip).toHaveAttribute('aria-label', 'Due Jul 4')
  })

  it('scheduled date chip has title and aria-label', () => {
    const now = new Date()
    const year = now.getFullYear()
    const { container } = render(
      <SortableBlock
        blockId="B1"
        content="hello"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        scheduledDate={`${year}-08-15`}
      />,
    )
    const chip = container.querySelector('.scheduled-chip')
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveAttribute('title', 'Scheduled Aug 15')
    expect(chip).toHaveAttribute('aria-label', 'Scheduled Aug 15')
  })
})

describe('SortableBlock mobile gutter hidden (UX-21)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('drag handle has no per-button coarse-pointer classes (gutter container handles hiding)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_MOBILE"
        content="mobile test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    expect(dragHandle.className).not.toContain('max-sm:hidden')
    expect(dragHandle.className).not.toContain('max-sm:flex')
    expect(dragHandle.className).not.toContain('max-sm:opacity-100')
    expect(dragHandle.className).not.toContain('max-sm:pointer-events-auto')
  })

  it('history button has no per-button coarse-pointer classes (gutter container handles hiding)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_MOBILE"
        content="mobile test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onShowHistory={vi.fn()}
      />,
    )

    const historyBtn = screen.getByRole('button', { name: /block history/i })
    expect(historyBtn.className).not.toContain('max-sm:hidden')
    expect(historyBtn.className).not.toContain('max-sm:flex')
    expect(historyBtn.className).not.toContain('max-sm:opacity-100')
    expect(historyBtn.className).not.toContain('max-sm:pointer-events-auto')
  })

  it('delete button has no per-button coarse-pointer classes (gutter container handles hiding)', () => {
    render(
      <SortableBlock
        blockId="BLOCK_MOBILE"
        content="mobile test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
      />,
    )

    const deleteBtn = screen.getByRole('button', { name: /delete block/i })
    expect(deleteBtn.className).not.toContain('max-sm:hidden')
    expect(deleteBtn.className).not.toContain('max-sm:flex')
    expect(deleteBtn.className).not.toContain('max-sm:opacity-100')
    expect(deleteBtn.className).not.toContain('max-sm:pointer-events-auto')
  })

  it('gutter container has touch-collapse classes', () => {
    render(
      <SortableBlock
        blockId="BLOCK_MOBILE"
        content="mobile test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        onDelete={vi.fn()}
        onShowHistory={vi.fn()}
      />,
    )

    const dragHandle = screen.getByTestId('drag-handle')
    const gutterDiv = dragHandle.parentElement as HTMLElement
    expect(gutterDiv.className).toContain('max-sm:w-0')
    expect(gutterDiv.className).toContain('max-sm:overflow-hidden')
  })

  it('outer wrapper has max-sm:items-start for vertical alignment', () => {
    render(
      <SortableBlock
        blockId="BLOCK_MOBILE"
        content="mobile test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const wrapper = screen.getByTestId('sortable-block')
    expect(wrapper.className).toContain('max-sm:items-start')
  })

  it('content div retains flex-1 min-w-0', () => {
    render(
      <SortableBlock
        blockId="BLOCK_MOBILE"
        content="mobile test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const editableBlock = screen.getByTestId('editable-block-BLOCK_MOBILE')
    const contentDiv = editableBlock.parentElement as HTMLElement
    expect(contentDiv.className).toContain('flex-1')
    expect(contentDiv.className).toContain('min-w-0')
  })
})

// =========================================================================
// Error path tests — invoke rejections
// =========================================================================

describe('SortableBlock error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('listAttachments rejection keeps attachmentCount at 0 and renders without crashing', async () => {
    mockListAttachments.mockRejectedValueOnce(new Error('disk read failed'))

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_ERR_1"
        content="attachment error"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    // Wait for the rejected promise to settle
    await waitFor(() => {
      expect(mockListAttachments).toHaveBeenCalledWith('BLOCK_ERR_1')
    })

    // Component still renders normally
    expect(screen.getByTestId('editable-block-BLOCK_ERR_1')).toBeInTheDocument()

    // No paperclip icon — attachment count stayed at 0
    expect(screen.queryByTestId('paperclip-icon')).not.toBeInTheDocument()

    // No attachment list rendered
    expect(container.querySelector('[data-testid^="attachment-list-"]')).not.toBeInTheDocument()
  })

  it('listPropertyDefs rejection falls back to text input for property editing', async () => {
    const user = userEvent.setup()

    mockListPropertyDefs.mockRejectedValueOnce(new Error('network timeout'))

    render(
      <SortableBlock
        blockId="BLOCK_ERR_2"
        content="prop defs error"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'status', value: 'open' }]}
      />,
    )

    // Click the property chip to trigger listPropertyDefs
    const chip = screen.getByTestId('property-chip-status')
    await user.click(chip)

    // Wait for the rejection to settle and the fallback to appear
    await waitFor(() => {
      expect(mockListPropertyDefs).toHaveBeenCalled()
    })

    // Should fall back to plain text input (no select dropdown, no ref picker)
    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('open')
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-picker')).not.toBeInTheDocument()
  })

  it('listBlocks rejection for ref property shows empty ref picker with "No pages found"', async () => {
    const user = userEvent.setup()

    // listPropertyDefs succeeds, returning a ref-type definition
    mockListPropertyDefs.mockResolvedValueOnce([
      {
        key: 'related',
        value_type: 'ref',
        options: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ])
    // listBlocks rejects
    mockListBlocks.mockRejectedValueOnce(new Error('backend unavailable'))

    render(
      <SortableBlock
        blockId="BLOCK_ERR_3"
        content="ref error"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[{ key: 'related', value: '' }]}
      />,
    )

    // Click the property chip to trigger the effect chain
    const chip = screen.getByTestId('property-chip-related')
    await user.click(chip)

    // Wait for the ref picker to appear (listPropertyDefs succeeded, isRefProp is set)
    await waitFor(() => {
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
    })

    // listBlocks was called and rejected — refPages falls back to []
    expect(mockListBlocks).toHaveBeenCalledWith({ blockType: 'page' })

    // Ref picker shows "No pages found" because refPages is empty
    expect(screen.getByTestId('ref-no-results')).toBeInTheDocument()
    expect(screen.getByText('No pages found')).toBeInTheDocument()
  })

  it('listAttachments rejection does not affect other component functionality', async () => {
    const user = userEvent.setup()
    mockListAttachments.mockRejectedValueOnce(new Error('ENOENT'))
    const onToggleTodo = vi.fn()

    const { container } = render(
      <SortableBlock
        blockId="BLOCK_ERR_4"
        content="still works"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        todoState="TODO"
        onToggleTodo={onToggleTodo}
        priority="1"
        dueDate="2026-12-25"
      />,
    )

    await waitFor(() => {
      expect(mockListAttachments).toHaveBeenCalled()
    })

    // Task marker still works
    const marker = screen.getByRole('button', { name: /task: todo/i })
    await user.click(marker)
    expect(onToggleTodo).toHaveBeenCalledWith('BLOCK_ERR_4')

    // Priority badge still renders
    expect(screen.getByRole('button', { name: /priority P1/i })).toBeInTheDocument()

    // Due date chip still renders
    expect(container.querySelector('.due-date-chip')).toBeInTheDocument()
  })

  it('listPropertyDefs rejection after selecting a select-type prop resets to text input', async () => {
    const user = userEvent.setup()

    // First click: listPropertyDefs succeeds with select type
    mockListPropertyDefs.mockResolvedValueOnce([
      {
        key: 'severity',
        value_type: 'select',
        options: JSON.stringify(['Low', 'Medium', 'High']),
        created_at: '2025-01-01T00:00:00Z',
      },
    ])

    render(
      <SortableBlock
        blockId="BLOCK_ERR_5"
        content="flip flop"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
        properties={[
          { key: 'severity', value: 'Low' },
          { key: 'effort', value: '3h' },
        ]}
      />,
    )

    // First: click severity chip — should get select dropdown
    const severityChip = screen.getByTestId('property-chip-severity')
    await user.click(severityChip)

    await waitFor(() => {
      expect(screen.getByTestId('select-options-dropdown')).toBeInTheDocument()
    })

    // Select 'High' to close the dropdown
    await user.click(screen.getByRole('button', { name: 'High' }))
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()

    // Second: click effort chip but listPropertyDefs now rejects
    mockListPropertyDefs.mockRejectedValueOnce(new Error('transient failure'))

    const effortChip = screen.getByTestId('property-chip-effort')
    await user.click(effortChip)

    // Should fall back to text input
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })
    expect(screen.getByRole('textbox')).toHaveValue('3h')
    expect(screen.queryByTestId('select-options-dropdown')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ref-picker')).not.toBeInTheDocument()
  })
})

describe('responsive layout (UX-151)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSortable.mockReturnValue(makeSortable())
  })

  it('outer wrapper does not have overflow-hidden', () => {
    render(
      <SortableBlock
        blockId="BLOCK_RESP"
        content="responsive test"
        isFocused={false}
        rovingEditor={makeRovingEditor()}
      />,
    )

    const wrapper = screen.getByTestId('sortable-block')
    expect(wrapper.className).not.toContain('overflow-hidden')
  })
})
