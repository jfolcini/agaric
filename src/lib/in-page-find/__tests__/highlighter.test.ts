/**
 * Tests for the in-page-find highlighter — the half that actually RENDERS
 * results onto the page via the CSS Custom Highlight Registry (`CSS.highlights`).
 *
 * `happy-dom` exposes a `CSS` object but no `CSS.highlights` and no `Highlight`
 * constructor, so by default `isSupported()` is false and every render function
 * no-ops. These tests STUB both primitives with minimal fakes (a Map-backed
 * registry and a constructor that just collects the ranges added to it) so the
 * supported branch — building `Highlight`s, registering `find-match` /
 * `find-match-current`, and clearing them — is exercised and its outputs
 * asserted exactly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clear, isSupported, paint } from '@/lib/in-page-find/highlighter'
import type { FindMatch } from '@/lib/in-page-find/matcher'

const HIGHLIGHT_ALL = 'find-match'
const HIGHLIGHT_CURRENT = 'find-match-current'

/** Minimal `Highlight` stand-in: records the `Range`s added to it. */
class FakeHighlight {
  ranges: Range[] = []
  add(range: Range): void {
    this.ranges.push(range)
  }
  clear(): void {
    this.ranges = []
  }
  get size(): number {
    return this.ranges.length
  }
}

type Registry = Map<string, FakeHighlight>

interface Globals {
  CSS?: { highlights?: Registry }
  Highlight?: typeof FakeHighlight
}

let registry: Registry
let attachedHosts: HTMLElement[] = []

beforeEach(() => {
  registry = new Map()
  const g = globalThis as unknown as Globals
  // happy-dom provides `CSS` (an object) but not `.highlights`; assign a fake.
  g.CSS = { ...g.CSS, highlights: registry }
  g.Highlight = FakeHighlight
  attachedHosts = []
})

afterEach(() => {
  const g = globalThis as unknown as Globals
  if (g.CSS) delete g.CSS.highlights
  delete g.Highlight
  for (const el of attachedHosts) el.remove()
  attachedHosts = []
})

/** Build a host with `text` and return a FindMatch spanning [start,end). */
function matchFor(text: string, start: number, end: number): FindMatch {
  const host = document.createElement('div')
  host.textContent = text
  document.body.append(host)
  attachedHosts.push(host)
  return { node: host.firstChild as Text, start, end }
}

describe('highlighter — isSupported (stubbed registry)', () => {
  it('reports supported once CSS.highlights and Highlight are present', () => {
    expect(isSupported()).toBe(true)
  })
})

describe('highlighter — paint renders match ranges', () => {
  it('registers every match into the `find-match` highlight with correct ranges', () => {
    const m1 = matchFor('hello world', 0, 5) // "hello"
    const m2 = matchFor('hello world', 6, 11) // "world"

    paint([m1, m2], -1) // no current index → only the all-matches highlight

    const all = registry.get(HIGHLIGHT_ALL)
    expect(all).toBeInstanceOf(FakeHighlight)
    expect(all?.ranges).toHaveLength(2)
    expect(all?.ranges.map((r) => r.toString())).toEqual(['hello', 'world'])
    // No current index → the current highlight must be absent from the registry.
    expect(registry.has(HIGHLIGHT_CURRENT)).toBe(false)
  })

  it('routes the current match into `find-match-current` and the rest into `find-match`', () => {
    const m0 = matchFor('alpha', 0, 5)
    const m1 = matchFor('bravo', 0, 5)
    const m2 = matchFor('gamma', 0, 5)

    paint([m0, m1, m2], 1) // current index = 1 (bravo)

    const all = registry.get(HIGHLIGHT_ALL)
    const current = registry.get(HIGHLIGHT_CURRENT)
    expect(all?.ranges.map((r) => r.toString())).toEqual(['alpha', 'gamma'])
    expect(current?.ranges.map((r) => r.toString())).toEqual(['bravo'])
  })

  it('re-painting replaces the previous highlight set (no accumulation)', () => {
    paint([matchFor('first', 0, 5)], 0)
    expect(registry.get(HIGHLIGHT_ALL)?.size).toBe(0) // single match was the current one
    expect(registry.get(HIGHLIGHT_CURRENT)?.size).toBe(1)

    // Re-paint with a different, larger set and no current index. The registry
    // must reflect ONLY the new set, and the stale current highlight must be
    // deleted (currentIndex < 0 → registry.delete(find-match-current)).
    paint([matchFor('a', 0, 1), matchFor('b', 0, 1)], -1)
    expect(registry.get(HIGHLIGHT_ALL)?.size).toBe(2)
    expect(registry.has(HIGHLIGHT_CURRENT)).toBe(false)
  })

  it('paint([], -1) clears to an empty all-highlight and removes the current one', () => {
    paint([matchFor('x', 0, 1)], 0)
    expect(registry.get(HIGHLIGHT_CURRENT)?.size).toBe(1)

    paint([], -1)
    expect(registry.get(HIGHLIGHT_ALL)?.size).toBe(0)
    expect(registry.has(HIGHLIGHT_CURRENT)).toBe(false)
  })

  it('injects the highlight styles into <head> exactly once across paints', () => {
    paint([matchFor('x', 0, 1)], -1)
    paint([matchFor('y', 0, 1)], -1)
    const styles = document.head.querySelectorAll('style[data-in-page-find]')
    expect(styles).toHaveLength(1)
  })
})

describe('highlighter — clear', () => {
  it('removes both named highlights from the registry', () => {
    paint([matchFor('one', 0, 3)], 0)
    expect(registry.has(HIGHLIGHT_ALL)).toBe(true)
    expect(registry.has(HIGHLIGHT_CURRENT)).toBe(true)

    clear()

    expect(registry.has(HIGHLIGHT_ALL)).toBe(false)
    expect(registry.has(HIGHLIGHT_CURRENT)).toBe(false)
  })
})

describe('highlighter — graceful no-op when unsupported', () => {
  it('paint and clear do nothing when CSS.highlights is absent', () => {
    const g = globalThis as unknown as Globals
    if (g.CSS) delete g.CSS.highlights
    delete g.Highlight
    expect(isSupported()).toBe(false)

    // Neither call should throw, and the (now-undefined) registry stays untouched.
    expect(() => paint([matchFor('z', 0, 1)], 0)).not.toThrow()
    expect(() => clear()).not.toThrow()
    expect(registry.size).toBe(0)
  })
})
