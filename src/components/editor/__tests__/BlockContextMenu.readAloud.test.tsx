/**
 * The block menu's *Read aloud* row (#5745): offered where the backend speaks through the
 * webview, reading the block with its descendants (or a block selection) from the page store.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { type FakeSpeech, installFakeSpeech } from '@/__tests__/helpers/fake-speech'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { BLOCK_MENU_ACTION_IDS } from '@/components/editor/block-context-menu/types'
import { BlockContextMenu } from '@/components/editor/BlockContextMenu'
import { setActiveEditor } from '@/editor/active-editor'
import type { SpeechStatus } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { __resetReadAloudForTests, getReadAloudSnapshot } from '@/lib/speech/read-aloud'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'

const LINKED = '01HX4ZQ8AAAAAAAAAAAAAAAAAA'

// ROOT ─ PARENT ("parent", links to LINKED) ─ CHILD ("child") ─ GRANDCHILD ("grandchild")
//      ─ SIBLING ("sibling")
const BLOCKS = [
  makeBlock({ id: 'PARENT', content: `parent of [[${LINKED}]]`, depth: 0 }),
  makeBlock({ id: 'CHILD', content: 'child', parent_id: 'PARENT', depth: 1 }),
  makeBlock({ id: 'GRANDCHILD', content: 'grandchild', parent_id: 'CHILD', depth: 2 }),
  makeBlock({ id: 'SIBLING', content: 'sibling', depth: 0 }),
]

let speech: FakeSpeech

function stubStatus(status: () => SpeechStatus | Promise<SpeechStatus>) {
  vi.mocked(invoke).mockImplementation(mockInvokeCommands({ get_speech_status: status }))
}

function renderMenu(props: Partial<React.ComponentProps<typeof BlockContextMenu>> = {}): {
  onClose: ReturnType<typeof vi.fn>
} {
  const store = createPageBlockStore('PAGE_1')
  store.setState({ blocks: BLOCKS })
  const onClose = vi.fn()
  render(
    <PageBlockContext.Provider value={store}>
      <BlockContextMenu
        blockId="PARENT"
        position={{ x: 0, y: 0 }}
        onClose={onClose}
        actions={{ onDelete: vi.fn() }}
        {...props}
      />
    </PageBlockContext.Provider>,
  )
  return { onClose }
}

/** Speaks the reading to its end, returning every utterance's text. */
function drain(): string[] {
  while (getReadAloudSnapshot().reading) speech.endCurrent()
  return speech.spoken.map((u) => u.text)
}

const readRow = () => screen.queryByRole('menuitem', { name: t('readAloud.read') })

beforeEach(() => {
  vi.clearAllMocks()
  __resetReadAloudForTests()
  useBlockStore.getState().clearSelected()
  useBlockStore.setState({ focusedBlockId: null })
  setActiveEditor(null)
  useResolveStore.getState().batchSet([{ id: LINKED, title: 'Garden', deleted: false }])
  speech = installFakeSpeech()
})

afterEach(() => {
  // Before the fake goes: a test that failed mid-reading must not end it on a later unmount.
  __resetReadAloudForTests()
  vi.unstubAllGlobals()
})

describe('BlockContextMenu — Read aloud', () => {
  it('is offered where the backend speaks through the webview', async () => {
    stubStatus(() => 'Webview')
    renderMenu()
    expect(await screen.findByRole('menuitem', { name: t('readAloud.read') })).toBeInTheDocument()
  })

  it('is hidden where the backend has no engine', async () => {
    const status = vi.fn((): SpeechStatus => 'Unsupported')
    stubStatus(status)
    renderMenu()
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(readRow()).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: new RegExp(t('contextMenu.delete')) }),
    ).toBeInTheDocument()
  })

  it('is hidden, and the failure logged, when get_speech_status rejects', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    stubStatus(() => Promise.reject(new Error('ipc down')))
    renderMenu()
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'read-aloud',
        'get_speech_status failed; Read aloud stays hidden',
        undefined,
        expect.anything(),
      ),
    )
    expect(readRow()).not.toBeInTheDocument()
  })

  it('reads the block with its descendants, in tree order, and closes the menu', async () => {
    stubStatus(() => 'Webview')
    const user = userEvent.setup()
    const { onClose } = renderMenu()
    await user.click(await screen.findByRole('menuitem', { name: t('readAloud.read') }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(getReadAloudSnapshot().currentBlockId).toBe('PARENT')
    expect(drain()).toEqual(['parent of Garden', 'child', 'grandchild'])
  })

  it('on a block selection reads the selected blocks with theirs', async () => {
    stubStatus(() => 'Webview')
    const user = userEvent.setup()
    renderMenu({ blockId: 'CHILD', selectedBlockIds: ['CHILD', 'SIBLING'] })
    await user.click(await screen.findByRole('menuitem', { name: t('readAloud.readSelected') }))
    expect(drain()).toEqual(['child', 'grandchild', 'sibling'])
  })

  describe('on the block being edited, with text selected', () => {
    /** An active editor whose selection, from `from` to `to`, holds a link to LINKED. */
    function selectInEditor(from: number, to: number) {
      const cut = vi.fn(() => ({
        toJSON: () => ({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'parent of ' },
                { type: 'block_link', attrs: { id: LINKED } },
              ],
            },
          ],
        }),
      }))
      setActiveEditor({
        isDestroyed: false,
        state: { selection: { from, to, empty: from === to }, doc: { cut } },
      } as never)
      return cut
    }

    it('reads the selected text, its chips by title, marking the block', async () => {
      stubStatus(() => 'Webview')
      useBlockStore.setState({ focusedBlockId: 'PARENT' })
      const cut = selectInEditor(1, 12)
      const user = userEvent.setup()
      renderMenu()
      await user.click(await screen.findByRole('menuitem', { name: t('readAloud.readSelection') }))
      expect(cut).toHaveBeenCalledWith(1, 12)
      expect(getReadAloudSnapshot().currentBlockId).toBe('PARENT')
      expect(drain()).toEqual(['parent of Garden'])
    })

    it('reads the block with its descendants when the selection is empty', async () => {
      stubStatus(() => 'Webview')
      useBlockStore.setState({ focusedBlockId: 'PARENT' })
      selectInEditor(5, 5)
      renderMenu()
      expect(await screen.findByRole('menuitem', { name: t('readAloud.read') })).toBeInTheDocument()
    })

    it('reads the block when the selection is in another block', async () => {
      stubStatus(() => 'Webview')
      useBlockStore.setState({ focusedBlockId: 'SIBLING' })
      selectInEditor(1, 12)
      renderMenu()
      expect(await screen.findByRole('menuitem', { name: t('readAloud.read') })).toBeInTheDocument()
    })
  })

  it('is left out of a menu that names its rows (page mode, the Markdown buffer)', async () => {
    const status = vi.fn((): SpeechStatus => 'Webview')
    stubStatus(status)
    renderMenu({ actionIds: new Set(BLOCK_MENU_ACTION_IDS) })
    await waitFor(() => expect(getReadAloudSnapshot().supported).toBe(true))
    expect(readRow()).not.toBeInTheDocument()
  })

  it('has no a11y violations with the row offered', async () => {
    stubStatus(() => 'Webview')
    renderMenu()
    await screen.findByRole('menuitem', { name: t('readAloud.read') })
    await waitFor(async () => {
      expect(await axe(screen.getByRole('menu'))).toHaveNoViolations()
    })
  })
})
