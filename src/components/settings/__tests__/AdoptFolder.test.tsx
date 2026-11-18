/**
 * Tests for *Open a folder of notes* in the mirror's card (#6540): one folder
 * picked, its notes imported into a new space through the folder import, the
 * preview, and the adoption. The commands are stubbed over one in-memory
 * folder and vault, so the assertions read what the stubs then hold.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { MirrorSection } from '@/components/settings/MirrorSection'
import { diskEntry, folderName } from '@/components/settings/useAdoptFolder'
import type { AdoptionPreview, MirrorStatus } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { useSpaceStore } from '@/stores/space'

const notified = vi.hoisted(() =>
  Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
)
vi.mock('@/lib/notify', () => ({ notify: notified }))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const FOLDER = '/home/me/Vault'

/** The folder on disk, by path. */
let disk: Record<string, string>
/** The spaces the vault holds, by id. */
let spaces: { id: string; name: string }[]
/** The notes imported, by the path each was imported as, with its page. */
let imported: { filename: string; content: string; pageId: string }[]
let adopted: { folder: string; spaceId: string; files: unknown } | null
let adoptRefused: boolean
let preview: AdoptionPreview

const toBase64 = (text: string) => btoa(String.fromCodePoint(...new TextEncoder().encode(text)))

function status(): MirrorStatus {
  return {
    supported: true,
    folder: adopted?.folder ?? null,
    paused: null,
    diverged: [],
    failed: [],
    last_pass_ms: null,
    read_back: true,
    pending: [],
    copy_files: false,
    ask_mass_change: true,
    held: [],
    unmirrored_spaces: [],
    adopted_space: adopted?.spaceId ?? null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  disk = { 'Inbox.md': 'A loose thought\n', 'Projects/Plan.md': '* First\n', 'pic.png': 'png' }
  spaces = []
  imported = []
  adopted = null
  adoptRefused = false
  preview = { changes: [], left_alone: ['pic.png'] }
  useSpaceStore.setState({ availableSpaces: [] })
  ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  stubInvoke(vi.mocked(invoke), {
    get_mirror_status: () => status(),
    pick_mirror_folder: () => FOLDER,
    list_adoption_folder: () =>
      Object.entries(disk).map(([path, text]) => ({ path, size_bytes: text.length })),
    read_adoption_file: (args) => toBase64(disk[args['path'] as string] ?? ''),
    create_space: (args) => {
      const id = `SPACE_${spaces.length + 1}`
      spaces.push({ id, name: args['name'] as string })
      return id
    },
    list_spaces: () =>
      spaces.map((space) => ({ id: space.id, name: space.name, accent_color: null })),
    list_import_merges: () => [],
    // The folder import names the pages a note links to among the space's.
    list_all_pages_in_space: () => [],
    list_all_tags_in_space: () => [],
    batch_resolve: () => [],
    import_markdown: (args) => {
      const pageId = `PAGE_${imported.length + 1}`
      imported.push({
        filename: args['filename'] as string,
        content: args['content'] as string,
        pageId,
      })
      return {
        page_title: args['filename'] as string,
        page_id: pageId,
        blocks_created: 1,
        properties_set: 0,
        collapsed: [],
        anchors: [],
        deferred: [],
        warnings: [],
        merged: null,
      }
    },
    preview_mirror_adoption: () => preview,
    adopt_mirror_folder: (args) => {
      if (adoptRefused) return Promise.reject({ kind: 'Validation', message: 'refused' })
      adopted = {
        folder: args['folder'] as string,
        spaceId: args['spaceId'] as string,
        files: args['files'],
      }
      return status()
    },
  })
})

async function openFolder(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(<MirrorSection />)
  await user.click(await screen.findByRole('button', { name: t('data.mirrorAdoptButton') }))
  return screen.findByTestId('mirror-adopt-dialog')
}

