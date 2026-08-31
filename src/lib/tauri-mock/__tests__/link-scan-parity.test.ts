/**
 * #3332 — the `[[ULID]]` link scan has ONE owner.
 *
 * The mock has no materialized `block_links` table, so every link-serving
 * surface derives edges live from block content. That scan used to be written
 * out eight times: once in `deriveLinkEdges`, six times inline across
 * `handlers/links.ts`, and once — the load-bearing one — inside the conformance
 * snapshot builder. Because the Rust side of that comparison reads the REAL
 * `block_links` table, a private copy in the snapshot builder meant the
 * `page_links` assertion checked the test file's own regex rather than the code
 * the mock runs: change the link semantics, update the helper and the snapshot
 * copy, and both snapshots agree while all six backlink/graph handlers keep
 * serving the old semantics to every Playwright spec. Nothing failed.
 *
 * Two pins, because either alone is escapable:
 *
 *   1. STRUCTURAL — the token regex appears in exactly one source file. A new
 *      inline copy re-opens the hole no behavioural test can see.
 *   2. BEHAVIOURAL — the link-serving handlers agree, edge for edge, with
 *      `deriveLinkEdges` (the function the conformance snapshot now consumes).
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { deriveLinkEdges } from '@/lib/tauri-mock/link-scan'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const MOCK_DIR = path.resolve(import.meta.dirname, '..')

/** Every `.ts` file under `src/lib/tauri-mock/`, recursively. */
function mockSourceFiles(dir: string = MOCK_DIR): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...mockSourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('#3332 — the [[ULID]] link scan has a single owner', () => {
  it('declares the token regex in exactly one file', () => {
    // The literal, however it is spelled: `[[` + a 26-char Crockford-base32
    // capture + `]]`. Matching the SOURCE TEXT is the point — this is a
    // duplication guard, not a behaviour check.
    const declRe = /\\\[\\\[\(\[0-9A-Z\]\{26\}\)\\\]\\\]/
    const owners = mockSourceFiles()
      .filter((f) => declRe.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(MOCK_DIR, f))
      .toSorted()

    expect(
      owners,
      `The [[ULID]] link-token regex must be declared only in link-scan.ts (its ` +
        `single owner). Found it in: ${JSON.stringify(owners)}. Import ` +
        `scanLinkTargets / contentLinksTo / deriveLinkEdges instead of ` +
        `re-declaring the grammar — a private copy silently forks the link ` +
        `semantics away from the conformance snapshot.`,
    ).toEqual(['link-scan.ts'])
  })

  describe('handlers agree with deriveLinkEdges', () => {
    // 26-char Crockford-base32 ids, the only shape the token grammar accepts.
    const PAGE_A = 'PAGEA'.padStart(26, '0')
    const PAGE_B = 'PAGEB'.padStart(26, '0')
    const A1 = 'AA1'.padStart(26, '0')
    const A2 = 'AA2'.padStart(26, '0')
    const B1 = 'BB1'.padStart(26, '0')
    const GONE = 'GONE'.padStart(26, '0')

    beforeEach(() => {
      blocks.clear()
      properties.clear()
      blockTags.clear()
      propertyDefs.clear()
      opLog.length = 0

      blocks.set(PAGE_A, makeBlock(PAGE_A, 'page', 'Page A', null, 1))
      blocks.set(PAGE_B, makeBlock(PAGE_B, 'page', 'Page B', null, 2))
      // Two blocks on A linking to B, one of them twice; one block on B linking
      // back to A; one tombstoned block whose link must never surface.
      blocks.set(A1, makeBlock(A1, 'content', `see [[${PAGE_B}]] and [[${PAGE_B}]]`, PAGE_A, 1))
      blocks.set(A2, makeBlock(A2, 'content', `also [[${PAGE_B}]]`, PAGE_A, 2))
      blocks.set(B1, makeBlock(B1, 'content', `back to [[${PAGE_A}]]`, PAGE_B, 1))
      const gone = makeBlock(GONE, 'content', `dead [[${PAGE_B}]]`, PAGE_A, 3)
      gone['deleted_at'] = '2025-01-01T00:00:00.000Z'
      blocks.set(GONE, gone)
    })

    /** Source block ids the shared derivation says link to `targetId`. */
    function expectedSources(targetId: string): string[] {
      return [
        ...new Set(
          deriveLinkEdges(blocks)
            .filter((e) => e.targetId === targetId)
            .map((e) => e.sourceId),
        ),
      ].toSorted()
    }

    it('get_backlinks', () => {
      const res = dispatch('get_backlinks', { blockId: PAGE_B }) as {
        items: Array<Record<string, unknown>>
      }
      expect(res.items.map((b) => b['id'] as string).toSorted()).toEqual(expectedSources(PAGE_B))
      // Not vacuous: the tombstoned source is excluded, the live ones are not.
      expect(expectedSources(PAGE_B)).toEqual([A1, A2].toSorted())
    })

    it('list_backlinks_grouped', () => {
      const res = dispatch('list_backlinks_grouped', { blockId: PAGE_A }) as {
        groups: Array<{ blocks: Array<Record<string, unknown>> }>
      }
      const ids = res.groups.flatMap((g) => g.blocks.map((b) => b['id'] as string)).toSorted()
      expect(ids).toEqual(expectedSources(PAGE_A))
    })

    it('count_backlinks_batch', () => {
      const res = dispatch('count_backlinks_batch', { pageIds: [PAGE_A, PAGE_B] }) as Record<
        string,
        number
      >
      // The count is DISTINCT source blocks, so A1's two tokens count once.
      expect(res[PAGE_A]).toBe(expectedSources(PAGE_A).length)
      expect(res[PAGE_B]).toBe(expectedSources(PAGE_B).length)
    })

    // #4551 — a `((ULID))` block-ref token must derive a backlink edge exactly
    // like a `[[ULID]]` page-link token: the real `block_links` reindexer
    // (`reindex_block_links_conn`) scans BOTH delimiters via `ULID_LINK_RE`.
    // Before widening `scanLinkTargets`/`contentLinksTo` to match, the mock's
    // `[[ULID]]`-only scan derived no edge for this block, so the app fix
    // #4551 shipped could not be exercised end-to-end under Playwright.
    it('a ((ULID)) block-ref token also derives a backlink edge', () => {
      const BREF = 'BREF'.padStart(26, '0')
      blocks.set(BREF, makeBlock(BREF, 'content', `see ((${PAGE_B})) for detail`, PAGE_A, 4))

      const res = dispatch('get_backlinks', { blockId: PAGE_B }) as {
        items: Array<Record<string, unknown>>
      }
      expect(res.items.map((b) => b['id'] as string).toSorted()).toEqual(expectedSources(PAGE_B))
      // Not vacuous: the (( ))-only source joins the pre-existing [[ ]] ones.
      expect(expectedSources(PAGE_B)).toEqual([A1, A2, BREF].toSorted())
    })
  })
})
