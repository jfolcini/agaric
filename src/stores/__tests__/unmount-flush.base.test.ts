/** #6533 — the flush hands the editor's stored text to the plain edit, which rebases from it. */

import { describe, expect, it, vi } from 'vitest'

import { runUnmountFlush } from '@/stores/unmount-flush'

type Edit = (id: string, content: string, options?: { baseText?: string }) => Promise<boolean>

function flush(base: string | undefined) {
  const edit = vi.fn<Edit>(() => Promise.resolve(true))
  runUnmountFlush({
    blockId: 'BLOCK',
    loaded: 'stored',
    changed: 'stored typed',
    base,
    edit,
    splitBlock: () => Promise.resolve(true),
    rootParentId: null,
  })
  return edit
}

describe('runUnmountFlush plain edit (#6533)', () => {
  it('sends the text the editor started from', () => {
    expect(flush('stored')).toHaveBeenCalledExactlyOnceWith('BLOCK', 'stored typed', {
      baseText: 'stored',
    })
  })

  it('sends an empty stored text as a base too', () => {
    expect(flush('')).toHaveBeenCalledExactlyOnceWith('BLOCK', 'stored typed', { baseText: '' })
  })

  it('sends no base when the caller has none', () => {
    expect(flush(undefined)).toHaveBeenCalledExactlyOnceWith('BLOCK', 'stored typed')
  })
})
