// ---------------------------------------------------------------------------
// Real-backend editor durability (#5733): an audio attachment plays from its
// stored bytes, typing commits on an idle pause without a blur, and a draft
// brings back what a killed app never committed.
//
// - A pasted `.wav` is a block attachment (`add_attachment_with_bytes`), not
//   an inline ref; StaticBlock's attachment section renders it as an
//   `<audio controls>` whose `src` is a `blob:` URL of `read_attachment`'s
//   bytes. A player that decodes the WAV's length proves the bytes on disk,
//   which the mock never holds.
// - `useDebouncedContentCommit` sends `edit_block` 700 ms after the last
//   keystroke while the editor keeps focus (#2600). The op is read through
//   `get_block_history`, because opening History would blur the editor.
// - `useDraftAutosave` writes `block_drafts` 2 s after the last keystroke, and
//   boot (`recover_at_boot`, then the frontend's `flush_all_drafts`) turns a
//   leftover row into an `edit_block`. The idle commit already saves plain
//   text, so the draft is the sole copy only of an edit that commit leaves to
//   blur, such as a `#name` typed as text (`classifyUnmountFlush`). The spec
//   checks that precondition, then SIGKILLs the app (`restartApp('kill')`), so
//   no blur, unload or window close can save the text another way.
//
// Each case opens its own page, so the cases do not depend on each other's
// data or order.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  invoke,
  navigateTo,
  openNewPage,
  pasteFileIntoFocusedBlock,
  reopenPageByTitle,
  restartApp,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

const AUDIO_PAGE = runScopedMarker('wdio-audio-page')
const AUDIO_BLOCK = runScopedMarker('wdio-audio-holder')
const AUDIO_FILE = 'wdio-voice.wav'

const COMMIT_PAGE = runScopedMarker('wdio-idle-commit-page')
const COMMIT_TEXT = runScopedMarker('wdio-idle-commit')

const DRAFT_PAGE = runScopedMarker('wdio-draft-page')
const DRAFT_TAG = runScopedMarker('wdio-draft-tag')
const DRAFT_TEXT = `${runScopedMarker('wdio-draft-text')} #${DRAFT_TAG}`

const SAMPLE_RATE = 8000
const WAV_SECONDS = 0.1

/** A mono 8-bit PCM WAV of `WAV_SECONDS`: the 44-byte header and a tone. */
function tinyWav(): Buffer {
  const samples = Buffer.from(
    Array.from(
      { length: SAMPLE_RATE * WAV_SECONDS },
      (_, i) => 128 + Math.round(64 * Math.sin(i / 4)),
    ),
  )
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

/** The `to_text` of every `edit_block` op the backend holds for `blockId`. */
async function editedTexts(blockId: string): Promise<string[]> {
  const page = await invoke<{ items: Array<{ payload: string }> }>('get_block_history', {
    blockId,
    opTypeFilter: 'edit_block',
    cursor: null,
    limit: 50,
  })
  return page.items.map((op) => (JSON.parse(op.payload) as { to_text: string }).to_text)
}

/** The id of the block the roving editor is in, and whether the editor has focus. */
async function editorState(): Promise<{ id: string | null; focused: boolean }> {
  return await browser.execute((sel: string) => {
    const editor = document.querySelector(sel)
    return {
      id: editor?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
      focused: editor !== null && document.activeElement === editor,
    }
  }, EDITOR)
}

async function editorBlockId(): Promise<string> {
  const { id } = await editorState()
  if (id === null) throw new Error('no block editor is open')
  return id
}

/** What the one `<audio>` of block `id` holds: its source and the media it decoded. */
interface Player {
  players: number
  label?: string | null
  src?: string
  duration?: number
  mediaError?: number | null
}

/**
 * Wait until block `id` renders one audio player whose `blob:` source decoded
 * to `seconds` of audio. The CSP's `connect-src` keeps the blob from being
 * fetched back, so the decoded length stands in for the bytes: only the stored
 * WAV decodes to it.
 */
async function expectAudioPlays(id: string, seconds: number): Promise<void> {
  await $(`[data-block-id="${id}"]`).scrollIntoView()
  let seen: Player = { players: 0 }
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute((blockId: string) => {
          const players = [...document.querySelectorAll('audio')].filter(
            (audio) => audio.closest('[data-block-id]')?.getAttribute('data-block-id') === blockId,
          )
          const [only] = players
          if (players.length !== 1 || only === undefined) return { players: players.length }
          return {
            players: 1,
            label: only.getAttribute('aria-label'),
            src: only.getAttribute('src') ?? '',
            // NaN until decoded, and WebDriver cannot return a NaN.
            duration: Number.isFinite(only.duration) ? only.duration : -1,
            // Not `error`: wdio reads a returned `error` key as a WebDriver error.
            mediaError: only.error?.code ?? null,
          }
        }, id)
        return (
          seen.players === 1 &&
          seen.label === `Audio ${AUDIO_FILE}` &&
          seen.src?.startsWith('blob:') === true &&
          Math.abs((seen.duration ?? 0) - seconds) < 0.005
        )
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`block ${id} plays no ${seconds} s of audio: ${JSON.stringify(seen)}`)
    })
}

