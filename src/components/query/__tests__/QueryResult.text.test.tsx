/**
 * QueryResult for a query block in the search syntax (#6628), against the mock
 * backend's seed: the tag `work` is attached to "Ship v2.0 release" (TODO),
 * "Fix login bug" (DOING) and "Weekly standup notes".
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { answerInvokeFromMock, stubInvoke } from '@/__tests__/helpers/invoke'
import { QueryResult } from '@/components/query/QueryResult'
import { t } from '@/lib/i18n'
import { SEED_IDS } from '@/lib/tauri-mock/seed'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

beforeEach(async () => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  await answerInvokeFromMock(mockedInvoke)
})

function header(): HTMLElement {
  return within(screen.getByTestId('query-result')).getAllByRole('button')[0] as HTMLElement
}

describe('QueryResult in the search syntax', () => {
  it('runs the text and shows its tokens as the search box chips them', async () => {
    const { container } = render(<QueryResult expression="tag:#work state:TODO" />)

    expect(await screen.findByRole('option', { name: /Ship v2\.0 release/ })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(within(header()).getByText('tag:#work')).toBeInTheDocument()
    expect(within(header()).getByText('state:TODO')).toBeInTheDocument()
    expect(header()).toHaveTextContent(t('query.resultCount', { count: 1 }))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('shows a tag chip as its tag name', async () => {
    useResolveStore.getState().batchSet([{ id: SEED_IDS.TAG_WORK, title: 'work', deleted: false }])
    render(<QueryResult expression={`#[${SEED_IDS.TAG_WORK}]`} />)

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
    expect(within(header()).getByText('tag:#work')).toBeInTheDocument()
  })

  it('names each token it cannot run in the error state, and runs nothing', async () => {
    const { container } = render(<QueryResult expression="state:todo under:#work" />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      [
        t('query.text.problem', {
          token: 'state:todo',
          column: 1,
          message: t('searchQuery.unknownValue', { noun: 'state', value: 'todo' }),
        }),
        t('query.text.problem', {
          token: 'under:#work',
          column: 12,
          message: t('query.text.cannotRun'),
        }),
      ].join('; '),
    )
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain('run_advanced_query')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('shows a failed query as its error', async () => {
    stubInvoke(mockedInvoke, {
      run_advanced_query: () => Promise.reject(new Error('engine down')),
    })
    render(<QueryResult expression="state:TODO" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('engine down')
  })
})
