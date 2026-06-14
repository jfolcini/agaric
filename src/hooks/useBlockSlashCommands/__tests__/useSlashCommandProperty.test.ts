/**
 * Property-related slash commands: TODO state, priority, assignee/location
 * (exact + presets), effort, repeat, repeat-limit, attach.
 */

import { invoke } from '@tauri-apps/api/core'
import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '../../../lib/logger'
import { useUndoStore } from '../../../stores/undo'
import { useSlashCommandProperty } from '../useSlashCommandProperty'
import { makeSyntheticCtx } from './test-utils'

vi.mock('../../../lib/announcer', () => ({ announce: vi.fn() }))
vi.mock('../../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../lib/repeat-utils', () => ({ formatRepeatLabel: vi.fn((v: string) => v) }))

const mockedInvoke = vi.mocked(invoke)
const originalOnNewAction = useUndoStore.getState().onNewAction

afterEach(() => {
  useUndoStore.setState({
    ...useUndoStore.getState(),
    onNewAction: originalOnNewAction,
    pages: new Map(),
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue(undefined)
})

describe('useSlashCommandProperty — TODO state', () => {
  it('sets TODO state and notifies undo', async () => {
    const onNewAction = vi.fn()
    useUndoStore.setState({ ...useUndoStore.getState(), onNewAction })
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx, pageStore } = makeSyntheticCtx()

    await result.current.exact['todo']?.(ctx, { id: 'todo', label: 'TODO' })

    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: 'TODO',
    })
    expect(onNewAction).toHaveBeenCalledWith('PAGE_1')
    expect(pageStore.getState().blocks[0]?.todo_state).toBe('TODO')
  })

  it.each(['doing', 'cancelled', 'done'] as const)('sets %s state', async (id) => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact[id]?.(ctx, { id, label: id.toUpperCase() })
    expect(mockedInvoke).toHaveBeenCalledWith('set_todo_state', {
      blockId: 'BLOCK_1',
      state: id.toUpperCase(),
    })
  })

  it('warns about unresolved dependencies on /done (F-37)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_property') return { value_ref: 'BLK_OTHER' }
      return undefined
    })
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()

    await result.current.exact['done']?.(ctx, { id: 'done', label: 'DONE' })
    // F-37 dependency check is fire-and-forget (Promise.then). Wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      'dependency.dependencyWarning',
      expect.objectContaining({ id: 'dependency-warning' }),
    )
  })

  it('toasts on TODO failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()

    await result.current.exact['todo']?.(ctx, { id: 'todo', label: 'TODO' })

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.setTaskStateFailed')
  })
})

describe('useSlashCommandProperty — priority', () => {
  it.each([
    ['priority-high', '1'],
    ['priority-medium', '2'],
    ['priority-low', '3'],
  ] as const)('%s sends level %s', async (id, level) => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact[id]?.(ctx, { id, label: id })
    expect(mockedInvoke).toHaveBeenCalledWith('set_priority', { blockId: 'BLOCK_1', level })
  })

  it('toasts on priority failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['priority-high']?.(ctx, { id: 'priority-high', label: 'PRIORITY' })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.setPriorityFailed')
  })
})

