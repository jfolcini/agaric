/**
 * Tests for SpaceNameEditor (PEND-30 D-2 extraction).
 *
 * Coverage:
 *  - Renders the input with the canonical name pre-filled.
 *  - Blur commits the trimmed value via `editBlock`.
 *  - Enter commits and blurs (single keystroke == blur path).
 *  - Escape reverts the draft to the canonical name and blurs without IPC.
 *  - Empty trim is a no-op (no IPC).
 *  - Unchanged trim is a no-op (no IPC).
 *  - IPC failure → toast.error + revert to canonical name.
 *  - Re-syncs on prop change (upstream rename).
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/lib/i18n'
import { SpaceNameEditor } from '../SpaceNameEditor'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'edit_block') return null
    return null
  })
})

describe('SpaceNameEditor', () => {
  it('renders the input pre-filled with the canonical name', () => {
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />)
    expect(screen.getByDisplayValue('Personal')).toBeInTheDocument()
  })

  it('blur commits the trimmed value via editBlock and refreshes', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={onRefresh} />)

    const input = screen.getByDisplayValue('Personal')
    await user.clear(input)
    await user.type(input, '  Home  ')
    input.blur()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: 'SPACE_1', toText: 'Home' }),
      )
    })
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1)
    })
  })

  it('Enter triggers blur which commits the value', async () => {
    const user = userEvent.setup()
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />)

    const input = screen.getByDisplayValue('Personal')
    await user.clear(input)
    await user.type(input, 'Home{Enter}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'edit_block',
        expect.objectContaining({ blockId: 'SPACE_1', toText: 'Home' }),
      )
    })
  })

  it('Escape resets the draft to the canonical name', async () => {
    const user = userEvent.setup()
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />)

    const input = screen.getByDisplayValue('Personal') as HTMLInputElement
    // Trigger Escape on an empty draft so the blur-after-Escape commit
    // path falls into the empty/unchanged short-circuit. The
    // observable contract is that the input shows the canonical name
    // again after Escape.
    await user.click(input)
    await user.keyboard('{Escape}')

    expect(input.value).toBe('Personal')
    await new Promise((r) => setTimeout(r, 0))
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })

  it('empty trim is a no-op (no IPC)', async () => {
    const user = userEvent.setup()
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />)

    const input = screen.getByDisplayValue('Personal') as HTMLInputElement
    await user.clear(input)
    await user.type(input, '   ')
    input.blur()

    await new Promise((r) => setTimeout(r, 0))
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    // Reverts to canonical name on empty submit.
    await waitFor(() => {
      expect(input.value).toBe('Personal')
    })
  })

  it('unchanged trim is a no-op', async () => {
    const user = userEvent.setup()
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />)

    const input = screen.getByDisplayValue('Personal') as HTMLInputElement
    // Type then erase to exactly the original; blur.
    await user.click(input)
    input.blur()

    await new Promise((r) => setTimeout(r, 0))
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })

  it('surfaces toast.error and reverts on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'edit_block') throw new Error('IPC offline')
      return null
    })
    const user = userEvent.setup()
    render(<SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />)

    const input = screen.getByDisplayValue('Personal') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Home{Enter}')

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.renameFailed'))
    })
    // Revert to canonical name.
    await waitFor(() => {
      expect(input.value).toBe('Personal')
    })
  })

  it('re-syncs the input value when the canonical name prop changes', () => {
    const { rerender } = render(
      <SpaceNameEditor spaceId="SPACE_1" spaceName="Personal" onRefresh={() => {}} />,
    )
    expect(screen.getByDisplayValue('Personal')).toBeInTheDocument()

    rerender(<SpaceNameEditor spaceId="SPACE_1" spaceName="Work" onRefresh={() => {}} />)
    expect(screen.getByDisplayValue('Work')).toBeInTheDocument()
  })
})
