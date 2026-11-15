import { describe, expect, it } from 'vitest'

import { joinListItems, splitListItems } from '@/lib/property-list'

describe('splitListItems', () => {
  it('splits at commas and trims each item', () => {
    expect(splitListItems('Ann,  Bob , Cy')).toEqual(['Ann', 'Bob', 'Cy'])
  })

  it('keeps a comma inside [[…]] and inside a quoted item', () => {
    expect(splitListItems('[[Smith, John]], "Doe, Jane", x')).toEqual([
      '[[Smith, John]]',
      'Doe, Jane',
      'x',
    ])
  })

  it('drops blank items, a quoted blank one included', () => {
    expect(splitListItems(' , a,, "  " ,')).toEqual(['a'])
  })

  it('keeps a malformed quote as written', () => {
    expect(splitListItems('"open, b')).toEqual(['"open, b'])
  })
})

describe('joinListItems', () => {
  it('quotes only an item the split would change', () => {
    expect(joinListItems(['Ann', 'Doe, Jane', 'say "hi"', ' pad'])).toBe(
      'Ann, "Doe, Jane", "say \\"hi\\"", " pad"',
    )
  })

  it('quotes an item that leaves a [ open, which would take the next comma', () => {
    expect(joinListItems(['[draft', 'b'])).toBe('"[draft", b')
  })

  it('reads back as the items it was given', () => {
    const items = ['Doe, Jane', '[[A, B]]', 'say "hi"', ' pad ', 'plain', '[open', 'next']
    expect(splitListItems(joinListItems(items))).toEqual(items)
  })
})