describe('useSlashCommandProperty — assignee + location', () => {
  it('/assignee opens an empty assignee property', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['assignee']?.(ctx, {
      id: 'assignee',
      label: 'ASSIGNEE — Set assignee',
    })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'assignee',
        value: expect.objectContaining({ value_text: '' }),
      }),
    )
  })

  it('/location opens an empty location property', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    await result.current.exact['location']?.(ctx, {
      id: 'location',
      label: 'LOCATION — Set location',
    })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'location',
        value: expect.objectContaining({ value_text: '' }),
      }),
    )
  })

  it('assignee-* preset extracts value from label and sets it', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'assignee-')?.[1]
    expect(handler).toBeDefined()
    await handler?.(ctx, { id: 'assignee-me', label: 'ASSIGNEE me — Set me as assignee' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'assignee',
        value: expect.objectContaining({ value_text: 'me' }),
      }),
    )
  })

  it('assignee-custom routes through the empty-value branch', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'assignee-')?.[1]
    await handler?.(ctx, { id: 'assignee-custom', label: 'ASSIGNEE custom' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'assignee',
        value: expect.objectContaining({ value_text: '' }),
      }),
    )
  })

  it('location-* preset extracts value from label and sets it', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'location-')?.[1]
    await handler?.(ctx, { id: 'location-office', label: 'LOCATION office — At the office' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'location',
        value: expect.objectContaining({ value_text: 'office' }),
      }),
    )
  })

  it('location-custom routes through the empty-value branch', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'location-')?.[1]
    await handler?.(ctx, { id: 'location-custom', label: 'LOCATION custom' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'location',
        value: expect.objectContaining({ value_text: '' }),
      }),
    )
  })
})

describe('useSlashCommandProperty — effort', () => {
  it('effort-1h sets value_text=1h', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'effort-')?.[1]
    await handler?.(ctx, { id: 'effort-1h', label: 'EFFORT 1h' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'effort',
        value: expect.objectContaining({ value_text: '1h' }),
      }),
    )
  })

  it('effort-custom routes through the empty-value branch (escape hatch, #1107)', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'effort-')?.[1]
    await handler?.(ctx, { id: 'effort-custom', label: 'EFFORT Custom...' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'effort',
        value: expect.objectContaining({ value_text: '' }),
      }),
    )
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('blockTree.addedEffortProperty')
  })

  it('toasts addPropertyFailed when effort-custom fails (#1107)', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'effort-')?.[1]
    await handler?.(ctx, { id: 'effort-custom', label: 'EFFORT Custom...' })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('blockTree.addPropertyFailed')
  })

  it('toasts on effort failure', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('fail'))
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'effort-')?.[1]
    await handler?.(ctx, { id: 'effort-2h', label: 'EFFORT 2h' })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('slash.effortFailed')
  })
})

describe('useSlashCommandProperty — repeat / repeat-limit', () => {
  it('repeat-daily sets value_text=daily', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'repeat-')?.[1]
    await handler?.(ctx, { id: 'repeat-daily', label: 'REPEAT DAILY' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'repeat',
        value: expect.objectContaining({ value_text: 'daily' }),
      }),
    )
  })

  it('repeat-remove deletes the property', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'repeat-')?.[1]
    await handler?.(ctx, { id: 'repeat-remove', label: 'REPEAT REMOVE' })
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'repeat',
    })
  })

  it('repeat-limit-5 sets repeat-count=5', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'repeat-limit-')?.[1]
    await handler?.(ctx, { id: 'repeat-limit-5', label: 'REPEAT LIMIT 5' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'set_property',
      expect.objectContaining({
        blockId: 'BLOCK_1',
        key: 'repeat-count',
        value: expect.objectContaining({ value_num: 5 }),
      }),
    )
  })

  it('repeat-limit-remove deletes both repeat-count and repeat-until', async () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    const { ctx } = makeSyntheticCtx()
    const handler = result.current.prefix.find(([p]) => p === 'repeat-limit-')?.[1]
    await handler?.(ctx, { id: 'repeat-limit-remove', label: 'REPEAT LIMIT REMOVE' })
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'repeat-count',
    })
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'repeat-until',
    })
  })
})