describe('Agaric real-backend editor durability (#5733) @editor', () => {
  before(async () => {
    await waitForAppReady()
  })

  it('plays a pasted WAV inline from its stored bytes after leaving the page', async () => {
    const wav = tinyWav().toString('base64')
    await openNewPage(AUDIO_PAGE)
    await typeMarkerVerified(AUDIO_BLOCK)
    await pasteFileIntoFocusedBlock(wav, AUDIO_FILE, 'audio/wav')
    await waitForToast(`Attached "${AUDIO_FILE}"`)

    await navigateTo('Journal')
    await reopenPageByTitle(AUDIO_PAGE)
    const block = blockStaticByMarker(AUDIO_BLOCK)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await block.getAttribute('data-block-id')
    if (id === null) throw new Error('the audio block has no data-block-id')

    await expectAudioPlays(id, WAV_SECONDS)
  })

  it('commits typed text as an edit_block on an idle pause, with the editor still focused', async () => {
    await openNewPage(COMMIT_PAGE)
    const id = await editorBlockId()
    await typeMarkerVerified(COMMIT_TEXT)

    let texts: string[] = []
    await browser
      .waitUntil(
        async () => {
          texts = await editedTexts(id)
          return texts.includes(COMMIT_TEXT)
        },
        { timeout: ACTION_TIMEOUT, interval: 500 },
      )
      .catch(() => {
        throw new Error(
          `no edit_block of ${COMMIT_TEXT} while the editor kept focus; ops: ${JSON.stringify(texts)}`,
        )
      })
    expect(await editorState()).toEqual({ id, focused: true })
  })

  it('restores text typed into a block from its draft after the app is killed mid-edit', async () => {
    await openNewPage(DRAFT_PAGE)
    const id = await editorBlockId()
    await typeMarkerVerified(DRAFT_TEXT)

    let drafts: Array<{ block_id: string; content: string }> = []
    await browser
      .waitUntil(
        async () => {
          drafts = await invoke('list_drafts')
          return drafts.some((draft) => draft.block_id === id && draft.content === DRAFT_TEXT)
        },
        { timeout: ACTION_TIMEOUT, interval: 500 },
      )
      .catch(() => {
        throw new Error(`no draft of ${DRAFT_TEXT} was saved; drafts: ${JSON.stringify(drafts)}`)
      })
    // The draft is the only copy, or the restart below would prove nothing.
    expect((await editedTexts(id)).filter((text) => text.includes(DRAFT_TAG))).toEqual([])

    await restartApp('kill')
    await reopenPageByTitle(DRAFT_PAGE)
    let shown: string[] = []
    await browser
      .waitUntil(
        async () => {
          shown = await browser.execute(() =>
            [...document.querySelectorAll('[data-testid="block-static"]')].map(
              (row) => row.textContent ?? '',
            ),
          )
          return shown.some((text) => text.includes(DRAFT_TAG))
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(
          `the drafted text never came back after the restart; the page shows ${JSON.stringify(shown)}`,
        )
      })
  })
})
