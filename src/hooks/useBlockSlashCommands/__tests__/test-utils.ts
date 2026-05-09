/**
 * Shared synthetic-context builder for the sub-hook tests.
 *
 * Each sub-hook returns a `SlashHandlerTables` slice whose handlers take a
 * `SlashCommandContext` at call time. We build one here from `vi.fn()`
 * spies + an in-memory page store so tests can assert IPC calls (via the
 * global `invoke` mock) and verify state mutations directly.
 */

import { vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { makeBlock } from '../../../__tests__/fixtures'
import { createPageBlockStore, type PageBlockState } from '../../../stores/page-blocks'
import type { SlashCommandContext } from '../types'

export interface SyntheticCtx {
  ctx: SlashCommandContext
  pageStore: StoreApi<PageBlockState>
  setDatePickerMode: ReturnType<typeof vi.fn>
  setDatePickerOpen: ReturnType<typeof vi.fn>
  openTemplatePicker: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  t: ReturnType<typeof vi.fn>
}

export function makeSyntheticCtx(overrides?: {
  blockId?: string
  rootParentId?: string | null
  blocks?: Array<{ id: string; content: string; parent_id: string | null }>
}): SyntheticCtx {
  const blockId = overrides?.blockId ?? 'BLOCK_1'
  const rootParentId = overrides?.rootParentId ?? 'PAGE_1'
  const pageStore = createPageBlockStore('PAGE_1')
  pageStore.setState({
    blocks: (overrides?.blocks ?? [{ id: blockId, content: 'hello', parent_id: rootParentId }]).map(
      (b) => makeBlock(b),
    ),
  })

  const setDatePickerMode = vi.fn()
  const setDatePickerOpen = vi.fn()
  const openTemplatePicker = vi.fn(async () => {})
  const mount = vi.fn()
  const t = vi.fn((key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
  )
  const datePickerCursorPos = { current: undefined as number | undefined }

  const ctx: SlashCommandContext = {
    blockId,
    rootParentId,
    rovingEditor: {
      editor: null,
      mount: mount as unknown as (id: string, md: string) => void,
    },
    pageStore,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    t,
    openTemplatePicker,
  }

  return { ctx, pageStore, setDatePickerMode, setDatePickerOpen, openTemplatePicker, mount, t }
}
