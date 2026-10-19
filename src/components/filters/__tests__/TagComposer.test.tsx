/**
 * Tests for TagComposer (#1426) — focuses on the IPC error path of its
 * `listTagsByPrefix` typeahead (required by the ipc-error-path-coverage
 * guard, #1270), plus the happy path, a11y and the All / Any keyboard.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { stubInvoke } from '@/__tests__/helpers/invoke'
import {
  TagComposer,
  type TagComposerCallbacks,
  useTagComposerState,
} from '@/components/filters/TagComposer'
import type { TagCacheRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { emptyTagBuilder } from '@/lib/tagExpr'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

/** The only command the composer fires; anything else fails by name. */
function stubTagSearch(rows: () => TagCacheRow[] | Promise<TagCacheRow[]>): void {
  stubInvoke(mockedInvoke, { list_tags_by_prefix: rows })
}

function renderComposer() {
  const onAddTag = vi.fn()
  const callbacks: TagComposerCallbacks = {
    onAddTag,
    onAddPrefix: vi.fn(),
    onAddGroup: vi.fn(),
    onRemoveNode: vi.fn(),
    onSetOp: vi.fn(),
    onToggleNegated: vi.fn(),
  }
  const utils = render(<TagComposer root={emptyTagBuilder()} callbacks={callbacks} />)
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
    useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('swallows a list_tags_by_prefix rejection without crashing and shows no matches (#1426 error path)', async () => {
    const user = userEvent.setup()
    stubTagSearch(() => Promise.reject(new Error('IPC failed')))

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
    stubTagSearch(() => [
      { tag_id: 'TAG001', name: 'work', usage_count: 5, updated_at: '2025-01-01T00:00:00Z' },
    ])

    renderComposer()
    await openAndType(user, 'wo')

    await waitFor(() => {
      expect(screen.getByText('work')).toBeInTheDocument()
    })
  })

  it('has no a11y violations with the composer open', async () => {
    const user = userEvent.setup()
    stubTagSearch(() => [])

    const { container } = renderComposer()
    await user.click(screen.getByRole('button', { name: t('tagFilter.composer.addTag') }))
    await screen.findByLabelText(t('tagFilter.composer.searchLabel'))

    expect(await axe(container)).toHaveNoViolations()
  })
})

/** The composer over its real state hook, so a combinator change re-renders. */
function StatefulComposer(): React.ReactElement {
  const { root, callbacks, toggle } = useTagComposerState()
  return (
    <>
      <button type="button" onClick={toggle}>
        open
      </button>
      {root && <TagComposer root={root} callbacks={callbacks} />}
    </>
  )
}

describe('TagComposer — All / Any combinator', () => {
  it('an arrow key moves the combinator, and only the checked one is a tab stop', async () => {
    const user = userEvent.setup()
    render(<StatefulComposer />)
    await user.click(screen.getByRole('button', { name: 'open' }))

    const group = screen.getByRole('radiogroup', { name: t('tagFilter.composer.opLabel') })
    const all = within(group).getByRole('radio', { name: t('tagFilter.composer.opAnd') })
    const any = within(group).getByRole('radio', { name: t('tagFilter.composer.opOr') })
    expect(all).toHaveAttribute('aria-checked', 'true')

    // The group's NOT toggle sits just before the combinator.
    screen.getByRole('button', { name: t('tagFilter.composer.negateGroup') }).focus()
    await user.tab()
    expect(all).toHaveFocus()
    await user.keyboard('{ArrowRight}')

    expect(any).toHaveFocus()
    expect(any).toHaveAttribute('aria-checked', 'true')
    expect(all).toHaveAttribute('aria-checked', 'false')
    expect(within(group).getAllByRole('radio').filter((r) => r.tabIndex === 0)).toEqual([any])
  })
})
