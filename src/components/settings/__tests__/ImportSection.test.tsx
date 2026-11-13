/**
 * Tests for restoring a whole-vault export (#6554): a folder pick of an
 * unzipped *Export all spaces* ZIP lists its spaces in one dialog, and on a
 * confirm imports each space folder into the live space of its name, created
 * when there is none. The backend is a small in-test fake, so each test
 * re-reads the spaces, pages and definitions the run left behind.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { withOps } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { ImportSection } from '@/components/settings/ImportSection'
import type { PropertyDefinition, SpaceRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { useSpaceStore } from '@/stores/space'

const mockImportMarkdown = vi.fn()
vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return { ...actual, importMarkdown: (...args: unknown[]) => mockImportMarkdown(...args) }
})

vi.mock('@/stores/tabs', () => ({
  useTabsStore: (selector: (s: { navigateToPage: () => void }) => unknown) =>
    selector({ navigateToPage: vi.fn() }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** What the fake backend holds: spaces, each space's page titles and definition keys. */
let spaces: SpaceRow[]
let pages: Map<string, string[]>
let definitions: Map<string, string[]>
const listImportMerges = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockImportMarkdown.mockReset()
  listImportMerges.mockReset()
  listImportMerges.mockReturnValue([])
  spaces = [
    { id: 'SPACE', name: 'Personal', accent_color: null },
    { id: 'WORK', name: 'Work', accent_color: null },
  ]
  pages = new Map()
  definitions = new Map()
  useSpaceStore.setState({ currentSpaceId: 'SPACE', availableSpaces: [...spaces], isReady: true })
  stubInvoke(vi.mocked(invoke), {
    list_spaces: () => [...spaces],
    create_space: (args) => {
      const name = args['name'] as string
      if (name === 'Broken') return Promise.reject({ kind: 'validation', message: 'boom' })
      const id = `NEW_${name.toUpperCase()}`
      spaces.push({ id, name, accent_color: null })
      return id
    },
    list_property_defs: (args) => ({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: definitions.get(args['spaceId'] as string)?.length ?? 0,
    }),
    create_property_def: (args) => {
      const spaceId = args['spaceId'] as string
      const def: PropertyDefinition = {
        key: args['key'] as string,
        value_type: args['valueType'] as string,
        options: null,
        created_at: '2026-01-01T00:00:00Z',
        builtin: false,
      }
      definitions.set(spaceId, [...(definitions.get(spaceId) ?? []), def.key])
      return withOps(def)
    },
    list_import_merges: (args) => listImportMerges(args),
    list_all_tags_in_space: () => [],
    batch_resolve: () => [],
  })
  mockImportMarkdown.mockImplementation((_content: string, path: string, spaceId: string) => {
    const title = path.slice(0, -'.md'.length)
    pages.set(spaceId, [...(pages.get(spaceId) ?? []), title])
    return Promise.resolve({
      page_title: title,
      page_id: `${spaceId}:${title}`,
      blocks_created: 1,
      properties_set: 0,
      collapsed: [],
      warnings: [],
      anchors: [],
      deferred: [],
      merged: null,
    })
  })
})

function file(text: string, path: string): File {
  const f = new File([text], path.slice(path.lastIndexOf('/') + 1))
  Object.defineProperty(f, 'webkitRelativePath', { value: `Vault/${path}` })
  return f
}

const spaceFile = (folder: string, name: string, keys: string[] = []) =>
  file(
    JSON.stringify({
      name,
      propertyDefinitions: keys.map((key) => ({ key, value_type: 'number', options: null })),
      titles: {},
    }),
    `${folder}/.agaric/space.json`,
  )

/** An unzipped all-spaces export: `Travel` (no such space yet), then `Work`. */
const VAULT = (): File[] => [
  spaceFile('Travel', 'Travel', ['effort']),
  file('- go', 'Travel/Trip.md'),
  spaceFile('Work', 'Work'),
  file('- plan', 'Work/Roadmap.md'),
]

