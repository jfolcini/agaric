/**
 * Every block command block mode's toolbar can send (#5691): page mode answers
 * it (`pageToolbarCommands`) or leaves it out with a reason, so a command added
 * to the toolbar later cannot be silently inert there. The bus gives a focused
 * target every command and does nothing for one it has no handler for. The
 * names are read from the toolbar's source, as `source-toolbar-parity.test.ts`
 * reads its config.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'

import { pageToolbarCommands } from '@/editor/page-mode/page-toolbar'
import { BLOCK_EVENTS } from '@/lib/block-event-names'
import { createPageBlockStore } from '@/stores/page-blocks'

const COMPONENTS = resolve(import.meta.dirname, '..', '..', '..', 'components')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourcesUnder(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** The toolbar and what it renders: the menus, the selectors, the groups. */
const TOOLBAR_SOURCES = [
  join(COMPONENTS, 'FormattingToolbar.tsx'),
  ...sourcesUnder(join(COMPONENTS, 'FormattingToolbar')),
  ...sourcesUnder(join(COMPONENTS, 'editor-toolbar')),
].map((file) => readFileSync(file, 'utf8'))

const CALL = /dispatchBlockCommand\(/g
const LITERAL_CALL = /dispatchBlockCommand\(\s*'([A-Z_0-9]+)'/g

const SENT = [
  ...new Set(TOOLBAR_SOURCES.flatMap((src) => [...src.matchAll(LITERAL_CALL)].map((m) => m[1]))),
] as string[]

/** Sent by the toolbar, not answered in page mode. */
const LEFT_OUT: Record<string, string> = {
  DISCARD_BLOCK_EDIT: 'page mode saves as it goes, so its toolbar hides Discard (`HIDDEN`)',
}

const handled = new Set(
  Object.keys(
    pageToolbarCommands({} as Editor, { current: {} as never }, createPageBlockStore('P')),
  ),
)

describe('the block commands the toolbar sends', () => {
  it('are read from every dispatch in the toolbar, each a named command', () => {
    const calls = TOOLBAR_SOURCES.reduce((n, src) => n + (src.match(CALL)?.length ?? 0), 0)
    const literal = TOOLBAR_SOURCES.reduce(
      (n, src) => n + [...src.matchAll(LITERAL_CALL)].length,
      0,
    )

    expect(SENT).toContain('TOGGLE_TODO_STATE')
    expect(calls).toBe(literal)
    for (const name of SENT) expect(Object.keys(BLOCK_EVENTS)).toContain(name)
  })

  it.each(SENT)('%s is answered in page mode, or left out with a reason', (name) => {
    expect(handled.has(name) || LEFT_OUT[name] !== undefined).toBe(true)
  })

  it('leave out only what it sends and page mode does not answer', () => {
    for (const name of Object.keys(LEFT_OUT)) {
      expect(SENT).toContain(name)
      expect(handled.has(name)).toBe(false)
    }
  })
})
