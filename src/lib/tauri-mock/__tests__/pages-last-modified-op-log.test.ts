/**
 * `list_pages_with_metadata` — `last_modified_at` comes from the op-log and
 * from nowhere else (#3884 + #3898).
 *
 * ## What this file guards
 *
 * The backend has exactly ONE last-edited source. The column
 * `list_pages_with_metadata_inner` selects is the bare
 *
 *     (SELECT MAX(created_at) FROM op_log WHERE block_id = b.id) AS last_modified_at
 *
 * (`src-tauri/src/commands/pages/metadata.rs:778`) — no COALESCE, no
 * materialised stamp, no seed table. The two consumers each apply their own
 * epoch-sentinel rule to that value for COMPARISON only:
 *
 *  - the `RecentlyModified` keyset — `COALESCE(<that subquery>, ?{S})` with
 *    `LAST_MOD_NULL_SENTINEL = 0` (`metadata.rs:220,349-351`), so op-log-free
 *    rows tie at the bottom and fall to the id tiebreak;
 *  - `compile_last_edited` (`agaric-store/src/filters/primitive.rs`) — the
 *    same COALESCE, giving the documented "no op-log ⇒ epoch" rule (Rolling
 *    EXCLUDES, OlderThan INCLUDES, Range EXCLUDES).
 *
 * The mock used to satisfy its fixtures with a `pageLastModified` map that
 * `pageLastModifiedAt` layered on top of the op-log scan. That made BOTH of
 * the above diverge — the sort keyset (#3884) and the filter predicate
 * (#3898) — from one root cause. The fix was NOT to special-case either
 * consumer: the seed now writes real `op_log` rows (`stampPageLastEdited`,
 * `seed.ts`) so `MAX(op_log.created_at)` genuinely IS each fixture page's
 * intended last-edited time, and the map plus the fallback are deleted.
 *
 * ## Why the assertions are shaped the way they are
 *
 * MOST tests here mutate `opLog` and then demand the observable answer move
 * with it. That is the only shape that can tell "reads the op-log" apart from
 * "reads something that currently agrees with the op-log": as seeded, the
 * deleted fallback and the op-log rows carry the SAME timestamps, so any
 * assertion over the pristine seed alone passes under both implementations
 * and pins nothing about the source. Removing a page's op-log rows is the one
 * mutation the two hypotheses answer differently (op-log ⇒ null/sentinel;
 * fallback ⇒ the seeded stamp survives), so it is the mutation most tests
 * below use.
 *
 * Four tests do NOT mutate `opLog` and are not `stripOpLogFor` detectors:
 * "writes one op_log row per canonical page", "the IPC row's lastModifiedAt
 * is exactly MAX(op_log.created_at)", "splits the seed the way the fixtures
 * claim", and "orders the bulk pages newest-first". These instead pin the
 * SEED's own data shape directly (one real op_log row per canonical page at
 * the right age, the fixture split the later filter/sort tests assume, and
 * the bulk pages' relative order) — necessary preconditions for the
 * mutation-based tests to mean what they claim, but not themselves
 * mutate-and-observe.
 *
 * Both arms of the command are covered, because they were both divergent and
 * a fix to one does not imply the other: `stripsOpLog → filter` (#3898) and
 * `stripsOpLog → sort` (#3884).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  opLog,
  SEED_IDS,
  seedBlocks,
  stampPageLastEdited,
  todayDate,
} from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_PERSONAL'

/** The six canonical seed pages, in the order `seedBlocks` stamps them. */
const CANONICAL_PAGE_IDS = [
  SEED_IDS.PAGE_GETTING_STARTED,
  SEED_IDS.PAGE_QUICK_NOTES,
  SEED_IDS.PAGE_DAILY,
  SEED_IDS.PAGE_PROJECTS,
  SEED_IDS.PAGE_MEETINGS,
  SEED_IDS.PAGE_TMPL_MEETING,
] as const

