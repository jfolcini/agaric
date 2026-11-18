/**
 * #6755 — "Properties for tagged blocks" on a tag's page, against the mock
 * backend: the tag's keys as chips, added from the space's definitions and
 * removed, each a write of the list; "Set on tagged blocks" previews the
 * counts, writes on confirm, and its refusal shows the backend's reason.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { TagPropertiesSection } from '@/components/pages/TagPropertiesSection'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const WORK = SEED_IDS.TAG_WORK
const PROJ_1 = SEED_IDS.BLOCK_PROJ_1

function removeLabel(key: string): string {
  return t('tagProperties.removeKey', { key })
}

function tagKeys(): unknown {
  return properties.get(WORK)?.get('tag_properties')?.['value_list'] ?? null
}

beforeEach(async () => {
  vi.clearAllMocks()
  queryClient.clear()
  seedBlocks()
  const spaceId = blocks.get(WORK)?.['space_id'] as string
  useSpaceStore.setState({
    currentSpaceId: spaceId,
    availableSpaces: [{ id: spaceId, name: 'Space', accent_color: null }],
  })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  await dispatch('set_property', {
    blockId: WORK,
    key: 'tag_properties',
    value: { value_list: ['context'] },
  })
})

describe('TagPropertiesSection', () => {
  it('adds a key from the definitions and removes one, writing the list', async () => {
    const user = userEvent.setup()
    render(<TagPropertiesSection tagId={WORK} />)
    expect(await screen.findByRole('button', { name: removeLabel('context') })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: t('property.addProperty') }))
    await user.click(await screen.findByText('Project'))
    await waitFor(() => expect(tagKeys()).toEqual(['context', 'project']))

    await user.click(await screen.findByRole('button', { name: removeLabel('context') }))
    await waitFor(() => expect(tagKeys()).toEqual(['project']))
  })

  it('sets a value on the tagged blocks after confirming the counts', async () => {
    const user = userEvent.setup()
    render(<TagPropertiesSection tagId={WORK} />)
    const value = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'context' }))
    await user.type(value, '@home')
    await user.tab()
    await user.click(screen.getByRole('button', { name: t('tagProperties.setButton') }))

    // PROJ_1, PROJ_2 and an inline `#work` lack `context`; the meeting block holds one.
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(t('tagProperties.confirmDescription', { added: 3 })),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: t('tagProperties.confirmButton') }))
    await waitFor(() =>
      expect(properties.get(PROJ_1)?.get('context')?.['value_text']).toBe('@home'),
    )
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      t('tagProperties.setDone', { n: 3, key: 'context' }),
      expect.objectContaining({ action: expect.anything() }),
    )
  })

  it("shows the backend's reason when the preview is refused", async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'preview_set_property_on_tagged_blocks') {
        return Promise.reject(Object.assign(new Error('not this one'), { kind: 'validation' }))
      }
      return dispatch(cmd, args)
    })
    render(<TagPropertiesSection tagId={WORK} />)
    const value = await screen.findByLabelText(t('pageProperty.valueLabel', { key: 'context' }))
    await user.type(value, '@home')
    await user.tab()
    await user.click(screen.getByRole('button', { name: t('tagProperties.setButton') }))
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('not this one')),
    )
    expect(properties.get(PROJ_1)?.get('context')).toBeUndefined()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TagPropertiesSection tagId={WORK} />)
    await screen.findByRole('button', { name: removeLabel('context') })
    expect(await axe(container)).toHaveNoViolations()
  })
})
