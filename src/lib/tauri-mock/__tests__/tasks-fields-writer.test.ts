/**
 * #6277 D3 — the mock's Document buffer writes a checkbox task's fields as
 * Obsidian Tasks signifiers, as `render_block` does: a done task's done date
 * as `✅`, and a rule with a bound as `repeat*::` lines.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { PageBuffer, PageSourceReport } from '@/lib/bindings'
import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

const PAGE = id('PAGE')

function task(label: string, state: string, held: Record<string, Record<string, unknown>>): void {
  const row = makeBlock(id(label), 'content', label, PAGE, blocks.size)
  row['page_id'] = PAGE
  row['todo_state'] = state
  blocks.set(id(label), row)
  properties.set(id(label), new Map(Object.entries(held)))
}

describe('the mock writing a task line (#6277 D3)', () => {
  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Home', null, 1))
    setSpace(PAGE, id('SPACE'))
  })

  it('writes a done task’s done date as ✅ and a bounded rule as lines', () => {
    task('ship', 'DONE', { completed_at: { value_date: '2026-10-03' } })
    task('water', 'TODO', {
      repeat: { value_text: '+1w' },
      'repeat-until': { value_date: '2026-12-31' },
    })

    const { text } = dispatch('get_page_buffer', { pageId: PAGE }) as PageBuffer

    expect(text).toBe(
      '- [x] ship ✅ 2026-10-03\n- [ ] water\n  repeat:: +1w\n  repeat-until:: 2026-12-31\n',
    )
  })

  it('keeps a `✅` date typed on a task ticked in the same save, and a done date its `✅` was taken off', () => {
    task('ship', 'TODO', {})
    task('shop', 'DONE', { completed_at: { value_date: '2026-10-03' } })
    const buffer = dispatch('get_page_buffer', { pageId: PAGE }) as PageBuffer
    const edited = buffer.text
      .replace('- [ ] ship', '- [x] ship ✅ 2026-10-02')
      .replace(' ✅ 2026-10-03', '')

    dispatch('apply_page_source', {
      pageId: PAGE,
      source: edited,
      baseSource: buffer.source,
      merge: false,
      lineIds: buffer.line_ids,
    }) as PageSourceReport

    const completed = (label: string) =>
      properties.get(id(label))?.get('completed_at')?.['value_date']
    expect([completed('ship'), completed('shop')]).toEqual(['2026-10-02', '2026-10-03'])
  })
})
