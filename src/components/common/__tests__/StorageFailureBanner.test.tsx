/**
 * Tests for StorageFailureBanner: a command the backend refuses because the
 * disk or the database failed names the cause once, however many commands
 * fail after it (#6554).
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { StorageFailureBanner } from '@/components/common/StorageFailureBanner'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'

const mockedInvoke = vi.mocked(invoke)

const FULL = { kind: 'storage_full', message: 'The disk is full' }
const READ_ONLY = { kind: 'storage_read_only', message: 'The vault is read-only' }
const CORRUPT = { kind: 'storage_corrupt', message: 'The vault database is damaged' }

/** Run one command the backend answers with `error`, and return what its caller catches. */
async function failCommand(error: unknown): Promise<unknown> {
  stubInvoke(mockedInvoke, { list_spaces: () => Promise.reject(error) })
  let caught: unknown
  await act(async () => {
    try {
      unwrap(await commands.listSpaces())
    } catch (err) {
      caught = err
    }
  })
  return caught
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StorageFailureBanner', () => {
  it('shows nothing until a command fails on storage', async () => {
    render(<StorageFailureBanner />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await failCommand({ kind: 'internal', message: 'an internal error occurred (err: 0A1B2)' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    [FULL, /The disk is full/],
    [READ_ONLY, /cannot write to its data folder/],
    [CORRUPT, /database is damaged/],
  ])('names the cause of a $kind failure', async (error, text) => {
    render(<StorageFailureBanner />)
    await failCommand(error)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('still rejects the failed command with the backend error', async () => {
    render(<StorageFailureBanner />)
    expect(await failCommand(FULL)).toEqual(FULL)
  })

  it('shows one row however many commands fail the same way', async () => {
    render(<StorageFailureBanner />)
    await failCommand(FULL)
    await failCommand(FULL)
    await failCommand(FULL)
    expect(screen.getAllByText(/The disk is full/)).toHaveLength(1)
  })

  it('shows a row per cause', async () => {
    render(<StorageFailureBanner />)
    await failCommand(FULL)
    await failCommand(CORRUPT)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/The disk is full/)
    expect(alert).toHaveTextContent(/database is damaged/)
  })

  it('stays dismissed until a command fails again', async () => {
    const user = userEvent.setup()
    render(<StorageFailureBanner />)
    await failCommand(FULL)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await failCommand(FULL)
    expect(screen.getByRole('alert')).toHaveTextContent(/The disk is full/)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<StorageFailureBanner />)
    await failCommand(FULL)
    await failCommand(READ_ONLY)
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2)
    expect(await axe(container)).toHaveNoViolations()
  })
})
