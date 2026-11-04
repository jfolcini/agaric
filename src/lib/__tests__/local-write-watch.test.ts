import { describe, expect, it, vi } from 'vitest'

import { commands } from '@/lib/bindings'
import { watchLocalWrites } from '@/lib/local-write-watch'

function deferred(): {
  promise: Promise<string>
  resolve: (v: string) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: string) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('watchLocalWrites', () => {
  it('calls back once a write settles and hands its result to the caller', async () => {
    const call = deferred()
    const table = { editBlock: vi.fn(() => call.promise) }
    const onWrite = vi.fn()
    watchLocalWrites(table, onWrite)

    const result = table.editBlock()
    expect(onWrite).not.toHaveBeenCalled()
    call.resolve('row')

    await expect(result).resolves.toBe('row')
    expect(onWrite).toHaveBeenCalledTimes(1)
  })

  it('calls back on a rejected write and still rejects to the caller', async () => {
    const call = deferred()
    const table = { setTodoState: vi.fn(() => call.promise) }
    const onWrite = vi.fn()
    watchLocalWrites(table, onWrite)

    const result = table.setTodoState()
    call.reject(new Error('boom'))

    await expect(result).rejects.toThrow('boom')
    expect(onWrite).toHaveBeenCalledTimes(1)
  })

  it('wraps the generated note writes and leaves reads and non-note writes alone', () => {
    const table = { ...commands }
    watchLocalWrites(table, vi.fn())

    const wrapped = (Object.keys(commands) as Array<keyof typeof commands>).filter(
      (name) => table[name] !== commands[name],
    )
    for (const write of [
      'editBlock',
      'setTodoState',
      'setDueDate',
      'createPageInSpace',
      'deleteBlock',
      'undoOps',
      'compactOpLogCmd',
    ] as const) {
      expect(wrapped).toContain(write)
    }
    for (const notAWrite of [
      'listPagesWithMetadata',
      'getJournalPageByDate',
      'batchResolve',
      'logFrontend',
      'fetchLinkMetadata',
      'startSync',
      'recordPageOpen',
    ] as const) {
      expect(wrapped).not.toContain(notAWrite)
    }
  })
})
