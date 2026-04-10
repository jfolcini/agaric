/**
 * Tests for RescheduleDropZone component (F-32).
 *
 * Validates:
 *  1. Renders children content
 *  2. Shows visual feedback (ring) on drag over with correct MIME type
 *  3. Calls setDueDate on drop with correct blockId and dateStr
 *  4. Shows success toast on successful drop
 *  5. Shows error toast when setDueDate fails
 *  6. Ignores drag events without the reschedule MIME type
 *  7. Has no a11y violations
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock sonner ────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: mockToast }))

// ── Mock tauri setDueDate ──────────────────────────────────────────────
const mockSetDueDate = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/tauri', () => ({
  setDueDate: (...args: unknown[]) => mockSetDueDate(...args),
}))

import { RESCHEDULE_DRAG_TYPE, RescheduleDropZone } from '../RescheduleDropZone'

beforeEach(() => {
  vi.clearAllMocks()
  mockSetDueDate.mockResolvedValue({})
})

/** Helper to create a mock DataTransfer with the reschedule MIME type. */
function makeDataTransfer(blockId: string) {
  const data: Record<string, string> = {
    [RESCHEDULE_DRAG_TYPE]: blockId,
  }
  return {
    types: [RESCHEDULE_DRAG_TYPE],
    getData: (type: string) => data[type] ?? '',
    setData: vi.fn(),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
  }
}

/** Helper to create a DataTransfer without the reschedule MIME type. */
function makeIrrelevantDataTransfer() {
  return {
    types: ['text/plain'],
    getData: () => '',
    setData: vi.fn(),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
  }
}

describe('RescheduleDropZone', () => {
  // 1. Renders children content
  it('renders children', () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <div data-testid="child-content">Day content here</div>
      </RescheduleDropZone>,
    )

    expect(screen.getByTestId('child-content')).toBeInTheDocument()
    expect(screen.getByText('Day content here')).toBeInTheDocument()
  })

  it('renders with the correct data-testid', () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    expect(screen.getByTestId('reschedule-drop-zone-2025-01-15')).toBeInTheDocument()
  })

  // 2. Shows visual feedback on drag over
  it('shows visual feedback (ring) on dragOver with correct MIME type', () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')

    fireEvent.dragOver(zone, { dataTransfer: makeDataTransfer('block-1') })

    expect(zone.className).toContain('ring-2')
    expect(zone.className).toContain('ring-primary')
  })

  it('clears visual feedback on dragLeave', () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')

    // Drag over to show the highlight
    fireEvent.dragOver(zone, { dataTransfer: makeDataTransfer('block-1') })
    expect(zone.className).toContain('ring-2')

    // Drag leave to clear (relatedTarget outside the container)
    fireEvent.dragLeave(zone, {
      dataTransfer: makeDataTransfer('block-1'),
      relatedTarget: document.body,
    })
    expect(zone.className).not.toContain('ring-2')
  })

  // 3. Calls setDueDate on drop with correct blockId and dateStr
  it('calls setDueDate on drop with correct blockId and dateStr', async () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')

    fireEvent.drop(zone, { dataTransfer: makeDataTransfer('block-abc') })

    await waitFor(() => {
      expect(mockSetDueDate).toHaveBeenCalledWith('block-abc', '2025-01-15')
    })
  })

  // 4. Shows success toast on successful drop
  it('shows success toast after successful reschedule', async () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')
    fireEvent.drop(zone, { dataTransfer: makeDataTransfer('block-1') })

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('2025-01-15'))
    })
  })

  // 5. Shows error toast when setDueDate fails
  it('shows error toast when setDueDate rejects', async () => {
    mockSetDueDate.mockRejectedValueOnce(new Error('Network error'))

    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')
    fireEvent.drop(zone, { dataTransfer: makeDataTransfer('block-fail') })

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled()
    })
  })

  // 6. Ignores drag events without the reschedule MIME type
  it('does not show highlight for unrelated drag types', () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')
    fireEvent.dragOver(zone, { dataTransfer: makeIrrelevantDataTransfer() })

    expect(zone.className).not.toContain('ring-2')
  })

  it('does not call setDueDate when drop has no blockId data', async () => {
    render(
      <RescheduleDropZone dateStr="2025-01-15">
        <span>Content</span>
      </RescheduleDropZone>,
    )

    const zone = screen.getByTestId('reschedule-drop-zone-2025-01-15')

    // Drop with the right MIME type but empty blockId
    const emptyDataTransfer = {
      types: [RESCHEDULE_DRAG_TYPE],
      getData: () => '',
      setData: vi.fn(),
      dropEffect: 'none',
      effectAllowed: 'uninitialized',
    }
    fireEvent.drop(zone, { dataTransfer: emptyDataTransfer })

    // Give async a tick to settle
    await new Promise((r) => setTimeout(r, 50))
    expect(mockSetDueDate).not.toHaveBeenCalled()
  })

  // 7. Has no a11y violations
  it('a11y: no violations', async () => {
    const { container } = render(
      <RescheduleDropZone dateStr="2025-01-15">
        <div>Accessible content</div>
      </RescheduleDropZone>,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
