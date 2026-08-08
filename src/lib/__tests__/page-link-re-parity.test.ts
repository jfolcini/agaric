import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HUMAN_MULTIWORD_TAG_RE,
  HUMAN_PAGE_LINK_RE,
  humanizeRefTokens,
  internalizeRefTokens,
} from '@/lib/block-clipboard'

interface ReferenceTokenExpected {
  pageCaptures: string[]
  multiwordTagCaptures: string[]
  requestedPageNames: string[]
  requestedTagNames: string[]
  transformed: string
}

interface ReferenceTokenCase {
  name: string
  input: string
  expected: ReferenceTokenExpected
}

interface HumanizeTagCase {
  name: string
  tagUlid: string
  tagName: string
  expected: string
}

interface ReferenceTokenVectors {
  pageResolutions: Record<string, string>
  tagResolutions: Record<string, string>
  humanizeCases: HumanizeTagCase[]
  cases: ReferenceTokenCase[]
}

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'conformance',
  'reference-tokens.vectors.json',
)
const vectors = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ReferenceTokenVectors

/**
 * #1920/#3261 — cross-language parity for inbound reference-token grammar.
 *
 * Rust owns the canonical regex/collector/rewriter implementation in
 * `src-tauri/src/commands/pages/markdown.rs`. This suite and the Rust
 * `page_link_re_parity_boundaries_1920` test consume the same golden vectors,
 * including the prefix-sensitive distinction between pages, tags, and embeds.
 */
describe('reference-token cross-language parity (#1920, #3261)', () => {
  for (const vector of vectors.humanizeCases) {
    it(vector.name, () => {
      const transformed = humanizeRefTokens(`#[${vector.tagUlid}]`, (ulid) =>
        ulid === vector.tagUlid ? vector.tagName : undefined,
      )
      expect(transformed).toBe(vector.expected)
    })
  }

  for (const vector of vectors.cases) {
    it(vector.name, async () => {
      expect([...vector.input.matchAll(HUMAN_PAGE_LINK_RE)].map((match) => match[1])).toEqual(
        vector.expected.pageCaptures,
      )
      expect([...vector.input.matchAll(HUMAN_MULTIWORD_TAG_RE)].map((match) => match[1])).toEqual(
        vector.expected.multiwordTagCaptures,
      )

      const requestedPageNames: string[] = []
      const requestedTagNames: string[] = []
      const transformed = await internalizeRefTokens(vector.input, {
        page: async (name) => {
          requestedPageNames.push(name)
          return vectors.pageResolutions[name] ?? null
        },
        tag: async (name) => {
          requestedTagNames.push(name)
          return vectors.tagResolutions[name] ?? null
        },
      })

      expect(requestedPageNames).toEqual(vector.expected.requestedPageNames)
      expect(requestedTagNames).toEqual(vector.expected.requestedTagNames)
      expect(transformed).toBe(vector.expected.transformed)
    })
  }
})
