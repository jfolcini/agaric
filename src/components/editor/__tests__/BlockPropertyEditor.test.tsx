import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

/**
 * The four keys `validate_set_property` accepts an all-null ("clear") payload
 * for — `RESERVED_PROPERTY_KEYS` in `src-tauri/agaric-store/src/op.rs`.
 */
const RESERVED_KEYS = new Set(['todo_state', 'priority', 'due_date', 'scheduled_date'])

/**
 * Payload-shape rules of `validate_set_property`
 * (`src-tauri/agaric-store/src/op.rs:531`), returning the backend's error
 * string or `null` when the payload is accepted.
 *
 * Adversarial review — the fixture below USED to resolve `{status:'ok'}` for
 * every call, which made this suite structurally unable to see a rejected
 * write. It hid a live bug: the rename path's old-key clear sends an all-null
 * `set_property`, which the engine accepts only for the four reserved keys, so
 * every rename of an ordinary user key failed in production while every test
 * here passed. A fixture that cannot say "no" cannot falsify anything.
 */
function validateSetPropertyPayload(
  key: string,
  values: Record<string, unknown> | undefined,
): string | null {
  const fields = ['value_text', 'value_num', 'value_date', 'value_ref', 'value_bool'] as const
  const present = fields.filter((f) => values?.[f] != null)
  if (present.length === 0) {
    // count == 0 is legal for reserved keys ONLY (op.rs — "Reserved keys allow
    // all-null values (= clear the column)").
    return RESERVED_KEYS.has(key)
      ? null
      : 'SetProperty must have exactly 1 non-null value field, found 0'
  }
  if (present.length > 1) {
    return `SetProperty must have exactly 1 non-null value field, found ${present.length}`
  }
  // Empty / whitespace-only string fields are rejected by name.
  for (const f of ['value_text', 'value_date', 'value_ref'] as const) {
    const v = values?.[f]
    if (typeof v === 'string' && v.trim() === '') return `set_property.${f}.empty`
  }
  return null
}

/** Engine-faithful `set_property` fixture: rejects what `op.rs` rejects. */
function defaultSetProperty(...args: unknown[]): Promise<unknown> {
  const [, key, values] = args as [string, string, Record<string, unknown> | undefined]
  const error = validateSetPropertyPayload(key, values)
  return Promise.resolve(error ? { status: 'error', error } : { status: 'ok', data: {} })
}

// #2927 phase 4 — `BlockPropertyEditor` now calls `commands.setProperty`
// from `@/lib/bindings` directly instead of the `@/lib/tauri` wrapper.
const mockSetProperty = vi.fn(defaultSetProperty)
// #3275 — the key-rename path now reads the OLD key's raw typed row via
// `getProperties` (instead of re-writing the flattened display string) so it
// can carry `value_num`/`value_date`/etc. over to the new key unmolested.
const mockGetProperties = vi.fn().mockResolvedValue({ status: 'ok', data: [] })
// #4009 — the value commit now resolves the definition for THIS key itself
// when the prop-level `valueType` has not landed yet, instead of discarding
// what the user typed. #4010 — the key rename carries the old key's
// definition over, and an emptied chip clears via `deleteProperty`.
const mockGetPropertyDef = vi.fn().mockResolvedValue({ status: 'ok', data: null })
const mockCreatePropertyDef = vi.fn().mockResolvedValue({ status: 'ok', data: null })
const mockDeleteProperty = vi.fn().mockResolvedValue({ status: 'ok', data: {} })
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      setProperty: (...args: unknown[]) => mockSetProperty(...args),
      getProperties: (...args: unknown[]) => mockGetProperties(...args),
      getPropertyDef: (...args: unknown[]) => mockGetPropertyDef(...args),
      createPropertyDef: (...args: unknown[]) => mockCreatePropertyDef(...args),
      deleteProperty: (...args: unknown[]) => mockDeleteProperty(...args),
    },
  }
})

const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))

// Mock @floating-ui/dom — JSDOM has no layout engine, so mirror the pattern
// used by suggestion-renderer.test.ts / LinkPreviewTooltip.test.tsx. The
// `autoUpdate` mock invokes the update callback once on registration and
// re-invokes it on `window` `resize`, returning a cleanup fn — that is the
// minimal contract callers depend on.
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 42, y: 84 }),
  autoUpdate: vi.fn((_anchor: Element, _floating: Element, update: () => void) => {
    update()
    const handler = () => update()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
  offset: vi.fn(() => ({})),
}))

import { autoUpdate, computePosition } from '@floating-ui/dom'

import {
  BlockPropertyEditor,
  type BlockPropertyEditorProps,
} from '@/components/editor/BlockPropertyEditor'
import { logger } from '@/lib/logger'

// Make rAF synchronous so the deferred outside-click registration runs
// immediately within the test's microtask flush.
beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

function makeProps(overrides: Partial<BlockPropertyEditorProps> = {}): BlockPropertyEditorProps {
  return {
    blockId: 'BLOCK_1',
    editingProp: null,
    setEditingProp: vi.fn(),
    editingKey: null,
    setEditingKey: vi.fn(),
    selectOptions: null,
    isRefProp: false,
    refPages: [],
    refSearch: '',
    setRefSearch: vi.fn(),
    valueType: 'text',
    ...overrides,
  }
}

