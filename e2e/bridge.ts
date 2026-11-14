/**
 * #6529 — a Playwright worker's bridge to the real backend.
 *
 * With `AGARIC_E2E_BRIDGE` naming the `bridge` binary, each worker starts one
 * bridge process and every test runs the app against it: the real commands on
 * a real vault, reset to a copy of the worker's template before each test.
 * With the variable unset nothing here runs, and the specs run on the mock.
 *
 * The protocol is in `src-tauri/src/headless/bridge.rs`; the page's half is
 * `src/lib/tauri-mock/bridge.ts`.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

/** The `bridge` binary to run the specs against; unset means the mock. */
export const BRIDGE_BINARY = process.env['AGARIC_E2E_BRIDGE']

export interface Bridge {
  /** What the page connects to. */
  readonly url: string
  /** One request; resolves with the reply's `ok`, rejects with its `err`. */
  request(op: string, fields?: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

/** The port the bridge prints as its first line, once it is listening. */
function listeningPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.stdout === null) {
      reject(new Error('bridge: no stdout to read the port from'))
      return
    }
    const lines = createInterface({ input: child.stdout })
    lines.once('line', (line) => {
      lines.close()
      resolve((JSON.parse(line) as { port: number }).port)
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`bridge: exited with ${code} before listening`)))
  })
}

export async function startBridge(binary: string): Promise<Bridge> {
  const root = await mkdtemp(path.join(tmpdir(), 'agaric-bridge-'))
  // Its stdin stays open for as long as this worker lives: the bridge exits
  // when it closes.
  const child = spawn(binary, [root], { stdio: ['pipe', 'pipe', 'inherit'] })
  const url = `ws://127.0.0.1:${await listeningPort(child)}`

  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`bridge: cannot reach ${url}`)))
  })
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >()
  let nextId = 1
  socket.addEventListener('message', (message: MessageEvent<string>) => {
    const frame = JSON.parse(message.data) as { id?: number; ok?: unknown; err?: unknown }
    // A pushed event has no id; this client asks for none.
    const asked = frame.id === undefined ? undefined : waiting.get(frame.id)
    if (asked === undefined) return
    waiting.delete(frame.id as number)
    if ('err' in frame) asked.reject(new Error(`bridge: ${JSON.stringify(frame.err)}`))
    else asked.resolve(frame.ok)
  })

  const request = (op: string, fields: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, op, ...fields }))
    })

  return {
    url,
    request,
    async stop() {
      socket.close()
      child.kill()
      await rm(root, { recursive: true, force: true })
    },
  }
}
