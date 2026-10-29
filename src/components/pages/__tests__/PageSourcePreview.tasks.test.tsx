/**
 * The Preview of Edit as Markdown draws a task as page mode and block mode do
 * (#5691 D3): its checkbox and no bullet or number, whatever list style it
 * holds, and a numbered run it sits in starts again after it.
 */

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PageSourcePreview } from '@/components/pages/PageSourcePreview'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

beforeEach(() => {
  useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
})

describe('PageSourcePreview with a numbered task', () => {
  it('draws the task’s checkbox and no number; the run after it starts at 1.', async () => {
    const { container } = render(
      <PageSourcePreview
        lines={{ text: '1. one\n1. [ ] two\n1. three', lineIds: [null, null, null] }}
      />,
    )

    const blocks = screen.getAllByTestId('page-source-preview-block')
    expect(
      blocks.map((block) => within(block).queryByTestId('list-marker')?.textContent ?? ''),
    ).toEqual(['1.', '', '1.'])
    expect(within(blocks[1] as HTMLElement).getByTestId('task-checkbox-todo')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })
})