interface MetaRow {
  id: string
  content: string | null
  lastModifiedAt: string | null
}
interface MetaPage {
  items: MetaRow[]
  total_count: number | null
}

function listPages(filters: Array<Record<string, unknown>> = [], sort = 'alphabetical'): MetaPage {
  return dispatch('list_pages_with_metadata', {
    filter: { spaceId: SPACE, sort, filters },
    cursor: null,
    limit: 200,
  }) as MetaPage
}

const titlesOf = (p: MetaPage): string[] => p.items.map((r) => r.content ?? '')

/** ISO timestamp `days` in the past (negative offsets are the past). */
function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

/**
 * Delete every `op_log` row targeting `blockId` — i.e. make
 * `MAX(op_log.created_at)` NULL for it, the state a page that has never been
 * touched is in on a real database.
 */
function stripOpLogFor(blockId: string): void {
  for (let i = opLog.length - 1; i >= 0; i--) {
    const entry = opLog[i]
    if (!entry) continue
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(entry.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (payload['block_id'] === blockId) opLog.splice(i, 1)
  }
}

/**
 * `MAX(op_log.created_at) WHERE block_id = ?`, computed INDEPENDENTLY of the
 * production `rawOpLogLastEditedAt` helper — a hand-rolled scan over the raw
 * `opLog` store, not a call into it.
 *
 * `expect(row.lastModifiedAt).toBe(rawOpLogLastEditedAt(row.id))` would
 * compare the production helper to itself: `buildPageMetaRow` (`shared.ts`)
 * is LITERALLY `lastModifiedAt: rawOpLogLastEditedAt(pageId)`, so that
 * assertion can never distinguish "reads the op-log correctly" from "reads
 * the op-log however `rawOpLogLastEditedAt` currently happens to, right or
 * wrong" — a fallback reintroduced INSIDE `rawOpLogLastEditedAt` would leave
 * it green forever. Recomputing the same value a SECOND, independent way
 * makes a wrong implementation on either side of the comparison actually
 * detectable.
 */
function independentMaxOpLogCreatedAt(blockId: string): string | null {
  let max: string | null = null
  for (const entry of opLog) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(entry.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (payload['block_id'] !== blockId) continue
    if (max === null || entry.created_at > max) max = entry.created_at
  }
  return max
}

/** Resolve a seeded page's id from its title (bulk pages get random ids). */
function pageIdByTitle(title: string): string {
  for (const b of blocks.values()) {
    if (b['block_type'] === 'page' && b['content'] === title) return b['id'] as string
  }
  throw new Error(`no seeded page titled ${title}`)
}

/** Seed with `count` extra "Bulk Page NNN" fixtures (0 = canonical only). */
function seedWithBulkPages(count: number): void {
  globalThis.localStorage.setItem('__mockExtraPages', String(count))
  // The opt-in page-level facet fixture would add a 7th canonical-aged page
  // and shift every count below; pin it off rather than inherit it.
  globalThis.localStorage.removeItem('__mockFacetFixture')
  seedBlocks()
}

// ===========================================================================
// 1. The seed really writes op_log rows (not a stamp map)
// ===========================================================================
describe('seed — every fixture page carries real op_log activity', () => {
  beforeEach(() => {
    seedWithBulkPages(0)
  })

  it('writes one op_log row per canonical page, dated ≈90 days ago', () => {
    for (const pageId of CANONICAL_PAGE_IDS) {
      const rows = opLog.filter(
        (o) => (JSON.parse(o.payload) as Record<string, unknown>)['block_id'] === pageId,
      )
      expect(rows).toHaveLength(1)
      const created = rows[0]?.created_at as string
      // A real row at the intended time, not merely "some row": bracket it
      // tightly enough that a stamp written at "now" (the `pushOp` default)
      // or omitted entirely cannot satisfy it.
      expect(created > daysAgo(91)).toBe(true)
      expect(created < daysAgo(89)).toBe(true)
    }
  })

  it("the IPC row's lastModifiedAt is exactly MAX(op_log.created_at), for every page", () => {
    const page = listPages()
    expect(page.items.length).toBe(6)
    for (const row of page.items) {
      // Independently recomputed — see `independentMaxOpLogCreatedAt`'s doc
      // for why comparing against the production `rawOpLogLastEditedAt`
      // helper itself would be tautological.
      expect(row.lastModifiedAt).toBe(independentMaxOpLogCreatedAt(row.id))
      expect(row.lastModifiedAt).not.toBeNull()
    }
  })

  it('a page whose op_log rows are removed reports lastModifiedAt: null', () => {
    // The engine's answer for "never edited" is a NULL `last_modified_at`
    // column (`metadata.rs:778` is not COALESCE'd — only the keyset and the
    // filter coalesce, downstream). Any surviving fallback would report the
    // seeded stamp here instead.
    stripOpLogFor(SEED_IDS.PAGE_GETTING_STARTED)
    const row = listPages().items.find((r) => r.id === SEED_IDS.PAGE_GETTING_STARTED)
    expect(row).toBeDefined()
    expect(row?.lastModifiedAt).toBeNull()
  })
})

// ===========================================================================
// 2. The LastEdited FILTER arm (#3898)
// ===========================================================================
describe('list_pages_with_metadata — the LastEdited filter reads the op-log (#3898)', () => {
  const rolling = (days: number) => ({ type: 'LastEdited', spec: { type: 'Rolling', days } })
  const olderThan = (days: number) => ({ type: 'LastEdited', spec: { type: 'OlderThan', days } })
  const range = (start: string, end: string) => ({
    type: 'LastEdited',
    spec: { type: 'Range', start, end },
  })

  beforeEach(() => {
    seedWithBulkPages(5)
  })

  it('splits the seed the way the fixtures claim: 5 recent bulk pages, 6 old canonical pages', () => {
    // The unit-level statement of `e2e/pages-view.spec.ts`'s "Last-edited
    // buckets" counts. It holds because the bulk pages carry op_log rows
    // dated within the last few hours and the canonical pages carry op_log
    // rows dated ≈90 days ago — not because of any stamp the engine cannot
    // see.
    expect(listPages().total_count).toBe(11)

    const recent = listPages([rolling(1)])
    expect(recent.total_count).toBe(5)
    expect(titlesOf(recent).toSorted()).toEqual([
      'Bulk Page 001',
      'Bulk Page 002',
      'Bulk Page 003',
      'Bulk Page 004',
      'Bulk Page 005',
    ])

    const old = listPages([olderThan(30)])
    expect(old.total_count).toBe(6)
    expect(titlesOf(old)).not.toContain('Bulk Page 001')
  })

  it('a page whose op_log rows are removed leaves Rolling and joins OlderThan', () => {
    // THE #3898 detector. Bulk Page 001 is stamped "now", so under a
    // seeded-stamp fallback it would still pass Rolling{1} after its op-log
    // rows are gone. Reading the op-log, it coalesces to the epoch: excluded
    // by Rolling, included by OlderThan — the engine's documented rule, and
    // the half a Rolling-only assertion could not tell apart from "the row
    // was simply dropped".
    const bulk1 = pageIdByTitle('Bulk Page 001')
    expect(titlesOf(listPages([rolling(1)]))).toContain('Bulk Page 001')

    stripOpLogFor(bulk1)

    expect(titlesOf(listPages([rolling(1)]))).not.toContain('Bulk Page 001')
    expect(listPages([rolling(1)]).total_count).toBe(4)
    const old = listPages([olderThan(30)])
    expect(titlesOf(old)).toContain('Bulk Page 001')
    expect(old.total_count).toBe(7)
  })

  it('Range excludes a page whose op_log rows are removed, and keeps the ones that kept theirs', () => {
    // Range is the third variant of the epoch rule (EXCLUDES, like Rolling,
    // for a different reason: the epoch is below any plausible `start`). The
    // window brackets the canonical pages' ≈90d stamps only.
    const window = range(daysAgo(100), daysAgo(60))
    expect(listPages([window]).total_count).toBe(6)

    stripOpLogFor(SEED_IDS.PAGE_GETTING_STARTED)

    const after = listPages([window])
    expect(after.total_count).toBe(5)
    expect(titlesOf(after)).not.toContain('Getting Started')
    expect(titlesOf(after)).toContain('Quick Notes')
  })

  it('a fresh op_log row moves a page INTO the rolling window', () => {
    // The forward direction: the filter must follow op-log writes, not only
    // op-log deletions. Excludes the reading "the filter ignores the op-log
    // and always answers from the block's age".
    expect(titlesOf(listPages([rolling(1)]))).not.toContain('Getting Started')
    stampPageLastEdited(SEED_IDS.PAGE_GETTING_STARTED, new Date().toISOString())
    const recent = listPages([rolling(1)])
    expect(titlesOf(recent)).toContain('Getting Started')
    expect(recent.total_count).toBe(6)
  })
})

// ===========================================================================
// 3. The RecentlyModified SORT arm (#3884)
// ===========================================================================
describe('list_pages_with_metadata — the recently-modified sort reads the op-log (#3884)', () => {
  beforeEach(() => {
    seedWithBulkPages(5)
  })

  it('orders the bulk pages newest-first ahead of every canonical page', () => {
    // Bulk page i is stamped `now - (i-1)` hours, canonical pages ≈90 days
    // ago, all via real op_log rows. If those rows were missing the whole set
    // would tie at the sentinel and collapse onto the id tiebreak.
    const titles = titlesOf(listPages([], 'recently-modified'))
    expect(titles.slice(0, 5)).toEqual([
      'Bulk Page 001',
      'Bulk Page 002',
      'Bulk Page 003',
      'Bulk Page 004',
      'Bulk Page 005',
    ])
    expect(titles.slice(5).toSorted()).toEqual(
      [
        'Getting Started',
        'Meeting Notes Template',
        'Meetings',
        'Projects',
        'Quick Notes',
        todayDate(),
      ].toSorted(),
    )
  })

  it('a page whose op_log rows are removed falls from FIRST to LAST', () => {
    // THE #3884 detector, and the sort-arm mirror of the Rolling case above.
    // Bulk Page 001 leads this sort on its "now" stamp; strip its op-log rows
    // and it must tie at the null sentinel, i.e. sort behind even the ≈90-day
    // -old canonical pages. A surviving seeded-stamp fallback would keep it
    // in first place.
    const bulk1 = pageIdByTitle('Bulk Page 001')
    expect(titlesOf(listPages([], 'recently-modified'))[0]).toBe('Bulk Page 001')

    stripOpLogFor(bulk1)

    const titles = titlesOf(listPages([], 'recently-modified'))
    expect(titles).toHaveLength(11)
    expect(titles[0]).toBe('Bulk Page 002')
    expect(titles.at(-1)).toBe('Bulk Page 001')
  })

  it('op-log-free pages tie at the sentinel and fall to the id tiebreak', () => {
    // The engine's `COALESCE(..., LAST_MOD_NULL_SENTINEL)` makes every
    // never-edited row EQUAL, not merely "last": with two of them the order
    // between the pair must be id ASC, exactly as `keyset_for`'s
    // `StringDescNullCoalesced` + id tiebreak resolves it.
    const bulk1 = pageIdByTitle('Bulk Page 001')
    const bulk2 = pageIdByTitle('Bulk Page 002')
    stripOpLogFor(bulk1)
    stripOpLogFor(bulk2)

    const rows = (listPages([], 'recently-modified').items as MetaRow[]).slice(-2)
    expect(rows.map((r) => r.lastModifiedAt)).toEqual([null, null])
    const [first, second] = rows
    expect(first?.id.localeCompare(second?.id ?? '')).toBeLessThan(0)
    expect(new Set([first?.id, second?.id])).toEqual(new Set([bulk1, bulk2]))
  })
})
