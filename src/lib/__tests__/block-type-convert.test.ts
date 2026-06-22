/**
 * Tests for `block-type-convert` (#264) — the shared markdown block-type
 * conversion used by both the `/turn` slash command and the context-menu
 * "Turn into" group.
 */

import { describe, expect, it } from 'vitest'

import {
  convertBlockContent,
  detectBlockType,
  stripBlockMarker,
  turnIdToBlockType,
} from '../block-type-convert'

describe('stripBlockMarker', () => {
  it('strips heading, quote, callout, ordered and bullet markers', () => {
    expect(stripBlockMarker('# heading')).toBe('heading')
    expect(stripBlockMarker('### h3')).toBe('h3')
    expect(stripBlockMarker('> quote')).toBe('quote')
    expect(stripBlockMarker('> [!INFO] note')).toBe('note')
    expect(stripBlockMarker('1. item')).toBe('item')
    expect(stripBlockMarker('- bullet')).toBe('bullet')
  })

  it('leaves plain text untouched (idempotent)', () => {
    expect(stripBlockMarker('plain text')).toBe('plain text')
    expect(stripBlockMarker(stripBlockMarker('## twice'))).toBe('twice')
  })
})

describe('detectBlockType', () => {
  it.each([
    ['plain', 'paragraph'],
    ['# h1', 'h1'],
    ['## h2', 'h2'],
    ['### h3', 'h3'],
    ['> a quote', 'quote'],
    ['> [!WARNING] careful', 'callout'],
    ['1. first', 'numbered-list'],
    ['- a bullet', 'bullet-list'],
    ['* a bullet', 'bullet-list'],
    ['+ a bullet', 'bullet-list'],
    // `---` (divider) must NOT be read as a bullet — BULLET_RE requires a space.
    ['---', 'paragraph'],
    ['```\ncode\n```', 'code'],
  ])('detects %j as %s', (content, expected) => {
    expect(detectBlockType(content)).toBe(expected)
  })

  it('falls back to paragraph for empty content', () => {
    expect(detectBlockType('')).toBe('paragraph')
  })
})

describe('convertBlockContent', () => {
  it('converts a paragraph to each heading level', () => {
    expect(convertBlockContent('text', 'h1')).toBe('# text')
    expect(convertBlockContent('text', 'h3')).toBe('### text')
  })

  it('round-trips between types by stripping the prior marker first', () => {
    // h1 -> quote should not leave the hash behind
    expect(convertBlockContent('# title', 'quote')).toBe('> title')
    // quote -> paragraph removes the marker
    expect(convertBlockContent('> said', 'paragraph')).toBe('said')
    // callout -> h2
    expect(convertBlockContent('> [!INFO] hi', 'h2')).toBe('## hi')
  })

  it('converts to a numbered list and an info callout', () => {
    expect(convertBlockContent('do this', 'numbered-list')).toBe('1. do this')
    expect(convertBlockContent('heads up', 'callout')).toBe('> [!INFO] heads up')
  })

  it('converts to a bullet list and round-trips off it', () => {
    expect(convertBlockContent('do this', 'bullet-list')).toBe('- do this')
    // bullet → numbered strips the `- ` marker first
    expect(convertBlockContent('- do this', 'numbered-list')).toBe('1. do this')
    expect(convertBlockContent('- do this', 'paragraph')).toBe('do this')
  })

  it('wraps content in a fenced code block', () => {
    expect(convertBlockContent('const x = 1', 'code')).toBe('```\nconst x = 1\n```')
  })

  it('unwraps a fenced code block when converting back to paragraph', () => {
    expect(convertBlockContent('```\nconst x = 1\n```', 'paragraph')).toBe('const x = 1')
  })
})

describe('turnIdToBlockType', () => {
  it('maps valid turn- ids to block-type tokens', () => {
    expect(turnIdToBlockType('turn-paragraph')).toBe('paragraph')
    expect(turnIdToBlockType('turn-h2')).toBe('h2')
    expect(turnIdToBlockType('turn-numbered-list')).toBe('numbered-list')
    expect(turnIdToBlockType('turn-bullet-list')).toBe('bullet-list')
    expect(turnIdToBlockType('turn-callout')).toBe('callout')
  })

  it('returns null for non-turn or unknown ids', () => {
    expect(turnIdToBlockType('h1')).toBeNull()
    expect(turnIdToBlockType('turn-bogus')).toBeNull()
  })
})
