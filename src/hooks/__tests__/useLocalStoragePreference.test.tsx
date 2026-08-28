// @vitest-environment jsdom
// Same as useBlockCollapse — spies on `Storage.prototype.{getItem,setItem}`
// don't intercept under happy-dom. Pin to jsdom until refactored.

/**
 * Tests for useLocalStoragePreference hook.
 *
 * Validates:
 *  - Reads stored value via JSON.parse (default) and falls back to default
 *    when not present.
 *  - Falls back to default + logs when localStorage.getItem throws.
 *  - Falls back silently to default when stored value can't be parsed.
 *  - Persists writes via JSON.stringify (default).
 *  - Logs (does not throw) when localStorage.setItem throws.
 *  - Custom parse/serialize transformers work for legacy bare-string formats.
 *  - Cross-instance sync (#2666): a write in one mounted instance updates
 *    every other instance on the same key; the broadcast is a fully
 *    populated synthetic StorageEvent; a cross-window (native) storage
 *    event triggers a re-read; snapshots stay referentially stable while
 *    the stored raw value is unchanged; a failed write degrades to
 *    in-memory for the calling instance only, with no broadcast.
 */

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { logger } from '@/lib/logger'

// The one `useState(null)` call in useLocalStoragePreference is the
// `failedWrite` slot (nothing else in this tree calls `useState` with a
// `null` initializer). Vitest can't `vi.spyOn` a live ESM namespace export
// (`useState` is non-configurable), so intercept it via `vi.mock` instead —
// wrapping each real setter in a `vi.fn` the first time it's seen lets a
// test assert on the actual setter invocation, not on an inferable side
// effect like render count (which React's own same-value bailout could mask
// either way). See "does not fire a redundant setState…" below.
const failedWriteSetterSpies = new Map<
  (value: unknown) => void,
  ReturnType<typeof vi.fn<(value: unknown) => void>>
>()

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const result = actual.useState(initial as never)
      if (initial === null) {
        const real = result[1] as (value: unknown) => void
        let spy = failedWriteSetterSpies.get(real)
        if (spy === undefined) {
          spy = vi.fn(real)
          failedWriteSetterSpies.set(real, spy)
        }
        return [result[0], spy]
      }
      return result
    },
  }
})

interface HarnessProps<T> {
  storageKey: string
  defaultValue: T
  options?: Parameters<typeof useLocalStoragePreference<T>>[2]
  onState?: (value: T, setter: (next: T | ((prev: T) => T)) => void) => void
}