describe('Open a folder of notes', () => {
  it('imports the folder into a new space, shows the preview, and adopts it on the word', async () => {
    const user = userEvent.setup()
    preview = {
      changes: [
        { path: 'Projects/Plan.md', page_id: 'PAGE_2', before: '* First\n', after: '- First\n' },
      ],
      left_alone: ['pic.png'],
    }
    const dialog = await openFolder(user)

    // The notes were read from disk and imported into a space named after the folder.
    expect(spaces).toEqual([{ id: 'SPACE_1', name: 'Vault' }])
    expect(imported.map((note) => [note.filename, note.content])).toEqual([
      ['Inbox.md', 'A loose thought\n'],
      ['Projects/Plan.md', '* First\n'],
    ])
    expect(within(dialog).getByText('Projects/Plan.md')).toBeInTheDocument()
    expect(within(dialog).getByTestId('mirror-adopt-left-alone')).toHaveTextContent('pic.png')
    expect(await axe(dialog)).toHaveNoViolations()

    await user.click(within(dialog).getByTestId('mirror-adopt-confirm'))
    await waitFor(() => expect(adopted).not.toBeNull())
    expect(adopted).toEqual({
      folder: FOLDER,
      spaceId: 'SPACE_1',
      files: [
        { path: 'Inbox.md', page_id: 'PAGE_1' },
        { path: 'Projects/Plan.md', page_id: 'PAGE_2' },
      ],
    })
    expect(await screen.findByTestId('mirror-folder')).toHaveTextContent(FOLDER)
    // Adopted, never also told the folder was left unmirrored.
    expect(notified.success).toHaveBeenCalledWith(t('data.mirrorAdopted', { name: 'Vault' }))
    expect(notified).not.toHaveBeenCalledWith(t('data.mirrorAdoptDeclined', { name: 'Vault' }))
  })

  it('refuses a Logseq graph before anything is written', async () => {
    const user = userEvent.setup()
    disk = { 'logseq/config.edn': '{}', 'pages/A.md': '- a\n' }
    const errorSpy = notified.error
    render(<MirrorSection />)
    await user.click(await screen.findByRole('button', { name: t('data.mirrorAdoptButton') }))

    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith(t('data.mirrorAdoptLogseq')))
    expect(spaces).toEqual([])
    expect(imported).toEqual([])
    expect(adopted).toBeNull()
  })

  it('leaves the folder unmirrored when the user declines', async () => {
    const user = userEvent.setup()
    const dialog = await openFolder(user)
    await user.click(within(dialog).getByTestId('mirror-adopt-decline'))

    await waitFor(() => expect(screen.queryByTestId('mirror-adopt-dialog')).toBeNull())
    expect(adopted).toBeNull()
    expect(notified).toHaveBeenCalledWith(t('data.mirrorAdoptDeclined', { name: 'Vault' }))
    // The imported notes stay in their space.
    expect(spaces).toEqual([{ id: 'SPACE_1', name: 'Vault' }])
  })

  it('says why when the adoption is refused, and the mirror stays off', async () => {
    const user = userEvent.setup()
    adoptRefused = true
    const errorSpy = notified.error
    const dialog = await openFolder(user)
    await user.click(within(dialog).getByTestId('mirror-adopt-confirm'))

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(t('data.mirrorAdoptFailed', { reason: 'refused' })),
    )
    expect(adopted).toBeNull()
    expect(screen.queryByTestId('mirror-folder')).toBeNull()
  })
})

describe('diskEntry', () => {
  it('reads a file of the folder as the folder import reads a picked file', async () => {
    const entry = diskEntry(FOLDER, folderName(FOLDER), {
      path: 'Projects/Plan.md',
      size_bytes: 8,
    })
    expect(entry.name).toBe('Plan.md')
    expect(entry.webkitRelativePath).toBe('Vault/Projects/Plan.md')
    expect(await entry.text()).toBe('* First\n')
    expect(await entry.base64?.()).toBe(toBase64('* First\n'))
  })

  it('names a folder by its last segment, with either separator', () => {
    expect(folderName('/home/me/Vault/')).toBe('Vault')
    expect(folderName('C:\\Users\\me\\Notes')).toBe('Notes')
  })
})
