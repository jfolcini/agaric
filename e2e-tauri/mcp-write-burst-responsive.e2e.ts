// ---------------------------------------------------------------------------
// A burst of MCP writes must not freeze the app.
//
// Each MCP write emits from a tokio worker while the open page answers over
// IPC. With Tauri's `tracing` feature an off-main-thread emit waits on the main
// thread while holding Tauri's webview lock, which the main thread's IPC
// handler needs; `main_thread.rs` runs every emit on the main thread instead.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs'
import { type Socket, createConnection } from 'node:net'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticsByMarker,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const TITLE = runScopedMarker('wdio-mcp-burst-page')
const MARKER = runScopedMarker('wdio-mcp-burst-block')
// Each MCP connection rewrites its own block; every write emits twice.
const CONNECTIONS = 4
const WRITES_PER_CONNECTION = 50
const IPC_LOOPS = 8
const IPC_ROUNDS = 100

interface Internals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  return browser.execute(
    (c: string, a: unknown) =>
      (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>
}

/** Newline-delimited JSON-RPC over the MCP RW socket, requests pipelined. */
class McpClient {
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>()
  private readonly socket: Socket

  private constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        const message = JSON.parse(this.buffer.slice(0, newline)) as Record<string, unknown>
        this.buffer = this.buffer.slice(newline + 1)
        this.pending.get(message['id'] as number)?.(message)
        newline = this.buffer.indexOf('\n')
      }
    })
  }

  static async connect(socketPath: string): Promise<McpClient> {
    const socket = createConnection(socketPath)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const client = new McpClient(socket)
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'wdio', version: '1' },
    })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return client
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const reply = new Promise<Record<string, unknown>>((resolve) => this.pending.set(id, resolve))
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return reply
  }

  /** `tools/call` that rejects on a protocol or tool error, resolving the JSON result. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request('tools/call', { name, arguments: args })
    const result = reply['result'] as { isError?: boolean; structuredContent?: unknown } | undefined
    if (result === undefined || result.isError === true) {
      throw new Error(`${name} failed: ${JSON.stringify(reply)}`)
    }
    return result.structuredContent
  }

  close(): void {
    this.socket.destroy()
  }
}

function withinTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not finish: the app is frozen`)),
        ACTION_TIMEOUT,
      ),
    ),
  ])
}

describe('Agaric real-backend MCP write burst', () => {
  it('stays responsive while a burst of MCP writes reloads the open page', async () => {
    await waitForAppReady()

    await invoke('mcp_rw_set_enabled', { enabled: true })
    const { socket_path: socketPath } = await invoke<{ socket_path: string }>('get_mcp_rw_status')
    await browser.waitUntil(() => existsSync(socketPath), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `MCP RW socket never appeared at ${socketPath}`,
    })
    const clients = await Promise.all(
      Array.from({ length: CONNECTIONS }, () => McpClient.connect(socketPath)),
    )
    const [first] = clients
    if (first === undefined) throw new Error('no MCP connection')

    try {
      const spaces = (await first.call('list_spaces', {})) as { id: string; is_default: boolean }[]
      const spaceId = spaces.find((space) => space.is_default)?.id
      if (spaceId === undefined) throw new Error('no default space')
      const page = (await first.call('create_page', { title: TITLE, space_id: spaceId })) as {
        id: string
      }
      const blockIds: string[] = []
      for (let c = 0; c < CONNECTIONS; c++) {
        const block = (await first.call('append_block', {
          parent_id: page.id,
          content: `${MARKER} c${c} v-`,
          space_id: spaceId,
        })) as { id: string }
        blockIds.push(block.id)
      }

      // The open page answers every `blocks:changed` with IPC on the main thread.
      await reopenPageByTitle(TITLE)

      // Keep IPC requests queued at the main thread for the whole burst, so the
      // window in which a worker emit holds Tauri's lock is reliably hit.
      const ipcLoops = browser.execute(
        async (loops: number, rounds: number) => {
          const internals = (window as unknown as { __TAURI_INTERNALS__: Internals })
            .__TAURI_INTERNALS__
          const loop = async () => {
            for (let i = 0; i < rounds; i++) await internals.invoke('get_mcp_rw_status')
          }
          await Promise.all(Array.from({ length: loops }, loop))
        },
        IPC_LOOPS,
        IPC_ROUNDS,
      )
      const writes = clients.flatMap((client, c) =>
        Array.from({ length: WRITES_PER_CONNECTION }, (_, v) =>
          client.call('update_block_content', {
            block_id: blockIds[c],
            content: `${MARKER} c${c} v${v}`,
            space_id: spaceId,
          }),
        ),
      )
      await withinTimeout(
        Promise.all([...writes, ipcLoops]),
        `${CONNECTIONS * WRITES_PER_CONNECTION} MCP writes under IPC load`,
      )
      // Pipelined writes to one block may land in any order; settle each on a
      // known final text.
      for (let c = 0; c < CONNECTIONS; c++) {
        await first.call('update_block_content', {
          block_id: blockIds[c],
          content: `${MARKER} c${c} final`,
          space_id: spaceId,
        })
      }
    } finally {
      for (const client of clients) client.close()
    }

    // The UI still answers, and each block shows its final write after a re-query.
    await withinTimeout(reopenPageByTitle(TITLE), 'reopening the page')
    for (let c = 0; c < CONNECTIONS; c++) {
      const final = `${MARKER} c${c} final`
      await $(`[data-testid="block-static"]*=${final}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    }
    expect(await blockStaticsByMarker(MARKER)).toHaveLength(CONNECTIONS)
  })
})