function Harness<T>({ storageKey, defaultValue, options, onState }: HarnessProps<T>) {
  const [value, setValue] = useLocalStoragePreference(storageKey, defaultValue, options)
  onState?.(value, setValue)
  return null
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  failedWriteSetterSpies.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('useLocalStoragePreference', () => {
  it('returns the default when the key is missing', () => {
    let captured: number | null = null
    render(
      <Harness
        storageKey="test:missing"
        defaultValue={42}
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toBe(42)
  })

  it('reads a JSON-encoded value on mount', () => {
    localStorage.setItem('test:read', JSON.stringify({ count: 7 }))
    let captured: { count: number } | null = null
    render(
      <Harness
        storageKey="test:read"
        defaultValue={{ count: 0 }}
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toEqual({ count: 7 })
  })

  it('falls back silently when stored JSON is malformed', () => {
    localStorage.setItem('test:bad-json', '{not valid json')
    const warnSpy = vi.spyOn(logger, 'warn')
    let captured: number | null = null
    render(
      <Harness
        storageKey="test:bad-json"
        defaultValue={123}
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toBe(123)
    // Parsing failure is intentionally silent — no log.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs and falls back to default when localStorage.getItem throws', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied')
    })
    const warnSpy = vi.spyOn(logger, 'warn')
    let captured: string | null = null
    render(
      <Harness
        storageKey="test:throw-read"
        defaultValue="fallback"
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toBe('fallback')
    expect(warnSpy).toHaveBeenCalledWith(
      'useLocalStoragePreference',
      'Failed to read localStorage preference',
      { key: 'test:throw-read' },
      expect.any(Error),
    )
    getItemSpy.mockRestore()
  })

  it('persists JSON-encoded value to localStorage on mount and on update', () => {
    let setter: ((next: number | ((prev: number) => number)) => void) | null = null
    render(
      <Harness
        storageKey="test:write"
        defaultValue={1}
        onState={(_v, s) => {
          setter = s
        }}
      />,
    )
    expect(localStorage.getItem('test:write')).toBe(JSON.stringify(1))

    act(() => {
      setter?.(99)
    })
    expect(localStorage.getItem('test:write')).toBe(JSON.stringify(99))
  })

  it('logs (and does not throw) when localStorage.setItem throws', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const warnSpy = vi.spyOn(logger, 'warn')
    expect(() => render(<Harness storageKey="test:write-throw" defaultValue="x" />)).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      'useLocalStoragePreference',
      'Failed to write localStorage preference',
      { key: 'test:write-throw' },
      expect.any(Error),
    )
    setItemSpy.mockRestore()
  })

  it('respects the source label in log messages', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('boom')
    })
    const warnSpy = vi.spyOn(logger, 'warn')
    render(
      <Harness
        storageKey="test:custom-source"
        defaultValue={0}
        options={{ source: 'MyComponent' }}
      />,
    )
    expect(warnSpy).toHaveBeenCalledWith(
      'MyComponent',
      'Failed to read localStorage preference',
      { key: 'test:custom-source' },
      expect.any(Error),
    )
    getItemSpy.mockRestore()
  })

  it('uses custom parse/serialize for legacy bare-string formats', () => {
    // Pre-existing on-disk format is the bare value, NOT JSON.
    localStorage.setItem('test:bare', 'date')
    let captured: string | null = null
    let setter: ((next: string | ((prev: string) => string)) => void) | null = null
    render(
      <Harness
        storageKey="test:bare"
        defaultValue="page"
        options={{
          parse: (raw) => {
            if (['date', 'page', 'state'].includes(raw)) return raw
            throw new Error('invalid')
          },
          serialize: (v) => v,
        }}
        onState={(v, s) => {
          captured = v
          setter = s
        }}
      />,
    )
    expect(captured).toBe('date')
    // Subsequent writes also use the bare format.
    act(() => {
      setter?.('state')
    })
    expect(localStorage.getItem('test:bare')).toBe('state')
  })

  it(
    'review-pre-existing useAgendaPreferences upgrade — bare-string ' +
      'value survives the migration without falling back to default',
    () => {
      // Regression test for the review concern: when a user's
      // existing localStorage holds the legacy bare-string format
      // (e.g. `agenda.sortBy = "date"` written before the migration to
      // useLocalStoragePreference), mounting the hook with the custom
      // parse/serialize from useAgendaPreferences MUST read the legacy
      // value as-is. Without this contract, every existing user's
      // preferences would silently revert to defaults on app upgrade.
      //
      // The exact storage keys + parse/serialize must mirror what
      // useAgendaPreferences uses today; if those drift, this test
      // intentionally fails to flag the breaking change.
      localStorage.setItem('agenda.sortBy', 'date') // legacy: bare, not JSON
      localStorage.setItem('agenda.groupBy', 'priority') // legacy: bare
      let sortByCaptured: string | null = null
      let groupByCaptured: string | null = null

      const allowedSorts = new Set(['date', 'priority', 'created'])
      const allowedGroups = new Set(['none', 'priority', 'status', 'tag'])

      render(
        <>
          <Harness
            storageKey="agenda.sortBy"
            defaultValue="date"
            options={{
              parse: (raw) => {
                if (allowedSorts.has(raw)) return raw
                throw new Error(`invalid sortBy: ${raw}`)
              },
              serialize: (v) => v,
            }}
            onState={(v) => {
              sortByCaptured = v
            }}
          />
          <Harness
            storageKey="agenda.groupBy"
            defaultValue="none"
            options={{
              parse: (raw) => {
                if (allowedGroups.has(raw)) return raw
                throw new Error(`invalid groupBy: ${raw}`)
              },
              serialize: (v) => v,
            }}
            onState={(v) => {
              groupByCaptured = v
            }}
          />
        </>,
      )

      // Both pre-existing legacy values are read as-is (NOT defaults).
      expect(sortByCaptured).toBe('date')
      expect(groupByCaptured).toBe('priority')
      // localStorage still holds the bare-string format (no JSON re-encoding).
      expect(localStorage.getItem('agenda.sortBy')).toBe('date')
      expect(localStorage.getItem('agenda.groupBy')).toBe('priority')
    },
  )

  it('falls back to default when custom parse throws', () => {
    localStorage.setItem('test:custom-bad', 'not-in-allowlist')
    let captured: string | null = null
    render(
      <Harness
        storageKey="test:custom-bad"
        defaultValue="default-value"
        options={{
          parse: (raw) => {
            if (['a', 'b'].includes(raw)) return raw
            throw new Error('invalid')
          },
          serialize: (v) => v,
        }}
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toBe('default-value')
  })

  // #3881 — `parse` only throws on genuinely invalid JSON; a well-formed
  // value of the WRONG shape (e.g. a stale schema, a hand-edited devtools
  // value) sails through unchecked unless the caller opts into `validate`.
  it('falls back to default when parse succeeds but validate rejects the shape (#3881)', () => {
    // Valid JSON, but `count` is a string where every consumer expects a
    // number — exactly the "well-formed JS, wrong shape" case `validate`
    // exists to catch.
    localStorage.setItem('test:validate-reject', JSON.stringify({ count: 'not-a-number' }))
    let captured: { count: number } | null = null
    render(
      <Harness
        storageKey="test:validate-reject"
        defaultValue={{ count: 0 }}
        options={{
          validate: (v) => typeof v.count === 'number',
        }}
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toEqual({ count: 0 })
  })

  it('uses the parsed value when validate confirms the shape', () => {
    localStorage.setItem('test:validate-accept', JSON.stringify({ count: 7 }))
    let captured: { count: number } | null = null
    render(
      <Harness
        storageKey="test:validate-accept"
        defaultValue={{ count: 0 }}
        options={{
          validate: (v) => typeof v.count === 'number',
        }}
        onState={(v) => {
          captured = v
        }}
      />,
    )
    expect(captured).toEqual({ count: 7 })
  })

  describe('cross-instance sync (#2666)', () => {
    it('a write in one instance updates another instance on the same key', () => {
      let capturedA: number | null = null
      let capturedB: number | null = null
      let setterA: ((next: number | ((prev: number) => number)) => void) | null = null
      render(
        <>
          <Harness
            storageKey="test:sync"
            defaultValue={0}
            onState={(v, s) => {
              capturedA = v
              setterA = s
            }}
          />
          <Harness
            storageKey="test:sync"
            defaultValue={0}
            onState={(v) => {
              capturedB = v
            }}
          />
        </>,
      )
      expect(capturedA).toBe(0)
      expect(capturedB).toBe(0)

      act(() => {
        setterA?.(7)
      })
      expect(capturedA).toBe(7)
      expect(capturedB).toBe(7)
      expect(localStorage.getItem('test:sync')).toBe(JSON.stringify(7))
    })

    it('instances on DIFFERENT keys do not cross-talk', () => {
      let capturedOther: string | null = null
      let setter: ((next: string | ((prev: string) => string)) => void) | null = null
      render(
        <>
          <Harness
            storageKey="test:key-a"
            defaultValue="a-default"
            onState={(_v, s) => {
              setter = s
            }}
          />
          <Harness
            storageKey="test:key-b"
            defaultValue="b-default"
            onState={(v) => {
              capturedOther = v
            }}
          />
        </>,
      )
      act(() => {
        setter?.('changed')
      })
      expect(capturedOther).toBe('b-default')
    })

    it('broadcasts a fully populated synthetic StorageEvent after the write', () => {
      localStorage.setItem('test:event-shape', JSON.stringify('before'))
      const events: StorageEvent[] = []
      const listener = (e: StorageEvent) => events.push(e)
      window.addEventListener('storage', listener)
      try {
        let setter: ((next: string | ((prev: string) => string)) => void) | null = null
        render(
          <Harness
            storageKey="test:event-shape"
            defaultValue="d"
            onState={(_v, s) => {
              setter = s
            }}
          />,
        )
        // The mount write-back is silent — only the explicit set broadcasts.
        expect(events).toHaveLength(0)
        act(() => {
          setter?.('after')
        })
        expect(events).toHaveLength(1)
        const e = events[0]
        if (!e) throw new Error('no StorageEvent dispatched')
        expect(e.key).toBe('test:event-shape')
        expect(e.oldValue).toBe(JSON.stringify('before'))
        expect(e.newValue).toBe(JSON.stringify('after'))
        expect(e.url).toBe(window.location.href)
        expect(e.storageArea).toBe(window.localStorage)
      } finally {
        window.removeEventListener('storage', listener)
      }
    })

    it('re-reads when another window writes (native storage event)', () => {
      let captured: number | null = null
      render(
        <Harness
          storageKey="test:cross-window"
          defaultValue={1}
          onState={(v) => {
            captured = v
          }}
        />,
      )
      expect(captured).toBe(1)

      // Simulate another window's write: the value lands in localStorage
      // first, then the browser delivers a storage event for the key.
      act(() => {
        localStorage.setItem('test:cross-window', JSON.stringify(42))
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'test:cross-window',
            oldValue: JSON.stringify(1),
            newValue: JSON.stringify(42),
            storageArea: window.localStorage,
          }),
        )
      })
      expect(captured).toBe(42)
    })

    it('keeps a referentially stable object snapshot across no-op broadcasts', () => {
      localStorage.setItem('test:stable-ref', JSON.stringify({ nested: true }))
      const seen: Array<{ nested: boolean }> = []
      render(
        <Harness
          storageKey="test:stable-ref"
          defaultValue={{ nested: false }}
          onState={(v) => {
            seen.push(v)
          }}
        />,
      )
      const initial = seen.at(-1)
      expect(initial).toEqual({ nested: true })

      // A broadcast whose raw value is unchanged must not produce a new
      // parsed reference (the snapshot is cached against the raw string).
      const raw = localStorage.getItem('test:stable-ref')
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'test:stable-ref',
            oldValue: raw,
            newValue: raw,
            storageArea: window.localStorage,
          }),
        )
      })
      expect(seen.at(-1)).toBe(initial)
    })

    it('a failed write degrades to in-memory for the caller only — no broadcast', () => {
      let capturedA: string | null = null
      let capturedB: string | null = null
      let setterA: ((next: string | ((prev: string) => string)) => void) | null = null
      render(
        <>
          <Harness
            storageKey="test:write-fail-sync"
            defaultValue="initial"
            onState={(v, s) => {
              capturedA = v
              setterA = s
            }}
          />
          <Harness
            storageKey="test:write-fail-sync"
            defaultValue="initial"
            onState={(v) => {
              capturedB = v
            }}
          />
        </>,
      )
      // Break writes AFTER mount (the mount write-back already ran).
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded')
      })
      const warnSpy = vi.spyOn(logger, 'warn')
      const events: StorageEvent[] = []
      const listener = (e: StorageEvent) => events.push(e)
      window.addEventListener('storage', listener)
      try {
        expect(() =>
          act(() => {
            setterA?.('unpersisted')
          }),
        ).not.toThrow()
        // Caller keeps the value in memory for the session (legacy
        // useState-based contract) …
        expect(capturedA).toBe('unpersisted')
        // … but nothing was persisted or broadcast for other instances.
        expect(capturedB).toBe('initial')
        expect(events).toHaveLength(0)
        expect(warnSpy).toHaveBeenCalledWith(
          'useLocalStoragePreference',
          'Failed to write localStorage preference',
          { key: 'test:write-fail-sync' },
          expect.any(Error),
        )
      } finally {
        window.removeEventListener('storage', listener)
        setItemSpy.mockRestore()
      }
    })

    // #4490 — the three points below pin the success-path clear added for
    // #4406. That clear is deliberately guarded on `failedWriteRef.current`
    // (a ref), not on `failedWrite` (the state it mirrors for render output).
    // A test that only checks "the value is correct after a successful
    // write" passes under EITHER guard, so it proves nothing about which one
    // is in place — these instead target the specific compositions that only
    // the ref guard gets right.

    it('a fail-then-succeed pair batched into one tick still clears the failed value', () => {
      // Discriminator: `setPreference` is memoized once and does not close
      // over `failedWrite`, so within a single tick its closed-over value is
      // whatever `failedWrite` was BEFORE this tick started (here: null).
      // Guarding the clear on that stale state would silently skip clearing
      // on the second (successful) call, stranding the first call's failed
      // value even though the pair together should leave nothing failed.
      // Guarding on the ref (which the first call updates synchronously,
      // within the same tick) clears correctly. This test goes red if the
      // guard is switched from the ref to the state.
      let captured: string | null = null
      let setter: ((next: string | ((prev: string) => string)) => void) | null = null
      render(
        <Harness
          storageKey="test:batched-fail-then-succeed"
          defaultValue="initial"
          onState={(v, s) => {
            captured = v
            setter = s
          }}
        />,
      )
      expect(captured).toBe('initial')

      // First setItem call (the first setPreference below) throws; every
      // call after that falls through to the real implementation.
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new Error('quota exceeded')
      })
      try {
        act(() => {
          setter?.('rejected')
          setter?.('accepted')
        })
        expect(captured).toBe('accepted')
        expect(localStorage.getItem('test:batched-fail-then-succeed')).toBe(
          JSON.stringify('accepted'),
        )
      } finally {
        setItemSpy.mockRestore()
      }
    })

    it('does not fire a redundant setState on a successful write when there was no prior failure', () => {
      let captured: string | null = null
      let setter: ((next: string | ((prev: string) => string)) => void) | null = null
      render(
        <Harness
          storageKey="test:no-redundant-clear"
          defaultValue="initial"
          onState={(v, s) => {
            captured = v
            setter = s
          }}
        />,
      )
      expect(failedWriteSetterSpies.size).toBe(1)
      const failedWriteSetterSpy = [...failedWriteSetterSpies.values()][0]
      expect(failedWriteSetterSpy).toHaveBeenCalledTimes(0)

      act(() => {
        setter?.('updated')
      })
      expect(captured).toBe('updated')
      expect(failedWriteSetterSpy).toHaveBeenCalledTimes(0)
    })

    it('a successful write of the value already in storage clears a stale failed value (latent re-render fix)', () => {
      // Previously the success path only cleared the ref, so `getSnapshot()`
      // returned an unchanged snapshot (same value already in storage) and
      // `useSyncExternalStore` had no reason to re-render — the UI kept
      // showing the stale failed value forever. `setFailedWrite(null)` is
      // what forces the re-render here; the store snapshot alone does not.
      let captured: string | null = null
      let setter: ((next: string | ((prev: string) => string)) => void) | null = null
      render(
        <Harness
          storageKey="test:rerender-fix"
          defaultValue="stored-value"
          onState={(v, s) => {
            captured = v
            setter = s
          }}
        />,
      )
      expect(captured).toBe('stored-value')
      expect(localStorage.getItem('test:rerender-fix')).toBe(JSON.stringify('stored-value'))

      // Positive control for the spy wiring itself (see the no-redundant-
      // clear test's 0-calls assertion above, which this complements): show
      // the SAME spy fires on both the failure-set and the success-clear, so
      // a 0-calls assertion elsewhere is actually discriminating something
      // rather than passing because the spy never fires at all.
      expect(failedWriteSetterSpies.size).toBe(1)
      const failedWriteSetterSpy = [...failedWriteSetterSpies.values()][0]

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new Error('quota exceeded')
      })
      try {
        act(() => {
          setter?.('rejected')
        })
        expect(captured).toBe('rejected')
      } finally {
        setItemSpy.mockRestore()
      }
      expect(failedWriteSetterSpy).toHaveBeenNthCalledWith(1, {
        key: 'test:rerender-fix',
        value: 'rejected',
      })

      // The value being written back is exactly what's already persisted —
      // the raw stored string does not change — but the failed value must
      // still clear.
      act(() => {
        setter?.('stored-value')
      })
      expect(captured).toBe('stored-value')
      expect(failedWriteSetterSpy).toHaveBeenNthCalledWith(2, null)
      expect(failedWriteSetterSpy).toHaveBeenCalledTimes(2)
    })
  })

  it('supports updater function form (prev → next)', () => {
    let captured: number | null = null
    let setter: ((next: number | ((prev: number) => number)) => void) | null = null
    render(
      <Harness
        storageKey="test:updater"
        defaultValue={10}
        onState={(v, s) => {
          captured = v
          setter = s
        }}
      />,
    )
    expect(captured).toBe(10)
    act(() => {
      setter?.((prev) => prev + 5)
    })
    expect(captured).toBe(15)
    expect(localStorage.getItem('test:updater')).toBe(JSON.stringify(15))
  })
})
