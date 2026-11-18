/**
 * #6755 — "Set on tagged blocks" against the mock backend: a write the
 * backend refuses after the preview says so and changes nothing.
 * The happy path runs through `TagPropertiesSection.test.tsx`.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { SetOnTaggedBlocks } from '@/components/pages/SetOnTaggedBlocks'
import type { PropertyDefinition } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const WORK = SEED_IDS.TAG_WORK
const PROJ_1 = SEED_IDS.BLOCK_PROJ_1
const CONTEXT: PropertyDefinition = {
  key: 'context',
  value_type: 'text',
  options: null,
  created_at: '2026-01-01T00:00:00.000Z',
  builtin: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  seedBlocks()
  const spaceId = blocks.get(WORK)?.['space_id'] as string
  useSpaceStore.setState({
    currentSpaceId: spaceId,
    availableSpaces: [{ id: spaceId, name: 'Space', accent_color: null }],
  })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

describe('SetOnTaggedBlocks', () => {
  it('says when the write is refused, and writes nothing', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property_on_tagged_blocks') {
        return Promise.reject(Object.assign(new Error('disk full'), { kind: 'database' }))
      }
      return dispatch(cmd, args)
    })
    const { container } = render(
      <SetOnTaggedBlocks tagId={WORK} keys={['context']} definitions={[CONTEXT]} />,
    )
    expect(await axe(container)).toHaveNoViolations()

    const value = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'context' }))
    await user.type(value, '@home')
    await user.tab()
    await user.click(screen.getByRole('button', { name: t('tagProperties.setButton') }))
    const dialog = await screen.findByRole('alertdialog')
    const buttons = within(dialog).getAllByRole('button')
    await user.click(buttons.at(-1) as HTMLElement)

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('tagProperties.setFailed')),
    )
    expect(properties.get(PROJ_1)?.get('context')).toBeUndefined()
  })
})
