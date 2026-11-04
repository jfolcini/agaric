// ---------------------------------------------------------------------------
// Real-backend: files an MCP agent attaches with `attach_file` play in the app
// (#5410).
//
// `attach_file` reads a file on this device and stores it through the app's
// own attachment write, so this spec checks the whole path the mock cannot
// model: the agent attaches one-second Ogg Opus, MP3 and M4A tones
// (`fixtures/`, made with ffmpeg) to a block over the socket, the user leaves
// the page and opens it again, and each `<audio>` loads its stored bytes in
// WebKitGTK. Whether MP3 and M4A play depends on the runner's GStreamer
// plugins (#5730), so each format is its own `it`.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { statSync } from 'node:fs'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  McpClient,
  NAV_TIMEOUT,
  blockStaticByMarker,
  defaultSpaceId,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  startReadWriteAgent,
  waitForAppReady,
} from './helpers'

const AGENT = runScopedMarker('wdio-attach-agent')
const PAGE = runScopedMarker('wdio-attach-page')
const BLOCK = runScopedMarker('wdio-attach-block')

const FIXTURES = [
  { file: 'tone-opus.ogg', mime: 'audio/ogg' },
  { file: 'tone.mp3', mime: 'audio/mpeg' },
  { file: 'tone.m4a', mime: 'audio/mp4' },
] as const

interface AttachedRow {
  block_id: string
  filename: string
  mime_type: string
  size_bytes: number
}

describe('Agaric real-backend MCP attach_file plays in the app (#5410) @attachments @mcp', () => {
  before(async () => {
    await waitForAppReady()
    const { socketPath, token } = await startReadWriteAgent(AGENT)
    const agent = await McpClient.connect(socketPath, token)
    try {
      const spaceId = await defaultSpaceId(agent)
      const page = (await agent.call('create_page', { title: PAGE, space_id: spaceId })) as {
        id: string
      }
      const block = (await agent.call('append_block', {
        parent_id: page.id,
        content: BLOCK,
        space_id: spaceId,
      })) as { id: string }
      for (const { file, mime } of FIXTURES) {
        const source = path.resolve(import.meta.dirname, 'fixtures', file)
        const row = (await agent.call('attach_file', {
          space_id: spaceId,
          block_id: block.id,
          path: source,
        })) as AttachedRow
        expect(row.block_id).toBe(block.id)
        expect(row.filename).toBe(file)
        expect(row.mime_type).toBe(mime)
        expect(row.size_bytes).toBe(statSync(source).size)
      }
    } finally {
      agent.close()
    }

    // Leave and come back: the players render from the stored rows and bytes.
    await navigateTo('Journal')
    await reopenPageByTitle(PAGE)
    await blockStaticByMarker(BLOCK).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })

  for (const { file } of FIXTURES) {
    it(`loads the attached ${file} with its duration`, async () => {
      const player = `audio[aria-label="Audio ${file}"]`
      await $(player).waitForExist({ timeout: NAV_TIMEOUT })
      let state = { readyState: 0, duration: Number.NaN, error: 0 }
      await browser
        .waitUntil(
          async () => {
            state = await browser.execute((selector: string) => {
              const audio = document.querySelector<HTMLAudioElement>(selector)
              return {
                readyState: audio?.readyState ?? 0,
                duration: audio?.duration ?? Number.NaN,
                error: audio?.error?.code ?? 0,
              }
            }, player)
            return state.readyState >= 1 && Number.isFinite(state.duration) && state.duration > 0
          },
          { timeout: ACTION_TIMEOUT },
        )
        .catch(() => {
          throw new Error(`${file} never loaded: ${JSON.stringify(state)}`)
        })
      expect(state.duration).toBeLessThan(2)
    })
  }
})
