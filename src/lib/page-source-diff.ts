/**
 * What changed between two page source buffers, block by block (#5140).
 *
 * Both buffers are the backend's render, where every block carries its `^ID`
 * anchor, at the end of its last line or on a line of its own. A block starts
 * at a bullet line and runs through its anchor to the next bullet, so a code
 * line above the anchor that looks like a bullet stays in the block. A block
 * is keyed by its anchor; one that only moved is not a change.
 */

export interface SourceChange {
  kind: 'added' | 'removed' | 'changed'
  text: string
}

const BULLET_LINE = /^\s*- /
// Uppercase alphanumerics rather than strict Crockford, so the mock's seeded
// ids (`…BLOCK01`) key as anchors too.
const ANCHOR = /(?:^|\s)\^([0-9A-Z]{26})[ \t]*$/m

function keyedBlocks(source: string): [key: string, text: string][] {
  const blocks: string[] = []
  let anchored = false
  for (const line of source.split('\n')) {
    if (blocks.length === 0 || (anchored && BULLET_LINE.test(line))) {
      blocks.push(line)
      anchored = false
    } else {
      blocks[blocks.length - 1] += `\n${line}`
    }
    anchored ||= ANCHOR.test(line)
  }
  return blocks
    .map((block) => block.replace(/\n+$/, ''))
    .filter((text) => text !== '')
    .map((text) => [ANCHOR.exec(text)?.[1] ?? text, text])
}

/** The changes from `base` to `current`, in current's order, removed ones where they sat in base. */
export function diffSourceByAnchor(base: string, current: string): SourceChange[] {
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
