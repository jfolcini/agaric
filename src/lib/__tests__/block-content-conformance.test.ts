/**
 * #5160 — the block editor's reading of `conformance/block-content.vectors.json`,
 * the stored content whose meaning Rust and the editor must share. The Rust
 * side (`markdown_source_tests.rs`) reads each content through source mode as
 * one block with that content and no properties.
 *
 * Here the save flush runs over each block after a typo fix, and must keep it
 * one plain edit: the flush acts only on what the edit added, never on the
 * shape the block was loaded with (D2).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { processCheckboxSyntax } from '@/lib/block-utils'
import { TASK_STATE_TO_MARKER, TASK_STATES, type TodoState } from '@/lib/task-states'
import { runUnmountFlush, type UnmountFlushResult } from '@/lib/unmount-flush'

interface StoredBlock {
  name: string
  content: string
  editorFlush: UnmountFlushResult['kind']
}

interface TaskMarker {
  marker: string
  todoState: TodoState | null
  canonical: boolean
}

interface Vectors {
  blocks: StoredBlock[]
  taskMarkers: TaskMarker[]
}

const VECTORS_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'conformance',
  'block-content.vectors.json',
)
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors

/** The typo fix: `!` typed after the last letter or digit, so trailing spaces
 *  and a closing fence stay where they are. */
function typoFixed(content: string): string {
  const edited = content.replace(/([\p{L}\p{N}])([^\p{L}\p{N}]*)$/u, '$1!$2')
  expect(edited, 'a row needs a letter or digit to edit').not.toBe(content)
  return edited
}

describe('stored block content vectors (#5160)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_property_def: () => null,
        set_property: () => undefined,
        set_todo_state: () => undefined,
      }),
    )
  })

  it.each(vectors.blocks.map((row) => [row.name, row] as const))(
    'an edited copy of %s flushes as one plain edit',
    async (_name, row) => {
      const result = runUnmountFlush({
        blockId: 'BLOCK',
        loaded: row.content,
        changed: typoFixed(row.content),
        edit: () => Promise.resolve(true),
        splitBlock: () => Promise.resolve(true),
        rootParentId: null,
      })
      await result.outcome
      expect(result.kind).toBe(row.editorFlush)
    },
  )

  it.each(vectors.taskMarkers.map((row) => [row.marker, row] as const))(
    'the checkbox [%s] means what it means in Rust',
    (_marker, row) => {
      const typed = `- [${row.marker}] task`
      const expected =
        row.todoState === null
          ? { cleanContent: typed, todoState: null }
          : { cleanContent: 'task', todoState: row.todoState }
      expect(processCheckboxSyntax(typed)).toEqual(expected)
      if (row.canonical) {
        expect(row.todoState === null ? null : TASK_STATE_TO_MARKER[row.todoState]).toBe(row.marker)
      }
    },
  )

  it('every task state has one canonical checkbox', () => {
    const canonical = vectors.taskMarkers.filter((row) => row.canonical).map((row) => row.todoState)
    expect(canonical).toHaveLength(TASK_STATES.length)
    expect(new Set(canonical)).toEqual(new Set(TASK_STATES))
  })
})
