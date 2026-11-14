/**
 * A query block returns what the search box returns for the same text (#6742).
 *
 * `conformance/fixtures/query_text_tokens_match_search.json` holds, per text, the
 * request the search box sends and the one a query block sends, with the rows
 * the backend answers each with. Here each text is shown to produce exactly
 * those two requests, and the two recorded answers to be the same rows.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { invoke } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { astFilterParams } from '@/components/SearchPanel/searchFilterParams'
import { searchBlocks } from '@/lib/ipc-helpers'
import { compileQueryTextWithTags } from '@/lib/query-text'
import { astToFilterProjection, parse } from '@/lib/search-query'

interface Step {
  name: string
  args: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../../conformance/fixtures/query_text_tokens_match_search.json',
    ),
    'utf8',
  ),
) as { queries: Step[]; expected_queries: Array<{ name: string; rows: string[] }> }

const SPACE = '0000000000000000000000SPACE'
const TAGS = [{ tag_id: 'S8', name: 'urgent' }]
// `block_due_overdue` is `due:overdue` as it compiles on this day.
const TODAY = new Date(2026, 0, 1)

function step(name: string): Step {
  const found = fixture.queries.find((q) => q.name === name)
  if (!found) throw new Error(`no step ${name}`)
  return found
}

function rows(name: string): string[] {
  const found = fixture.expected_queries.find((q) => q.name === name)
  if (!found) throw new Error(`no recorded answer for ${name}`)
  return found.rows.toSorted()
}

/** A request without the fields that say nothing: the wire's defaults, and its scope. */
function stated(filter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filter).filter(
      ([key, value]) =>
        key !== 'scope' &&
        value != null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0),
    ),
  )
}

/** The `search_blocks` request the search box sends for `text`. */
async function searchRequest(text: string) {
  const ast = parse(text)
  const projection = astToFilterProjection(ast)
  const tagIds = projection.tagNames.flatMap(
    (name) => TAGS.find((tag) => tag.name === name)?.tag_id ?? [],
  )
  vi.mocked(invoke).mockImplementation(
    mockInvokeCommands({
      search_blocks: () => ({ items: [], next_cursor: null, has_more: false, total_count: null }),
    }),
  )
  await searchBlocks({
    query: ast.freeText,
    ...astFilterParams(projection, tagIds),
    spaceId: SPACE,
  })
  const sent = vi.mocked(invoke).mock.lastCall?.[1] as {
    query: string
    filter: Record<string, unknown>
  }
  return { query: sent.query, filter: stated(sent.filter) }
}

describe('a query block and the search box, text by text', () => {
  it.each([
    ['path:alpha', 'path', ['B1', 'B2', 'B3', 'B4']],
    ['not-path:alpha', 'not_path', ['B5', 'B6', 'B7', 'B8']],
    ['under:#urgent', 'under', ['B2', 'B3', 'B7']],
    ['launch', 'text', ['B2', 'B6']],
    ['state:TODO launch', 'text_and_state', ['B2']],
    ['due:overdue', 'due_overdue', ['B2']],
  ])('%s', async (text, name, expected) => {
    const search = step(`search_${name}`).args as { query: string; filter: Record<string, unknown> }
    expect(await searchRequest(text)).toEqual({
      query: search.query,
      filter: stated(search.filter),
    })

    const compiled = compileQueryTextWithTags(text, TAGS, TODAY)
    if (!compiled.ok) throw new Error(`"${text}" did not compile`)
    const { filter, fulltext = '' } = step(`block_${name}`).args['request'] as {
      filter: unknown
      fulltext?: string
    }
    expect({ filter: compiled.filter, fulltext: compiled.fulltext }).toEqual({ filter, fulltext })

    expect(rows(`search_${name}`)).toEqual(expected)
    expect(rows(`block_${name}`)).toEqual(expected)
  })
})