describe('useSlashCommandProperty — attach', () => {
  // Helper: intercept the hidden file <input> the attach handler creates so we
  // can drive its `onchange` with a synthetic File. Returns a getter for the
  // captured input (populated once the handler runs).
  function interceptFileInput(): { get: () => HTMLInputElement | null; restore: () => void } {
    let captured: HTMLInputElement | null = null
    const origCreateElement = document.createElement.bind(document)
    const spy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string, options?: ElementCreationOptions) => {
        const el = origCreateElement(tag, options)
        if (tag === 'input') {
          captured = el as HTMLInputElement
          vi.spyOn(captured, 'click').mockImplementation(() => {})
        }
        return el
      })
    return { get: () => captured, restore: () => spy.mockRestore() }
  }

  it('ships file bytes via add_attachment_with_bytes for an allowed file', async () => {
    mockedInvoke.mockResolvedValue({
      id: 'att-1',
      block_id: 'BLOCK_1',
      filename: 'photo.png',
      mime_type: 'image/png',
      size_bytes: 4,
      fs_path: 'attachments/att-1',
      created_at: '2025-01-01',
    })
    const input = interceptFileInput()
    try {
      const { result } = renderHook(() => useSlashCommandProperty())
      const { ctx } = makeSyntheticCtx()
      result.current.exact['attach']?.(ctx, { id: 'attach', label: 'ATTACH' })

      const el = input.get()
      expect(el).not.toBeNull()
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' })
      // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by expect(el).not.toBeNull() above
      Object.defineProperty(el!, 'files', { value: [file] })
      // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded above
      await el!.onchange?.(new Event('change'))

      expect(mockedInvoke).toHaveBeenCalledWith('add_attachment_with_bytes', {
        blockId: 'BLOCK_1',
        filename: 'photo.png',
        mimeType: 'image/png',
        bytes: [1, 2, 3, 4],
      })
    } finally {
      input.restore()
    }
  })

  it('rejects a disallowed file type: no add IPC, surfaces an error toast', async () => {
    const input = interceptFileInput()
    try {
      const { result } = renderHook(() => useSlashCommandProperty())
      const { ctx } = makeSyntheticCtx()
      result.current.exact['attach']?.(ctx, { id: 'attach', label: 'ATTACH' })

      const el = input.get()
      const file = new File([new Uint8Array([0, 1])], 'evil.exe', {
        type: 'application/x-msdownload',
      })
      // oxlint-disable-next-line typescript/no-non-null-assertion -- input is created by the handler
      Object.defineProperty(el!, 'files', { value: [file] })
      // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded above
      await el!.onchange?.(new Event('change'))

      expect(mockedInvoke).not.toHaveBeenCalledWith('add_attachment_with_bytes', expect.anything())
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'blockTree.attachmentTypeNotAllowed:{"type":"application/x-msdownload"}',
      )
    } finally {
      input.restore()
    }
  })

  it('FE-M-6: surfaces toast + logger.warn when input.click() throws', async () => {
    const originalClick = HTMLInputElement.prototype.click
    const clickMock = vi.fn(() => {
      throw new Error('mock click')
    })
    Object.defineProperty(HTMLInputElement.prototype, 'click', {
      value: clickMock,
      configurable: true,
      writable: true,
    })
    try {
      const { result } = renderHook(() => useSlashCommandProperty())
      const { ctx } = makeSyntheticCtx()
      result.current.exact['attach']?.(ctx, { id: 'attach', label: 'ATTACH' })
      expect(clickMock).toHaveBeenCalled()
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('attachments.openFileDialogFailed')
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'useBlockSlashCommands',
        'input.click failed',
        undefined,
        expect.any(Error),
      )
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, 'click', {
        value: originalClick,
        configurable: true,
        writable: true,
      })
    }
  })
})

describe('useSlashCommandProperty — table identity', () => {
  it('returns a stable table identity across rerenders', () => {
    const { result, rerender } = renderHook(() => useSlashCommandProperty())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('exposes the expected exact + prefix surface', () => {
    const { result } = renderHook(() => useSlashCommandProperty())
    expect(Object.keys(result.current.exact).sort()).toEqual(
      [
        'todo',
        'doing',
        'cancelled',
        'done',
        'priority-high',
        'priority-medium',
        'priority-low',
        'assignee',
        'location',
        'attach',
      ].sort(),
    )
    expect(result.current.prefix.map(([p]) => p)).toEqual([
      'assignee-',
      'location-',
      'effort-',
      'repeat-limit-',
      'repeat-',
    ])
  })
})
