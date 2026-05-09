/**
 * Template slash command — the dispatch table is one entry (`/template`)
 * that delegates to `ctx.openTemplatePicker`. The bulk of the picker logic
 * lives in `useTemplateSelection` (already covered by its own tests + the
 * top-level hook tests).
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSlashCommandTemplate } from '../useSlashCommandTemplate'
import { makeSyntheticCtx } from './test-utils'

vi.mock('../../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../lib/template-utils', () => ({
  insertTemplateBlocks: vi.fn(async () => ['NEW_1']),
  loadTemplatePagesWithPreview: vi.fn(async () => []),
}))

const defaultParams = () => ({
  focusedBlockId: 'BLOCK_1' as string | null,
  rootParentId: 'PAGE_1' as string | null,
  blocks: [{ id: 'BLOCK_1', parent_id: 'PAGE_1', content: 'hello' }],
  load: vi.fn(async () => {}),
  t: vi.fn((k: string) => k),
})

describe('useSlashCommandTemplate', () => {
  it('exposes a single /template handler that delegates to ctx.openTemplatePicker', async () => {
    const { result } = renderHook(() => useSlashCommandTemplate(defaultParams()))
    const { ctx, openTemplatePicker } = makeSyntheticCtx()
    await result.current.tables.exact['template']?.(ctx, { id: 'template', label: 'TEMPLATE' })
    expect(openTemplatePicker).toHaveBeenCalledTimes(1)
  })

  it('exposes no prefix entries', () => {
    const { result } = renderHook(() => useSlashCommandTemplate(defaultParams()))
    expect(result.current.tables.prefix).toEqual([])
    expect(Object.keys(result.current.tables.exact)).toEqual(['template'])
  })

  it('passes through useTemplateSelection state + handlers', () => {
    const { result } = renderHook(() => useSlashCommandTemplate(defaultParams()))
    expect(typeof result.current.handleTemplateSelect).toBe('function')
    expect(typeof result.current.openTemplatePicker).toBe('function')
    expect(typeof result.current.setTemplatePickerOpen).toBe('function')
    expect(result.current.templatePickerOpen).toBe(false)
    expect(result.current.templatePages).toEqual([])
  })

  it('keeps the dispatch table identity stable across rerenders', () => {
    const { result, rerender } = renderHook(
      ({ params }: { params: ReturnType<typeof defaultParams> }) => useSlashCommandTemplate(params),
      { initialProps: { params: defaultParams() } },
    )
    const firstTable = result.current.tables
    rerender({ params: defaultParams() })
    expect(result.current.tables).toBe(firstTable)
  })
})
