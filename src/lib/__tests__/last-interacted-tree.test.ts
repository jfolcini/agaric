/**
 * #774 — last-interacted BlockTree registry unit tests.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetLastInteractedTreeForTests,
  clearTreeInteractionIfHolder,
  isLastInteractedTree,
  markTreeInteracted,
} from '../last-interacted-tree'

beforeEach(() => {
  __resetLastInteractedTreeForTests()
})

describe('last-interacted-tree registry', () => {
  it('fail-open: every tree is "last-interacted" when none has registered yet', () => {
    const a = {}
    const b = {}
    expect(isLastInteractedTree(a)).toBe(true)
    expect(isLastInteractedTree(b)).toBe(true)
  })

  it('only the most-recently-marked tree is last-interacted', () => {
    const a = {}
    const b = {}
    markTreeInteracted(a)
    expect(isLastInteractedTree(a)).toBe(true)
    expect(isLastInteractedTree(b)).toBe(false)

    markTreeInteracted(b)
    expect(isLastInteractedTree(b)).toBe(true)
    expect(isLastInteractedTree(a)).toBe(false)
  })

  it('clearing the holder fails open again (lone tree still handles Escape)', () => {
    const a = {}
    const b = {}
    markTreeInteracted(a)
    clearTreeInteractionIfHolder(a)
    // No holder → fail-open: both are considered last-interacted.
    expect(isLastInteractedTree(a)).toBe(true)
    expect(isLastInteractedTree(b)).toBe(true)
  })

  it('clearing a NON-holder does not change the holder', () => {
    const a = {}
    const b = {}
    markTreeInteracted(a)
    clearTreeInteractionIfHolder(b) // b is not the holder
    expect(isLastInteractedTree(a)).toBe(true)
    expect(isLastInteractedTree(b)).toBe(false)
  })
})
