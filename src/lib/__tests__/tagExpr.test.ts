/**
 * Unit tests for the single-level tag-query builder (#1426).
 *
 * The builder is deliberately constrained to exactly what the flat
 * `query_by_tags` IPC can execute (tag/prefix leaves under one All/Any/None
 * combinator). These tests assert the COMPILED params — the literal payload the
 * IPC will run — so what the builder produces is faithfully executed, never
 * silently flattened.
 */

import { describe, expect, it } from 'vitest'

import {
  type TagBuilder,
  addLeaf,
  compileTagBuilder,
  emptyTagBuilder,
  makePrefixLeaf,
  makeTagLeaf,
  removeLeaf,
  setMode,
  tagBuilderHasLeaves,
} from '@/lib/tagExpr'

describe('compileTagBuilder', () => {
  it('compiles an empty builder to empty flat params (default and)', () => {
    expect(compileTagBuilder(emptyTagBuilder())).toEqual({
      tagIds: [],
      prefixes: [],
      mode: 'and',
    })
  })

  it('compiles a tag leaf into tagIds', () => {
    const b = addLeaf(emptyTagBuilder(), makeTagLeaf('T1', 'work'))
    expect(compileTagBuilder(b)).toEqual({ tagIds: ['T1'], prefixes: [], mode: 'and' })
  })

  it('compiles a prefix leaf into prefixes', () => {
    const b = addLeaf(emptyTagBuilder(), makePrefixLeaf('proj'))
    expect(compileTagBuilder(b)).toEqual({ tagIds: [], prefixes: ['proj'], mode: 'and' })
  })

  it('intermixes tag + prefix leaves under the Any (or) combinator', () => {
    let b: TagBuilder = setMode(emptyTagBuilder(), 'or')
    b = addLeaf(b, makeTagLeaf('T1', 'work'))
    b = addLeaf(b, makePrefixLeaf('proj'))
    expect(compileTagBuilder(b)).toEqual({ tagIds: ['T1'], prefixes: ['proj'], mode: 'or' })
  })

  it('compiles the None combinator to mode "not"', () => {
    let b = addLeaf(emptyTagBuilder(), makeTagLeaf('T1', 'work'))
    b = setMode(b, 'not')
    expect(compileTagBuilder(b)).toEqual({ tagIds: ['T1'], prefixes: [], mode: 'not' })
  })

  it('preserves leaf order across tags and prefixes', () => {
    let b = addLeaf(emptyTagBuilder(), makeTagLeaf('T1', 'a'))
    b = addLeaf(b, makeTagLeaf('T2', 'b'))
    b = addLeaf(b, makePrefixLeaf('p1'))
    expect(compileTagBuilder(b)).toEqual({ tagIds: ['T1', 'T2'], prefixes: ['p1'], mode: 'and' })
  })
})

describe('immutable updates', () => {
  it('removeLeaf drops the leaf by id without mutating the original', () => {
    let b = addLeaf(emptyTagBuilder(), makeTagLeaf('T1', 'a'))
    const t2 = makeTagLeaf('T2', 'b')
    b = addLeaf(b, t2)
    const next = removeLeaf(b, t2.id)
    expect(compileTagBuilder(next)).toEqual({ tagIds: ['T1'], prefixes: [], mode: 'and' })
    expect(b.leaves).toHaveLength(2) // original untouched
  })

  it('setMode changes the combinator immutably', () => {
    const b = emptyTagBuilder()
    const next = setMode(b, 'or')
    expect(next.mode).toBe('or')
    expect(b.mode).toBe('and') // original untouched
  })
})

describe('tagBuilderHasLeaves', () => {
  it('is false for an empty builder', () => {
    expect(tagBuilderHasLeaves(emptyTagBuilder())).toBe(false)
  })

  it('is true once any leaf is added', () => {
    const b = addLeaf(emptyTagBuilder(), makePrefixLeaf('x'))
    expect(tagBuilderHasLeaves(b)).toBe(true)
  })
})