async function pick(files: File[]): Promise<void> {
  const input = screen.getByTestId('import-folder-input') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ImportSection vault restore', () => {
  it('lists each space as existing or new, then imports each into its own space', async () => {
    const user = userEvent.setup()
    const { baseElement } = render(<ImportSection />)

    await pick(VAULT())

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      t('data.importVaultNew', { name: 'Travel' }),
      t('data.importVaultExisting', { name: 'Work' }),
    ])
    expect(mockImportMarkdown).not.toHaveBeenCalled()
    expect(await axe(baseElement)).toHaveNoViolations()

    await user.click(within(dialog).getByRole('button', { name: t('data.importVaultConfirm') }))

    const result = await screen.findByTestId('import-result')
    expect(result).toHaveTextContent(t('data.importResultFilesTitle', { count: 2 }))
    expect(spaces.map(({ id, name }) => [id, name])).toEqual([
      ['SPACE', 'Personal'],
      ['WORK', 'Work'],
      ['NEW_TRAVEL', 'Travel'],
    ])
    expect(Object.fromEntries(pages)).toEqual({ NEW_TRAVEL: ['Trip'], WORK: ['Roadmap'] })
    expect(Object.fromEntries(definitions)).toEqual({ NEW_TRAVEL: ['effort'] })
    expect(useSpaceStore.getState().availableSpaces.map(({ name }) => name)).toContain('Travel')
    expect(useSpaceStore.getState().currentSpaceId).toBe('SPACE')
    // The run spans spaces, so it offers no one page to view.
    expect(screen.queryByTestId('import-view-button')).not.toBeInTheDocument()
  })

  it('restores two spaces of one name into two spaces, not one', async () => {
    const user = userEvent.setup()
    spaces.push({ id: 'TEAM', name: 'Team', accent_color: null })
    useSpaceStore.setState({ availableSpaces: [...spaces] })
    render(<ImportSection />)

    await pick([
      spaceFile('Team', 'Team'),
      file('- a', 'Team/Alpha.md'),
      spaceFile('Team_01ABCDEF', 'Team'),
      file('- b', 'Team_01ABCDEF/Beta.md'),
    ])
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      t('data.importVaultExisting', { name: 'Team' }),
      t('data.importVaultNew', { name: 'Team' }),
    ])
    await user.click(within(dialog).getByRole('button', { name: t('data.importVaultConfirm') }))

    await screen.findByTestId('import-result')
    expect(Object.fromEntries(pages)).toEqual({ TEAM: ['Alpha'], NEW_TEAM: ['Beta'] })
  })

  it('writes nothing when the user declines', async () => {
    const user = userEvent.setup()
    render(<ImportSection />)

    await pick(VAULT())
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    await waitFor(() => expect(screen.getByTestId('import-folder-button')).toBeEnabled())
    expect(spaces.map(({ name }) => name)).toEqual(['Personal', 'Work'])
    expect(pages.size).toBe(0)
    expect(definitions.size).toBe(0)
    expect(screen.queryByTestId('import-result')).not.toBeInTheDocument()
  })

  it('reports a space it could not create and still imports the others', async () => {
    const user = userEvent.setup()
    render(<ImportSection />)

    await pick([spaceFile('Broken', 'Broken'), file('- x', 'Broken/Lost.md'), ...VAULT().slice(2)])
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('data.importVaultConfirm') }))

    await screen.findByTestId('import-result')
    expect(Object.fromEntries(pages)).toEqual({ WORK: ['Roadmap'] })
    expect(screen.getByTestId('import-failure-item')).toHaveTextContent(
      t('data.importFailedFileDetail', {
        name: 'Broken',
        reason: t('data.importSpaceCreateFailed', { reason: 'boom' }),
      }),
    )
  })

  it("asks before updating an existing space's pages, after the list of spaces", async () => {
    const user = userEvent.setup()
    listImportMerges.mockImplementation((args: { spaceId: string }) =>
      args.spaceId === 'WORK' ? [{ page_id: 'ROADMAP', title: 'Roadmap' }] : [],
    )
    render(<ImportSection />)

    await pick(VAULT())
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('data.importVaultConfirm'),
      }),
    )

    const merge = await screen.findByTestId('import-merge-dialog')
    expect(within(merge).getByRole('listitem')).toHaveTextContent('Roadmap')
    expect(merge).toHaveTextContent(t('data.importMergeSpace', { name: 'Work' }))
    expect(pages.size).toBe(0)
    await user.click(within(merge).getByRole('button', { name: t('dialog.cancel') }))

    expect(await screen.findByTestId('import-result-cancelled')).toBeInTheDocument()
    expect(pages.size).toBe(0)
  })
})
