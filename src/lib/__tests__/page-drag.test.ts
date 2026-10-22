import { afterEach, describe, expect, it, vi } from 'vitest'

import { carriesPage, droppedPageId, dropPageAt, setPageDragData } from '@/lib/page-drag'

const PAGE = '01HZ00000000000000000PAGE1'

describe('page-drag', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('carries the page, and its link as plain text', () => {
    const data = new DataTransfer()
    setPageDragData(data, PAGE)
    expect(carriesPage(data)).toBe(true)
    expect(droppedPageId(data)).toBe(PAGE)
    expect(data.getData('text/plain')).toBe(`[[${PAGE}]]`)
  })

  it('reads no page from a drag of something else', () => {
    const data = new DataTransfer()
    data.setData('text/plain', 'hello')
    expect(carriesPage(data)).toBe(false)
    expect(droppedPageId(data)).toBeNull()
    expect(carriesPage(null)).toBe(false)
  })

  // happy-dom's DragEvent keeps neither the point nor the data it is built
  // with; the bookmark spec in `e2e/page-link-drag.spec.ts` drops a real one.
  it('drops the page on the element at the point', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const drop = vi.fn()
    target.addEventListener('drop', drop)
    const at = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)

    dropPageAt(PAGE, 12, 34)

    expect(at).toHaveBeenCalledWith(12, 34)
    expect(drop).toHaveBeenCalledTimes(1)
    target.remove()
  })

  it('drops nothing on a point over nothing', () => {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    expect(() => dropPageAt(PAGE, 1, 1)).not.toThrow()
  })
})
