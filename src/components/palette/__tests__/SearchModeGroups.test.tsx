/**
 * Tests for SearchModeGroups — the palette's search results.
 *
 * A block hit with no snippet (a short query, a filter-only search) shows the
 * block's text, not its Markdown.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { SearchModeGroups } from '@/components/palette/SearchModeGroups'
import type { PaletteGroup } from '@/components/palette/types'
import { Command, CommandList } from '@/components/ui/command'
import type { SearchBlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'

function blockRow(content: string): SearchBlockRow {
  return {
    id: 'BLOCK_1',
    block_type: 'content',
    content,
    parent_id: 'PAGE_1',
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: 'PAGE_1',
    snippet: null,
    match_offsets: [],
  }
}

function renderGroups(content: string) {
  const group: PaletteGroup = {
    pageId: 'PAGE_1',
    pageTitle: 'Roadmap',
    hasPageNameMatch: false,
    matches: [blockRow(content)],
    surplus: 0,
    score: 1,
  }
  return render(
    <Command label="Palette">
      <CommandList>
        <SearchModeGroups
          groups={[group]}
          linkMode={false}
          onNavigatePage={vi.fn()}
          onNavigateBlock={vi.fn()}
          onEscalateToMore={vi.fn()}
          t={t}
        />
      </CommandList>
    </Command>,
  )
}

describe('SearchModeGroups', () => {
  it.each([
    ['**Audit** every *screen*', 'Audit every screen'],
    [
      '| Screen | Status |\n| --- | --- |\n| Journal | Reviewed |',
      'Screen Status Journal Reviewed',
    ],
  ])('shows a hit without a snippet as its text, not its Markdown: %j', (content, shown) => {
    renderGroups(content)
    expect(screen.getByTestId('palette-block-BLOCK_1')).toHaveTextContent(new RegExp(`^${shown}$`))
  })

  it('has no a11y violations', async () => {
    const { container } = renderGroups('**Audit** every *screen*')
    expect(await axe(container)).toHaveNoViolations()
  })
})