describe('BlockPropertyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // `clearAllMocks` clears CALLS, not implementations, so every mock whose
    // implementation a test replaces has to be re-seeded here or it leaks into
    // the next test (see the `mockReturnValueOnce` note in the review).
    mockSetProperty.mockImplementation(defaultSetProperty)
    mockGetProperties.mockResolvedValue({ status: 'ok', data: [] })
    mockGetPropertyDef.mockResolvedValue({ status: 'ok', data: null })
    mockCreatePropertyDef.mockResolvedValue({ status: 'ok', data: null })
    mockDeleteProperty.mockResolvedValue({ status: 'ok', data: {} })
  })

  it('renders nothing when editingProp and editingKey are null', () => {
    render(<BlockPropertyEditor {...makeProps()} />)
    expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument()
    expect(document.querySelector('.property-key-editor')).not.toBeInTheDocument()
    expect(document.querySelector('[data-editor-portal]')).not.toBeInTheDocument()
  })

  it('renders text input when editingProp is set without selectOptions', () => {
    render(<BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('2h')
  })

  it('saves value on blur when text has changed', async () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '4h' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'effort', {
        value_text: '4h',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      })
    })
    await waitFor(() => {
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
  })

  it('does not save when text has not changed', async () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)

    await waitFor(() => {
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
    expect(mockSetProperty).not.toHaveBeenCalled()
  })

  it('closes on Escape key', () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(setEditingProp).toHaveBeenCalledWith(null)
  })

  it('blurs input on Enter key', () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    // blur triggers setEditingProp(null)
    expect(setEditingProp).toHaveBeenCalledWith(null)
  })

  it('shows toast on save error', async () => {
    mockSetProperty.mockRejectedValueOnce(new Error('fail'))
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'new' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to save property')
    })
  })

  // #3275 — inline chip edits on a user-defined `number`/`date` property used
  // to hard-code `value_num: null` / `value_date: null` on every commit,
  // silently dropping the typed column even though the value type was
  // already resolvable (`usePropertyDefForEdit` → `valueType`). These pin the
  // inline path to `buildPropertyParams` — the exact function the drawer path
  // (`property-save-utils.ts` → `handleSaveProperty`) already uses — so the
  // two commit paths cannot diverge again without both failing here and in
  // `property-save-utils.test.ts`.
  describe('#3275 — typed column routing', () => {
    it('commits a number-typed inline edit through value_num, not value_text', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'estimate', value: '5' },
            valueType: 'number',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '8' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'estimate', {
          value_text: null,
          value_num: 8,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    it('commits a date-typed inline edit through value_date, not value_text', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'deadline', value: '2026-08-01' },
            valueType: 'date',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '2026-09-15' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'deadline', {
          value_text: null,
          value_num: null,
          value_date: '2026-09-15',
          value_ref: null,
          value_bool: null,
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    it('shows the invalidNumber toast and does not write when a number field gets unparseable input', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'estimate', value: '5' },
            valueType: 'number',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'abc' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Invalid number value')
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
    })

    it('carries the typed value_num column over on key rename instead of nulling it', async () => {
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'estimate',
            value_text: null,
            value_num: 5,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'estimate', value: '5' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'effortPoints' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'effortPoints', {
          value_text: null,
          value_num: 5,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      // The old key is then removed. This assertion used to pin an all-null
      // `set_property`, a payload `validate_set_property` rejects for any
      // non-reserved key — the test pinned a call that could only ever fail in
      // production. The invariant it means to hold ("the old key does not
      // survive the rename") is unchanged; the mechanism is the one the
      // backend actually accepts.
      await waitFor(() => {
        expect(mockDeleteProperty).toHaveBeenCalledWith('BLOCK_1', 'estimate')
      })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    // #3275 (review finding 1) — `valueType` is `null` until the property
    // definition for THIS key has resolved. Committing in that window used to
    // run against whatever type the PREVIOUS key resolved to (e.g.
    // `Number('2026-09-15')` → NaN/garbage in `value_num`), so the commit path
    // must never write against a guessed type.
    //
    // #4009 narrowed WHEN that refusal fires: the commit now resolves the
    // definition for THIS key before deciding (see the `#4009` describe), so
    // the only remaining "no type in hand" case is a lookup that actually
    // failed. That case still refuses, for exactly #3275's reason.
    it('refuses to write when the targeted definition lookup fails', async () => {
      mockGetPropertyDef.mockRejectedValueOnce(new Error('ipc down'))
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'deadline', value: '2026-08-01' },
            valueType: null,
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '2026-09-15' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to save property')
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    // #4008 review note 4 — routing the inline chip through
    // `buildPropertyParams` also brought `boolean` and `date` under it, and
    // both still render the PLAIN TEXT input. The two cases are deliberately
    // NOT treated alike, and these pin the difference:
    //
    //  * `date` passes the raw string through into `value_date` unvalidated.
    //    Kept: it is what #3275 asked for, it matches the drawer, and nothing
    //    is destroyed — whatever the user typed is what gets stored.
    //  * `boolean` used to COERCE anything that isn't the literal 'true' to
    //    `value_bool: false`, discarding the user's text. That is
    //    data-loss-shaped, so the inline path now refuses the commit and says
    //    so, exactly as it already does for an unparseable number.
    it('passes a date-typed inline edit through to value_date verbatim, unvalidated', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'deadline', value: '2026-08-01' },
            valueType: 'date',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'next tuesday' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'deadline', {
          value_text: null,
          value_num: null,
          value_date: 'next tuesday',
          value_ref: null,
          value_bool: null,
        })
      })
    })

    it('commits a boolean-typed inline edit through value_bool for the literal true/false', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'archived', value: 'false' },
            valueType: 'boolean',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'true' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'archived', {
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: true,
        })
      })
    })

    // #4010 (clear half) — an emptied chip on a USER-DEFINED key used to go
    // out as an all-null `set_property`, which `op.rs` rejects for a
    // non-reserved key (`SetProperty must have exactly 1 non-null value
    // field, found 0`), so the clear could never actually succeed. Clearing a
    // user-defined key is expressed as `delete_property` instead.
    it('clears a boolean-typed property by deleting it when the inline field is emptied', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'archived', value: 'true' },
            valueType: 'boolean',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockDeleteProperty).toHaveBeenCalledWith('BLOCK_1', 'archived')
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
      expect(mockToastError).not.toHaveBeenCalled()
    })

    it('refuses to coerce arbitrary text in a boolean chip to false', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'archived', value: 'true' },
            valueType: 'boolean',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'maybe' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Invalid boolean value — use true or false')
      })
      // The stored `value_bool: true` must survive: no write at all, rather
      // than a silent overwrite with `false`.
      expect(mockSetProperty).not.toHaveBeenCalled()
    })

    it('does not toast when an unresolved-type popup closes without an edit', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'deadline', value: '2026-08-01' },
            valueType: null,
            setEditingProp,
          })}
        />,
      )
      fireEvent.blur(screen.getByRole('textbox'))

      await waitFor(() => {
        expect(setEditingProp).toHaveBeenCalledWith(null)
      })
      expect(mockToastError).not.toHaveBeenCalled()
      expect(mockSetProperty).not.toHaveBeenCalled()
    })

    // #3275 (review finding 2) — when `getProperties` cannot produce the old
    // key's row (empty/stale cache, concurrent delete, key mismatch, IPC
    // failure) every `oldRow?.value_X ?? null` collapsed to null and the
    // rename wrote an ALL-NULL row under the new key, destroying the value.
    // The rename must abort and leave the original key untouched.
    it('aborts the rename when getProperties does not contain the old key', async () => {
      mockGetProperties.mockResolvedValue({ status: 'ok', data: [] })
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'duration' } })
      await act(async () => {
        fireEvent.blur(input)
      })

      // Neither the new-key write NOR the old-key clear may run: the original
      // `effort` row survives untouched.
      expect(mockSetProperty).not.toHaveBeenCalled()
      expect(mockToastError).toHaveBeenCalledWith('Failed to rename property')
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('aborts the rename when getProperties returns an error result', async () => {
      mockGetProperties.mockResolvedValue({ status: 'error', error: { kind: 'db' } })
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'duration' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to rename property')
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('aborts the rename when getProperties rejects', async () => {
      mockGetProperties.mockRejectedValueOnce(new Error('ipc down'))
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'duration' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to rename property')
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('carries the typed value_date column over on key rename instead of nulling it', async () => {
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'deadline',
            value_text: null,
            value_num: null,
            value_date: '2026-09-15',
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'deadline', value: '2026-09-15' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'dueBy' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'dueBy', {
          value_text: null,
          value_num: null,
          value_date: '2026-09-15',
          value_ref: null,
          value_bool: null,
        })
      })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })
  })

  // #4009 — the chip editor autofocuses and is designed to be typed into
  // immediately, so the user routinely finishes typing BEFORE the per-key
  // `getPropertyDef` lookup lands. #3275's abort was right not to write
  // against a type resolved for a different key, but it also threw the typed
  // text away. The commit now resolves the definition for THIS key itself,
  // so a late-arriving definition costs a moment, not the user's input.
  //
  // These tests are written around the ORDERING: the definition resolves only
  // after the blur. A test that awaited the lookup before typing would pass
  // against the broken code, because the race would already be over.
  describe('#4009 — late-resolving property definition', () => {
    it('commits the typed text once a late-resolving definition arrives', async () => {
      let resolveDef: (value: unknown) => void = () => {}
      mockGetPropertyDef.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDef = resolve
        }),
      )
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'estimate', value: '5' },
            // The lookup for `estimate` is still in flight — exactly the state
            // `usePropertyDefForEdit` is in for the first ~frame of the popup.
            valueType: null,
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '8' } })
      fireEvent.blur(input)

      // Still pending: nothing written yet, and — the point of the issue —
      // nothing thrown away either.
      expect(mockSetProperty).not.toHaveBeenCalled()

      // The definition lands only NOW, after the user has typed and blurred.
      await act(async () => {
        resolveDef({
          status: 'ok',
          data: { key: 'estimate', value_type: 'number', options: null, created_at: 'T' },
        })
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'estimate', {
          value_text: null,
          value_num: 8,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      expect(mockToastError).not.toHaveBeenCalled()
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    it('falls back to text when the late lookup MISSES, rather than discarding', async () => {
      let resolveDef: (value: unknown) => void = () => {}
      mockGetPropertyDef.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDef = resolve
        }),
      )
      render(
        <BlockPropertyEditor
          {...makeProps({ editingProp: { key: 'effort', value: '2h' }, valueType: null })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '4h' } })
      fireEvent.blur(input)
      await act(async () => {
        resolveDef({ status: 'ok', data: null })
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'effort', {
          value_text: '4h',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      expect(mockToastError).not.toHaveBeenCalled()
    })

    // The other arm: a definition that resolved NORMALLY must still apply its
    // own type, straight from the prop and without a second lookup. Without
    // this, "tolerate a late definition" could be satisfied by ignoring the
    // resolved one and flattening everything into `value_text`.
    it('uses an already-resolved definition as-is, with no extra lookup', async () => {
      render(
        <BlockPropertyEditor
          {...makeProps({ editingProp: { key: 'estimate', value: '5' }, valueType: 'number' })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '8' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'estimate', {
          value_text: null,
          value_num: 8,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      expect(mockGetPropertyDef).not.toHaveBeenCalled()
    })

    // A late-resolving `boolean` definition must still get the #4008 note-4
    // refusal, not a coerced `false`: deferring the type decision must not
    // skip the validation that hangs off it.
    it('still refuses arbitrary text on a boolean definition that resolves late', async () => {
      let resolveDef: (value: unknown) => void = () => {}
      mockGetPropertyDef.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDef = resolve
        }),
      )
      render(
        <BlockPropertyEditor
          {...makeProps({ editingProp: { key: 'archived', value: 'true' }, valueType: null })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'maybe' } })
      fireEvent.blur(input)
      await act(async () => {
        resolveDef({
          status: 'ok',
          data: { key: 'archived', value_type: 'boolean', options: null, created_at: 'T' },
        })
      })

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Invalid boolean value — use true or false')
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
    })
  })

  // #4010 — `set_property` never inserts a `property_definitions` row, so a
  // renamed key had no definition of its own: `getPropertyDef(newKey)` missed,
  // `valueType` fell back to `'text'`, and the NEXT inline edit re-flattened
  // the typed column that the rename had just carried over. The rename now
  // carries the DEFINITION alongside the value.
  //
  // The falsification is about the SECOND edit, and the definitions registry
  // below is stateful for exactly that reason: the second edit reads back
  // whatever the rename did (or did not) write.
  describe('#4010 — rename carries the property definition', () => {
    /** Stand-in `property_definitions` table, mutated by `createPropertyDef`. */
    function installDefinitionRegistry(
      seed: Array<{ key: string; value_type: string; options: string | null }>,
    ): Map<
      string,
      { key: string; value_type: string; options: string | null; created_at: string }
    > {
      const defs = new Map(seed.map((d) => [d.key, { ...d, created_at: 'T' }]))
      mockGetPropertyDef.mockImplementation((key: string) =>
        Promise.resolve({ status: 'ok', data: defs.get(key) ?? null }),
      )
      mockCreatePropertyDef.mockImplementation(
        (key: string, valueType: string, options: string | null) => {
          if (!defs.has(key))
            defs.set(key, { key, value_type: valueType, options, created_at: 'T' })
          return Promise.resolve({ status: 'ok', data: defs.get(key) })
        },
      )
      return defs
    }

    it('keeps value_num on the SECOND edit of a renamed number property', async () => {
      installDefinitionRegistry([{ key: 'estimate', value_type: 'number', options: null }])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'estimate',
            value_text: null,
            value_num: 5,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })

      // 1. Rename `estimate` → `effortPoints`.
      const { rerender } = render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'estimate', value: '5' } })} />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'effortPoints' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })
      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith(
          'BLOCK_1',
          'effortPoints',
          expect.objectContaining({ value_num: 5 }),
        )
      })
      mockSetProperty.mockClear()

      // 2. Open the renamed chip and edit it again. `valueType` is null
      //    because the popup's own per-key lookup has not landed yet — the
      //    commit resolves `effortPoints` against the registry, which is
      //    where the missing definition row bites.
      rerender(
        <BlockPropertyEditor
          {...makeProps({ editingProp: { key: 'effortPoints', value: '5' }, valueType: null })}
        />,
      )
      const valueInput = screen.getByRole('textbox')
      fireEvent.change(valueInput, { target: { value: '8' } })
      await act(async () => {
        fireEvent.blur(valueInput)
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'effortPoints', {
          value_text: null,
          value_num: 8,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
    })

    it('creates the new key definition BEFORE writing the carried value', async () => {
      installDefinitionRegistry([{ key: 'deadline', value_type: 'date', options: null }])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'deadline',
            value_text: null,
            value_num: null,
            value_date: '2026-09-15',
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      const order: string[] = []
      mockCreatePropertyDef.mockImplementation(() => {
        order.push('createPropertyDef')
        return Promise.resolve({ status: 'ok', data: null })
      })
      mockSetProperty.mockImplementation((...args: unknown[]) => {
        order.push('setProperty')
        // Delegate, so ordering instrumentation does not quietly re-open the
        // permissive fixture this suite used to rely on.
        return defaultSetProperty(...args)
      })

      render(
        <BlockPropertyEditor
          {...makeProps({ editingKey: { oldKey: 'deadline', value: '2026-09-15' } })}
        />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'dueBy' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })

      await waitFor(() => {
        expect(mockCreatePropertyDef).toHaveBeenCalledWith('dueBy', 'date', null)
      })
      // The engine validates the payload shape against the definition row, so
      // the definition has to exist before the typed write lands.
      expect(order[0]).toBe('createPropertyDef')
    })

    // The other arm: a property with NO definition of its own is genuinely
    // untyped, and must stay that way. The rename may carry a definition, not
    // invent one — otherwise "keeps its type" would be satisfied by declaring
    // a type for every key that ever gets renamed.
    it('invents no definition for an untyped property, which still flattens to value_text', async () => {
      installDefinitionRegistry([])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'note',
            value_text: 'hi',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })

      const { rerender } = render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'note', value: 'hi' } })} />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'remark' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })
      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith(
          'BLOCK_1',
          'remark',
          expect.objectContaining({ value_text: 'hi' }),
        )
      })
      expect(mockCreatePropertyDef).not.toHaveBeenCalled()
      mockSetProperty.mockClear()

      rerender(
        <BlockPropertyEditor
          {...makeProps({ editingProp: { key: 'remark', value: 'hi' }, valueType: null })}
        />,
      )
      const valueInput = screen.getByRole('textbox')
      fireEvent.change(valueInput, { target: { value: 'bye' } })
      await act(async () => {
        fireEvent.blur(valueInput)
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'remark', {
          value_text: 'bye',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
    })

    // Drift guard: if the old key's declared type disagrees with the column
    // actually being carried, copying the declaration would make the engine
    // reject the very write the rename is trying to perform. Skip the copy
    // and let the rename succeed exactly as it does today.
    it('skips the definition copy when the declared type contradicts the carried column', async () => {
      installDefinitionRegistry([{ key: 'estimate', value_type: 'number', options: null }])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'estimate',
            value_text: 'about five',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      render(
        <BlockPropertyEditor
          {...makeProps({ editingKey: { oldKey: 'estimate', value: 'about five' } })}
        />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'effortPoints' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith(
          'BLOCK_1',
          'effortPoints',
          expect.objectContaining({ value_text: 'about five' }),
        )
      })
      expect(mockCreatePropertyDef).not.toHaveBeenCalled()
    })

    // Adversarial review — the END-TO-END rename, against a `set_property`
    // fixture that enforces `validate_set_property`'s payload rules.
    //
    // The rename writes the new key and then CLEARS the old one, and that
    // clear went out as an all-null `set_property` — a payload the engine
    // accepts only for the four reserved keys. For an ordinary user key it is
    // rejected ("found 0"), `unwrap` throws, and the whole rename ends in
    // `property.renameFailed` with the old chip still on the block. Every test
    // here passed anyway, because the fixture said yes to everything.
    it('renames a user-defined key end to end, with no failure toast', async () => {
      installDefinitionRegistry([{ key: 'estimate', value_type: 'number', options: null }])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'estimate',
            value_text: null,
            value_num: 5,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })

      render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'estimate', value: '5' } })} />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'effortPoints' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })

      // The value lands on the new key...
      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith(
          'BLOCK_1',
          'effortPoints',
          expect.objectContaining({ value_num: 5 }),
        )
      })
      // ...the old key is removed the only way a user key CAN be removed...
      expect(mockDeleteProperty).toHaveBeenCalledWith('BLOCK_1', 'estimate')
      // ...never through the all-null payload the engine refuses for it...
      expect(mockSetProperty).not.toHaveBeenCalledWith('BLOCK_1', 'estimate', expect.anything())
      // ...and the user sees no failure.
      expect(mockToastError).not.toHaveBeenCalled()
    })

    // The other arm: the fixture must still be able to FAIL a rename, or the
    // test above would pass against a mock that simply says yes again.
    it('surfaces the failure toast when the carried write is genuinely rejected', async () => {
      installDefinitionRegistry([])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            // Whitespace-only `value_text` — rejected by name
            // (`set_property.value_text.empty`), exactly as the backend does.
            key: 'note',
            value_text: '   ',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })

      render(<BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'note', value: ' ' } })} />)
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'remark' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to rename property')
      })
      // The carried write failed, so the old key must SURVIVE — a rename that
      // could not write the new key must not delete the original.
      expect(mockDeleteProperty).not.toHaveBeenCalled()
    })

    // Adversarial review — renaming ONTO a column-backed key (`due_date` &
    // co., `space`) cannot succeed: those live in a `blocks` column and the
    // engine rejects the carried payload's shape. `create_property_def` has no
    // reserved-key guard of its own, so without an explicit skip the failed
    // rename would still persist a bogus global declaration ("due_date is a
    // number"), which the drawer and Properties tab then render against.
    it('declares nothing when the rename target is a column-backed key', async () => {
      installDefinitionRegistry([{ key: 'estimate', value_type: 'number', options: null }])
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'estimate',
            value_text: null,
            value_num: 5,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'estimate', value: '5' } })} />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'due_date' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith(
          'BLOCK_1',
          'due_date',
          expect.objectContaining({ value_num: 5 }),
        )
      })
      expect(mockCreatePropertyDef).not.toHaveBeenCalled()
    })

    // A failed definition copy must not fail the rename: the value carry is
    // the part that matters, and it worked before definitions were carried
    // at all.
    it('completes the rename even when the definition copy fails', async () => {
      installDefinitionRegistry([{ key: 'estimate', value_type: 'number', options: null }])
      mockCreatePropertyDef.mockRejectedValue(new Error('def write failed'))
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'estimate',
            value_text: null,
            value_num: 5,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'estimate', value: '5' } })} />,
      )
      const keyInput = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(keyInput, { target: { value: 'effortPoints' } })
      await act(async () => {
        fireEvent.blur(keyInput)
      })

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith(
          'BLOCK_1',
          'effortPoints',
          expect.objectContaining({ value_num: 5 }),
        )
      })
      expect(mockToastError).not.toHaveBeenCalled()
    })
  })

  // #4010 (clear half) — `buildPropertyParams` sends `''` through for a text
  // property and `null` for every other type, and `op.rs` rejects both for a
  // non-reserved key (`set_property.value_text.empty` / "found 0"). So an
  // inline chip on a user-defined key could not be cleared AT ALL: the user
  // got `property.saveFailed` whatever they did.
  describe('#4010 — clearing an inline chip', () => {
    it('deletes the property when a user-defined text chip is emptied', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'effort', value: '2h' },
            valueType: 'text',
            setEditingProp,
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockDeleteProperty).toHaveBeenCalledWith('BLOCK_1', 'effort')
      })
      // The rejected empty-string write must be gone, not merely tolerated.
      expect(mockSetProperty).not.toHaveBeenCalled()
      expect(mockToastError).not.toHaveBeenCalled()
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    it('clears a RESERVED key through the all-null set_property it accepts', async () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'due_date', value: '2026-09-15' },
            valueType: 'date',
          })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'due_date', {
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      // The all-null payload is the ONLY clear `validate_set_property` accepts
      // for a reserved key (count==0 is legal for those four alone), so the
      // clear must not be re-routed through `delete_property`.
      expect(mockDeleteProperty).not.toHaveBeenCalled()
    })

    it('surfaces a failed clear instead of silently closing', async () => {
      mockDeleteProperty.mockRejectedValueOnce(new Error('nope'))
      render(
        <BlockPropertyEditor
          {...makeProps({ editingProp: { key: 'effort', value: '2h' }, valueType: 'text' })}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to save property')
      })
    })
  })

  // ── portal + floating-ui ─────────────────────────────────────
  describe('portal rendering', () => {
    it('renders the value popup as a portal in document.body, not inside the trigger tree', () => {
      const { container } = render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('[role="dialog"]')
      expect(popup).toBeInTheDocument()
      expect(popup).toHaveAttribute('data-editor-portal')
      // The popup must NOT live inside the rendered React subtree — that's
      // The whole point of (escapes overflow:hidden ancestors).
      expect(container.contains(popup)).toBe(false)
      expect(popup?.parentElement).toBe(document.body)
    })

    // This is a custom floating-UI portal, not a Radix
    // PopoverContent, so the Radix `max-w-[calc(100vw-2rem)]` baseline does
    // not apply. The inner ref-picker fieldset is hard-coded `w-56` and
    // would clip on a 360 px phone without an explicit viewport cap on the
    // outer portal.
    it('value popup portal carries max-w-[calc(100vw-2rem)] viewport constraint', () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('[data-editor-portal]') as HTMLElement
      expect(popup).toBeInTheDocument()
      expect(popup.className).toContain('max-w-[calc(100vw-2rem)]')
    })

    it('renders the key-rename popup as a portal with property-key-editor + data-editor-portal', () => {
      const { container } = render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('.property-key-editor')
      expect(popup).toBeInTheDocument()
      expect(popup).toHaveAttribute('data-editor-portal')
      expect(container.contains(popup)).toBe(false)
      expect(popup?.parentElement).toBe(document.body)
    })

    it('calls computePosition + autoUpdate when the value popup mounts', async () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      await waitFor(() => {
        expect(autoUpdate).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.any(HTMLElement),
          expect.any(Function),
        )
        expect(computePosition).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.any(HTMLElement),
          expect.objectContaining({ placement: 'bottom-start' }),
        )
      })
    })

    it('recomputes position on window resize', async () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      await waitFor(() => {
        expect(computePosition).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.any(HTMLElement),
          expect.objectContaining({ placement: 'bottom-start' }),
        )
      })
      vi.mocked(computePosition).mockClear()
      fireEvent(window, new Event('resize'))
      await waitFor(() => {
        expect(computePosition).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.any(HTMLElement),
          expect.objectContaining({ placement: 'bottom-start' }),
        )
      })
    })

    it('cleans up the portal when editingProp returns to null', () => {
      const { rerender } = render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      expect(document.querySelector('[data-editor-portal]')).toBeInTheDocument()
      rerender(<BlockPropertyEditor {...makeProps({ editingProp: null })} />)
      expect(document.querySelector('[data-editor-portal]')).not.toBeInTheDocument()
    })

    it('logs a warning when computePosition rejects (stale state lifecycle)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const err = new Error('computePosition boom')
      vi.mocked(computePosition).mockRejectedValueOnce(err)

      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'BlockPropertyEditor',
          'value popup computePosition failed',
          { key: 'effort' },
          err,
        )
      })
      warnSpy.mockRestore()
    })

    it('logs a warning when the anchor is detached while the popup is open', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      await waitFor(() => {
        expect(autoUpdate).toHaveBeenCalledWith(
          expect.any(HTMLElement),
          expect.any(HTMLElement),
          expect.any(Function),
        )
      })

      // Pull the update callback handed to autoUpdate, simulate the anchor
      // being torn out of the document tree, then invoke it manually — this
      // is the desync `update()` guards against (mirrors
      // `suggestion-renderer.ts:onUpdate`). We override `isConnected` rather
      // than calling `.remove()` so React's reconciliation can still unmount
      // the element cleanly during test teardown.
      const calls = vi.mocked(autoUpdate).mock.calls
      const lastCall = calls.at(-1)
      expect(lastCall).toBeDefined()
      const update = lastCall?.[2] as () => void
      const anchor = document.querySelector(
        '[data-testid="block-property-editor-anchor"]',
      ) as HTMLElement | null
      expect(anchor).toBeInTheDocument()
      Object.defineProperty(anchor, 'isConnected', { configurable: true, get: () => false })

      warnSpy.mockClear()
      update()

      expect(warnSpy).toHaveBeenCalledWith(
        'BlockPropertyEditor',
        'anchor unmounted while value popup open',
        expect.objectContaining({ key: 'effort' }),
      )
      warnSpy.mockRestore()
    })

    it('dismisses the value popup on outside click', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'effort', value: '2h' },
            setEditingProp,
          })}
        />,
      )

      // Wait for the deferred (rAF) registration of the outside-click handler.
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeInTheDocument()
      })

      // Click on document.body (outside both the popup and the anchor).
      fireEvent.pointerDown(document.body)
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    it('does not dismiss on click inside the popup', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'effort', value: '2h' },
            setEditingProp,
          })}
        />,
      )
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeInTheDocument()
      })
      const popup = document.querySelector('[role="dialog"]') as HTMLElement
      fireEvent.pointerDown(popup)
      expect(setEditingProp).not.toHaveBeenCalled()
    })

    it('focuses the input on mount', async () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      const input = await screen.findByRole('textbox')
      expect(input).toHaveFocus()
    })
  })

  describe('select options dropdown', () => {
    it('renders select options when available', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed', 'review'],
          })}
        />,
      )
      expect(screen.getByTestId('select-options-dropdown')).toBeInTheDocument()
      expect(screen.getByText('open')).toBeInTheDocument()
      expect(screen.getByText('closed')).toBeInTheDocument()
      expect(screen.getByText('review')).toBeInTheDocument()
    })

    it('highlights current value', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed'],
          })}
        />,
      )
      const openBtn = screen.getByText('open')
      expect(openBtn.className).toContain('font-medium')
    })

    it('calls setProperty on option click', async () => {
      const user = userEvent.setup()
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed'],
            setEditingProp,
          })}
        />,
      )
      await user.click(screen.getByText('closed'))

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'status', {
          value_text: 'closed',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    // Regression: the popover wrapper must expose listbox
    // semantics, each option must carry `role="option"` + `aria-selected`,
    // and the listbox's `aria-activedescendant` must point at the selected
    // option's id. Mirrors the in-repo reference in
    // `TagValuePicker.tsx:172–199`.
    it('exposes ARIA listbox semantics on the select-options dropdown', async () => {
      const { container } = render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'closed' },
            selectOptions: ['open', 'closed', 'review'],
          })}
        />,
      )

      const listbox = screen.getByTestId('select-options-dropdown')
      expect(listbox).toHaveAttribute('role', 'listbox')

      const options = screen.getAllByRole('option')
      expect(options).toHaveLength(3)

      // 'closed' is selected (matches editingProp.value).
      const [openOpt, closedOpt, reviewOpt] = options
      expect(openOpt).toHaveAttribute('aria-selected', 'false')
      expect(closedOpt).toHaveAttribute('aria-selected', 'true')
      expect(reviewOpt).toHaveAttribute('aria-selected', 'false')

      // aria-activedescendant must reference the selected option's id.
      const activeId = listbox.getAttribute('aria-activedescendant')
      expect(activeId).toBeTruthy()
      expect(closedOpt?.id).toBe(activeId)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    // #976 (item 10) — the listbox previously had ARIA but ZERO key handlers, so
    // AT users had to Tab through every option. Verify Arrow/Home/End move the
    // `aria-activedescendant` and Enter commits the active option.
    it('moves aria-activedescendant on ArrowDown/ArrowUp (#976)', async () => {
      const user = userEvent.setup()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed', 'review'],
          })}
        />,
      )

      const listbox = screen.getByTestId('select-options-dropdown')
      const options = screen.getAllByRole('option')
      // Seeds on the selected value ('open' → index 0).
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0]?.id)

      listbox.focus()
      await user.keyboard('{ArrowDown}')
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]?.id)

      await user.keyboard('{ArrowDown}')
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[2]?.id)

      // Clamps at the last option.
      await user.keyboard('{ArrowDown}')
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[2]?.id)

      await user.keyboard('{ArrowUp}')
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    })

    it('jumps to first/last option on Home/End (#976)', async () => {
      const user = userEvent.setup()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed', 'review'],
          })}
        />,
      )
      const listbox = screen.getByTestId('select-options-dropdown')
      const options = screen.getAllByRole('option')
      listbox.focus()

      await user.keyboard('{End}')
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[2]?.id)
      await user.keyboard('{Home}')
      expect(listbox.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    })

    it('commits the active option on Enter (#976)', async () => {
      const user = userEvent.setup()
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed', 'review'],
            setEditingProp,
          })}
        />,
      )
      const listbox = screen.getByTestId('select-options-dropdown')
      listbox.focus()
      // Move to 'closed' then commit.
      await user.keyboard('{ArrowDown}{Enter}')
      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'status', {
          value_text: 'closed',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    // #976 (item 11) — keyboard users need a visible focus ring while navigating
    // the listbox; the option buttons must carry the shared `focus-ring-visible`.
    it('applies focus-ring-visible to the option buttons (#976)', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed'],
          })}
        />,
      )
      for (const opt of screen.getAllByRole('option')) {
        expect(opt.className).toContain('focus-ring-visible')
      }
    })
  })

  describe('ref picker', () => {
    const pages = [
      {
        id: 'P1',
        content: 'Page Alpha',
        block_type: 'page',
        parent_id: null,
        position: null,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      },
      {
        id: 'P2',
        content: 'Page Beta',
        block_type: 'page',
        parent_id: null,
        position: null,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      },
    ]

    it('renders ref picker when isRefProp is true', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: 'P1' },
            isRefProp: true,
            refPages: pages,
          })}
        />,
      )
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
      expect(screen.getByTestId('ref-search-input')).toBeInTheDocument()
      // The search input has a programmatic name independent of its
      // placeholder, so it is reachable by its accessible name.
      expect(screen.getByLabelText('Search pages...')).toBe(screen.getByTestId('ref-search-input'))
      expect(screen.getByText('Page Alpha')).toBeInTheDocument()
      expect(screen.getByText('Page Beta')).toBeInTheDocument()
    })

    // #976 (item 11) — ref-picker option buttons also need the visible focus ring.
    it('applies focus-ring-visible to the ref-picker option buttons (#976)', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: 'P1' },
            isRefProp: true,
            refPages: pages,
          })}
        />,
      )
      const alpha = screen.getByText('Page Alpha').closest('button')
      expect(alpha?.className).toContain('focus-ring-visible')
    })

    it('filters pages by search text', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            refSearch: 'alpha',
          })}
        />,
      )
      expect(screen.getByText('Page Alpha')).toBeInTheDocument()
      expect(screen.queryByText('Page Beta')).not.toBeInTheDocument()
    })

    // Unicode-aware fold via `matchesSearchFolded`.
    it('ref picker matches Turkish İstanbul when query is lowercase istanbul', () => {
      const unicodePages = [
        {
          id: 'P1',
          content: 'İstanbul trip',
          block_type: 'page',
          parent_id: null,
          position: null,
          deleted_at: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
        {
          id: 'P2',
          content: 'Ankara plans',
          block_type: 'page',
          parent_id: null,
          position: null,
          deleted_at: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
        },
      ]
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: unicodePages,
            refSearch: 'istanbul',
          })}
        />,
      )
      expect(screen.getByText('İstanbul trip')).toBeInTheDocument()
      expect(screen.queryByText('Ankara plans')).not.toBeInTheDocument()
    })

    it('shows no results message when filtered list is empty', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            refSearch: 'zzzzz',
          })}
        />,
      )
      expect(screen.getByTestId('ref-no-results')).toBeInTheDocument()
    })

    it('calls setRefSearch on input change', async () => {
      const user = userEvent.setup()
      const setRefSearch = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            setRefSearch,
          })}
        />,
      )
      await user.type(screen.getByTestId('ref-search-input'), 'a')
      expect(setRefSearch).toHaveBeenCalledWith('a')
    })

    it('calls setProperty with valueRef on page selection', async () => {
      const user = userEvent.setup()
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            setEditingProp,
          })}
        />,
      )
      await user.click(screen.getByText('Page Beta'))

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'ref', {
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: 'P2',
          value_bool: null,
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
  })

  describe('key rename popover', () => {
    it('renders key rename input when editingKey is set', () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('.property-key-editor')
      expect(popup).toBeInTheDocument()
      const input = popup?.querySelector('input') as HTMLInputElement
      expect(input).toHaveValue('effort')
    })

    it('renames key on blur with new name, carrying the raw typed row', async () => {
      // #3275 — the rename reads the OLD key's raw row via `getProperties`
      // (not the flattened `editingKey.value` display string) so it can
      // carry the exact typed columns to the new key.
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'effort',
            value_text: '2h',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'time' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith('BLOCK_1', 'time', {
          value_text: '2h',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
      })
      // Old key removed via `delete_property` — the all-null `set_property`
      // this used to assert is rejected by the engine for a non-reserved key.
      await waitFor(() => {
        expect(mockDeleteProperty).toHaveBeenCalledWith('BLOCK_1', 'effort')
      })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('does not rename when key has not changed', async () => {
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.blur(input)

      await waitFor(() => {
        expect(setEditingKey).toHaveBeenCalledWith(null)
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
    })

    it('shows toast on rename error', async () => {
      // The old key's row must resolve, otherwise the rename aborts before it
      // ever reaches `setProperty` (see the getProperties-miss test above) and
      // this would pass without exercising the write-failure path at all.
      mockGetProperties.mockResolvedValue({
        status: 'ok',
        data: [
          {
            key: 'effort',
            value_text: '2h',
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          },
        ],
      })
      mockSetProperty.mockRejectedValueOnce(new Error('fail'))
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'time' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to rename property')
      })
    })

    it('closes on Escape key', () => {
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('dismisses on outside click', async () => {
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      await waitFor(() => {
        expect(document.querySelector('.property-key-editor')).toBeInTheDocument()
      })
      fireEvent.pointerDown(document.body)
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })
  })

  it('has no a11y violations (text input mode)', async () => {
    const { container } = render(
      <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (select mode)', async () => {
    const { container } = render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'status', value: 'open' },
          selectOptions: ['open', 'closed'],
        })}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (ref picker mode)', async () => {
    const { container } = render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'ref', value: '' },
          isRefProp: true,
          refPages: [],
        })}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations on the portal contents (text input mode)', async () => {
    render(<BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />)
    const portal = document.querySelector('[data-editor-portal]') as HTMLElement
    expect(portal).toBeInTheDocument()
    await waitFor(async () => {
      const results = await axe(portal)
      expect(results).toHaveNoViolations()
    })
  })
})
