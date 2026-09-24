import { describe, expect, it } from 'vitest'

import { diffSourceByAnchor } from '@/lib/page-source-diff'

const id = (suffix: string): string => `01J${'0'.repeat(22)}${suffix}`
const A = id('A')
const B = id('B')
const C = id('C')
const D = id('D')

const buffer = (...lines: string[]): string => `${lines.join('\n')}\n`

describe('diffSourceByAnchor', () => {
  it('finds nothing between identical buffers', () => {
    const source = buffer(`- one ^${A}`, `  - child ^${B}`, `- two ^${C}`)

    expect(diffSourceByAnchor(source, source)).toEqual([])
  })

  it('does not count a block that only moved', () => {
    const base = buffer(`- one ^${A}`, `- two ^${B}`, `- three ^${C}`)
    const current = buffer(`- three ^${C}`, `- one ^${A}`, `- two ^${B}`)

    expect(diffSourceByAnchor(base, current)).toEqual([])
  })

  it('reports an added, a removed and a changed block, removed ones where they sat in base', () => {
    const base = buffer(`- one ^${A}`, `- two ^${B}`, `- three ^${C}`)
    const current = buffer(`- one, edited ^${A}`, `- three ^${C}`, `- four ^${D}`)

    expect(diffSourceByAnchor(base, current)).toEqual([
      { kind: 'changed', text: `- one, edited ^${A}` },
      { kind: 'removed', text: `- two ^${B}` },
      { kind: 'added', text: `- four ^${D}` },
    ])
  })

  it('keys a block by the anchor on its last line and counts its continuation lines', () => {
    const base = buffer(`- first line`, `  second line ^${A}`)
    const current = buffer(`- first line`, `  second line, edited ^${A}`)

    expect(diffSourceByAnchor(base, current)).toEqual([
      { kind: 'changed', text: `- first line\n  second line, edited ^${A}` },
    ])
  })

  it('keys a block by an anchor on a line of its own', () => {
    const base = buffer('- ```', '  let x = 1', '  ```', `  ^${A}`)
    const current = buffer('- ```', '  let x = 2', '  ```', `  ^${A}`)

    expect(diffSourceByAnchor(base, current)).toEqual([
      { kind: 'changed', text: `- \`\`\`\n  let x = 2\n  \`\`\`\n  ^${A}` },
    ])
  })

  it('keys a block by its anchor when property lines follow it', () => {
    const base = buffer(`- [ ] task ^${A}`, '  priority:: 1')
    const current = buffer(`- [ ] task ^${A}`, '  priority:: 2')

    expect(diffSourceByAnchor(base, current)).toEqual([
      { kind: 'changed', text: `- [ ] task ^${A}\n  priority:: 2` },
    ])
  })

  it('keeps a code line that looks like a bullet inside the block whose anchor follows it', () => {
    const base = buffer(`- one ^${B}`, '- ```', '  - item', '  ```', `  ^${A}`)
    const current = buffer(`- one ^${B}`, '- ```', '  - item', '  - item 2', '  ```', `  ^${A}`)

    expect(diffSourceByAnchor(base, current)).toEqual([
      { kind: 'changed', text: `- \`\`\`\n  - item\n  - item 2\n  \`\`\`\n  ^${A}` },
    ])
  })
})
