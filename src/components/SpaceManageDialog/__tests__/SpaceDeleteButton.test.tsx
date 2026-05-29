/**
 * Tests for SpaceDeleteButton + SpaceDeleteBlockedHint (PEND-30 D-2).
 *
 * Coverage:
 *  - When emptiness=true and isLastSpace=false: button is enabled, click
 *    opens confirmation, confirm calls deleteBlock, cancel closes dialog.
 *  - When isLastSpace=true: button is disabled (last-space tooltip wins).
 *  - When emptiness=false: button disabled with non-empty tooltip.
 *  - When emptiness=null (probe in flight): button disabled.
 *  - On IPC failure: toast.error fires and dialog stays open.
 *  - SpaceDeleteBlockedHint renders only when emptiness=false &&
 *    !isLastSpace; otherwise returns null.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { t } from '@/lib/i18n'

import { SpaceDeleteBlockedHint, SpaceDeleteButton } from '../SpaceDeleteButton'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

function renderWithProvider(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'delete_block') return { affected_count: 1 }
    return null
  })
})

describe('SpaceDeleteButton', () => {
  it('button is enabled when emptiness=true and not last space', () => {
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={false}
        emptiness={true}
        onRefresh={() => {}}
      />,
    )
    const btn = screen.getByRole('button', { name: t('space.deleteSpaceLabel') })
    expect(btn).not.toBeDisabled()
  })

  it('button is disabled when emptiness=false (non-empty space)', () => {
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={false}
        emptiness={false}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: t('space.deleteSpaceLabel') })).toBeDisabled()
  })

  it('button is disabled when isLastSpace=true (regardless of emptiness)', () => {
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={true}
        emptiness={true}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: t('space.deleteSpaceLabel') })).toBeDisabled()
  })

  it('button is disabled when emptiness=null (probe in flight or failed)', () => {
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={false}
        emptiness={null}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: t('space.deleteSpaceLabel') })).toBeDisabled()
  })

  it('click opens confirmation; confirm calls deleteBlock and refreshes', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={false}
        emptiness={true}
        onRefresh={onRefresh}
      />,
    )

    await user.click(screen.getByRole('button', { name: t('space.deleteSpaceLabel') }))
    expect(
      await screen.findByText(t('space.deleteConfirmTitle', { name: 'Personal' })),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('action.delete') }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'delete_block',
        expect.objectContaining({ blockId: 'SPACE_1' }),
      )
    })
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1)
    })
  })

  it('cancel closes the confirmation without calling deleteBlock', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={false}
        emptiness={true}
        onRefresh={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: t('space.deleteSpaceLabel') }))
    await screen.findByText(t('space.deleteConfirmTitle', { name: 'Personal' }))

    await user.click(screen.getByRole('button', { name: t('space.cancelLabel') }))

    await waitFor(() => {
      expect(
        screen.queryByText(t('space.deleteConfirmTitle', { name: 'Personal' })),
      ).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
  })

  it('surfaces toast.error on deleteBlock IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'delete_block') throw new Error('IPC offline')
      return null
    })
    const user = userEvent.setup()
    renderWithProvider(
      <SpaceDeleteButton
        spaceId="SPACE_1"
        spaceName="Personal"
        isLastSpace={false}
        emptiness={true}
        onRefresh={() => {}}
      />,
    )

    await user.click(screen.getByRole('button', { name: t('space.deleteSpaceLabel') }))
    await screen.findByText(t('space.deleteConfirmTitle', { name: 'Personal' }))
    await user.click(screen.getByRole('button', { name: t('action.delete') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.deleteFailed'))
    })
  })
})

describe('SpaceDeleteBlockedHint', () => {
  it('renders the inline hint when emptiness=false and not last space', () => {
    render(<SpaceDeleteBlockedHint emptiness={false} isLastSpace={false} />)
    expect(screen.getByTestId('space-delete-blocked-hint')).toHaveTextContent(
      t('space.deleteSpaceInlineHint'),
    )
  })

  it('returns null when emptiness=true (delete enabled)', () => {
    const { container } = render(<SpaceDeleteBlockedHint emptiness={true} isLastSpace={false} />)
    expect(container.querySelector('[data-testid="space-delete-blocked-hint"]')).toBeNull()
  })

  it('returns null when isLastSpace=true (already covered by tooltip)', () => {
    const { container } = render(<SpaceDeleteBlockedHint emptiness={false} isLastSpace={true} />)
    expect(container.querySelector('[data-testid="space-delete-blocked-hint"]')).toBeNull()
  })

  it('returns null while emptiness probe is still loading (null)', () => {
    const { container } = render(<SpaceDeleteBlockedHint emptiness={null} isLastSpace={false} />)
    expect(container.querySelector('[data-testid="space-delete-blocked-hint"]')).toBeNull()
  })
})
