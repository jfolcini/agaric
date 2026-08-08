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

/**
 * #3599 — a MECHANISM-level parity vector. The `cases` corpus hands each side a
 * block whose code-ness the fixture declares; these feed raw text to each
 * side's real code-protection mechanism instead (Rust's line-oriented
 * `parse_logseq_markdown`, this side's per-content `fencedCodeSpans`) and
 * compare the SET of tag names the resolver is asked to create.
 */
interface CodeFenceCase {
  name: string
  input: string
  requestedTagNames: string[]
}

interface ReferenceTokenVectors {
  pageResolutions: Record<string, string>
  tagResolutions: Record<string, string>
  humanizeCases: HumanizeTagCase[]
  codeFenceCases: CodeFenceCase[]
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

  for (const vector of vectors.codeFenceCases) {
    it(`code fence: ${vector.name}`, async () => {
      const requestedTagNames: string[] = []
      await internalizeRefTokens(vector.input, {
        page: async (name) => vectors.pageResolutions[name] ?? null,
        tag: async (name) => {
          requestedTagNames.push(name)
          return vectors.tagResolutions[name] ?? null
        },
      })
      // Same set-plus-count contract as below: the count still catches a
      // duplicate create-if-missing round trip.
      expect(requestedTagNames).toHaveLength(vector.requestedTagNames.length)
      expect(new Set(requestedTagNames)).toEqual(new Set(vector.requestedTagNames))
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

      // Rust collects through BTreeSet (sorted); TypeScript resolves in first-
      // occurrence order. The contract is the same distinct name set, not an
      // incidental resolver call order.
      expect(requestedPageNames).toHaveLength(vector.expected.requestedPageNames.length)
      expect(new Set(requestedPageNames)).toEqual(new Set(vector.expected.requestedPageNames))
      expect(requestedTagNames).toHaveLength(vector.expected.requestedTagNames.length)
      expect(new Set(requestedTagNames)).toEqual(new Set(vector.expected.requestedTagNames))
      expect(transformed).toBe(vector.expected.transformed)
    })
  }
})
