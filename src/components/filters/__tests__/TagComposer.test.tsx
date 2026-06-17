/**
 * Tests for TagComposer (#1426) — focuses on the IPC error path of its
 * `listTagsByPrefix` typeahead (required by the ipc-error-path-coverage
 * guard, #1270), plus the happy path and a11y.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { TagComposer } from '@/components/filters/TagComposer'
import { t } from '@/lib/i18n'
import { emptyTagBuilder } from '@/lib/tagExpr'

const mockedInvoke = vi.mocked(invoke)

function renderComposer() {
  const onAddTag = vi.fn()
  const props = {
    builder: emptyTagBuilder(),
    onAddTag,
    onAddPrefix: vi.fn(),
    onRemoveLeaf: vi.fn(),
    onSetMode: vi.fn(),
  }
  const utils = render(<TagComposer {...props} />)
  return { ...utils, onAddTag }
}

async function openAndType(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole('button', { name: t('tagFilter.composer.addTag') }))
  const input = await screen.findByLabelText(t('tagFilter.composer.searchLabel'))
  await user.type(input, text)
  return input
}

describe('TagComposer — tag typeahead IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('swallows a list_tags_by_prefix rejection without crashing and shows no matches (#1426 error path)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockRejectedValue(new Error('IPC failed'))

    const { onAddTag } = renderComposer()
    await openAndType(user, 'wo')

    // The rejection is caught (matches reset to []), so no tag option renders
    // and the error never escapes to crash the component.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled()
    })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(onAddTag).not.toHaveBeenCalled()
    // The composer is still interactive (search input remains mounted).
    expect(screen.getByLabelText(t('tagFilter.composer.searchLabel'))).toBeInTheDocument()
  })

  it('renders matches when list_tags_by_prefix resolves (happy path)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue([{ tag_id: 'TAG001', name: 'work', usage_count: 5 }])

    renderComposer()
    await openAndType(user, 'wo')

    await waitFor(() => {
      expect(screen.getByText('work')).toBeInTheDocument()
    })
  })

  it('has no a11y violations with the composer open', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue([])

    const { container } = renderComposer()
    await user.click(screen.getByRole('button', { name: t('tagFilter.composer.addTag') }))
    await screen.findByLabelText(t('tagFilter.composer.searchLabel'))

    expect(await axe(container)).toHaveNoViolations()
  })
})
