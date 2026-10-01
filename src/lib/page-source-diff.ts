/**
 * What changed between two page buffers, block by block (#5140, #5160 A).
 *
 * Both are `get_page_buffer` texts, each line beside the id it carries. A block
 * starts at the line carrying its id and runs to the next line that carries
 * one, and is keyed by that id, so one that only moved is not a change. The
 * lines above the first block, the page's front matter (#5160 S8), are one
 * more.
 */

import type { PageBuffer } from '@/lib/bindings'

/** A buffer's text and the id each of its lines carries. */
export type BufferLines = Pick<PageBuffer, 'text' | 'line_ids'>

export interface SourceChange {
  kind: 'added' | 'removed' | 'changed'
  text: string
}

function keyedBlocks({ text, line_ids }: BufferLines): [key: string | null, text: string][] {
  const blocks: [key: string | null, lines: string[]][] = []
  text.split('\n').forEach((line, i) => {
    const id = line_ids[i] ?? null
    const last = blocks.at(-1)
    if (last === undefined || id !== null) blocks.push([id, [line]])
    else last[1].push(line)
  })
  return blocks
    .map(([key, lines]): [string | null, string] => [key, lines.join('\n').replace(/\n+$/, '')])
    .filter(([, block]) => block !== '')
}

/** The changes from `base` to `current`, in current's order, removed ones where they sat in base. */
export function diffBuffers(base: BufferLines, current: BufferLines): SourceChange[] {
  const before = keyedBlocks(base)
  const beforeText = new Map(before)
  const after = new Map(keyedBlocks(current))
  const changes: SourceChange[] = []
  let beforeDone = 0
  const removedUpTo = (end: number): void => {
    for (const [key, text] of before.slice(beforeDone, end)) {
      if (!after.has(key)) changes.push({ kind: 'removed', text })
    }
    beforeDone = Math.max(beforeDone, end)
  }
  for (const [key, text] of after) {
    const was = beforeText.get(key)
    if (was === undefined) {
      changes.push({ kind: 'added', text })
      continue
    }
    removedUpTo(before.findIndex(([k]) => k === key) + 1)
    if (was !== text) changes.push({ kind: 'changed', text })
  }
  removedUpTo(before.length)
  return changes
}
