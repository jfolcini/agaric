// @vitest-environment jsdom
// Pinned to jsdom to match the rest of this Radix-Popover + cmdk `<Command>`
// filter-form family (see BacklinkFilterBuilder.test.tsx): happy-dom trips
// axe's `aria-hidden-focus` rule on Radix focus-guard sentinels and can crash
// the runner mid-render for these portal-heavy popovers.

/**
 * Tests for HasTagFilterForm — the searchable `has-tag` filter picker.
 *
 * The component owns a Radix Popover around a cmdk `<Command>` and runs a
 * 150 ms-debounced `listTagsByPrefix` IPC whenever the popover is open (fired
 * on open with the current query, and re-fired on every query change). The
 * IPC routes `listTagsByPrefix` → `commands.listTagsByPrefix` →
 * `invoke('list_tags_by_prefix', …)`, so we drive it through the globally
 * mocked `invoke` from `@tauri-apps/api/core`.
 *
 * Coverage:
 *  - happy path: typed search resolves rows that surface as options (#1270);
 *  - IPC error path (REQUIRED, #1270 / AGENTS.md:198): the debounced search
 *    rejects; the popover must not crash, loading must settle to false, the
 *    result list stays empty (falls back to the empty state), and the `.catch`
 *    logs via `logger.warn`;
 *  - a11y: axe audit on the rendered trigger.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { HasTagFilterForm } from '@/components/backlink-filter/categories/HasTagFilterForm'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'

const mockedInvoke = vi.mocked(invoke)

/** A `TagCacheRow` as the backend returns it (the wrapper maps `tag_id`→`id`). */
function makeTagRow(tag_id: string, name: string) {
  return { tag_id, name, usage_count: 0, updated_at: '2025-01-01T00:00:00Z' }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: any `list_tags_by_prefix` call resolves empty unless overridden.
  mockedInvoke.mockResolvedValue([])
})

describe('HasTagFilterForm — happy path', () => {
  it('surfaces tags resolved by the debounced listTagsByPrefix search', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValue([
      makeTagRow('01TAG_BETA', 'Beta'),
      makeTagRow('01TAG_GAMMA', 'Gamma'),
    ])

    render(<HasTagFilterForm tags={[{ id: '01TAG_ALPHA', name: 'Alpha' }]} />)

    // tagValue defaults to the first tag, so the trigger is labelled "Alpha".
    await user.click(screen.getByRole('button', { name: 'Alpha' }))

    const searchInput = screen.getByLabelText(t('backlink.searchTagPlaceholder'))
    await user.type(searchInput, 'be')

    // The 150 ms-debounced IPC fires with the exact command + arg shape.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_tags_by_prefix', {
        prefix: 'be',
        limit: 50,
      })
    })

    // Resolved rows render as selectable options (mapped tag_id→id, name→name).
    expect(await screen.findByRole('option', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Gamma' })).toBeInTheDocument()
  })
})

describe('HasTagFilterForm — IPC error path (#1270)', () => {
  it('swallows a rejected listTagsByPrefix, settles loading, keeps results empty, and warns', async () => {
    const user = userEvent.setup()
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    // The debounced search (fired on open with the empty prefix) rejects.
    mockedInvoke.mockRejectedValueOnce(new Error('tag backend unavailable'))

    render(<HasTagFilterForm tags={[]} />)

    // tagValue is empty (no tags), so the trigger shows the placeholder label.
    await user.click(screen.getByRole('button', { name: t('backlink.selectTag') }))

    // The `.catch` logged the failure — the rejection was handled, not thrown.
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Tag search failed', expect.any(Error))
    })

    // Loading settled to false via `.finally` (spinner gone) and, with no
    // results and no tags, the empty state renders — the popover did not crash.
    await waitFor(() => {
      expect(screen.getByText(t('backlink.noTagsFound'))).toBeInTheDocument()
    })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()

    warnSpy.mockRestore()
  })
})

describe('HasTagFilterForm — a11y', () => {
  it('has no axe violations', async () => {
    const { container } = render(<HasTagFilterForm tags={[{ id: '01TAG_ALPHA', name: 'Alpha' }]} />)

    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
