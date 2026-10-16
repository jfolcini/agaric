/**
 * Tests for the token-driven Mermaid theme (#5638).
 *
 * happy-dom has no 2D canvas, so a fake context stands in: it paints a `#rrggbb`
 * fill as that colour and anything else it cannot parse as nothing, the way a
 * real engine ignores an unparseable `fillStyle`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mermaidThemeVariables, readDiagramColors } from '@/components/rendering/mermaid-theme'

const TOKENS = {
  '--background': '#fafafa',
  '--muted': '#eeeeee',
  '--foreground': '#111111',
  '--muted-foreground': '#666666',
  '--accent': '#dddddd',
}

function fakeContext(): CanvasRenderingContext2D {
  let fill = 'transparent'
  const pixels = new Uint8ClampedArray(4 * 8)
  return {
    get fillStyle() {
      return fill
    },
    set fillStyle(value: string) {
      if (value === 'transparent' || /^#[0-9a-f]{6}$/.test(value)) fill = value
    },
    fillRect(x: number) {
      if (fill === 'transparent') return
      for (let i = 0; i < 3; i++)
        pixels[x * 4 + i] = Number.parseInt(fill.slice(1 + i * 2, 3 + i * 2), 16)
      pixels[x * 4 + 3] = 255
    },
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D
}

function setTokens(tokens: Record<string, string>): void {
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value)
  }
}

describe('readDiagramColors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.removeAttribute('style')
  })

  it('resolves every diagram token to #rrggbb', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      fakeContext as unknown as HTMLCanvasElement['getContext'],
    )
    setTokens(TOKENS)
    expect(readDiagramColors()).toEqual({
      background: '#fafafa',
      fill: '#eeeeee',
      text: '#111111',
      line: '#666666',
      note: '#dddddd',
    })
  })

  it('returns null when a token cannot be painted, never the previous token’s colour', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      fakeContext as unknown as HTMLCanvasElement['getContext'],
    )
    setTokens({ ...TOKENS, '--foreground': 'not-a-colour' })
    expect(readDiagramColors()).toBeNull()
  })

  it('returns null without a 2D canvas', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(readDiagramColors()).toBeNull()
  })
})

describe('mermaidThemeVariables', () => {
  const colors = {
    background: '#000001',
    fill: '#000002',
    text: '#000003',
    line: '#000004',
    note: '#000005',
  }

  it('paints text in the text token on the fill token, and strokes and edges in the line token', () => {
    const v = mermaidThemeVariables(colors, true, 'Inter')
    expect(v).toMatchObject({
      darkMode: true,
      fontFamily: 'Inter',
      mainBkg: '#000002',
      primaryTextColor: '#000003',
      nodeBorder: '#000004',
      lineColor: '#000004',
      edgeLabelBackground: '#000001',
      noteBkgColor: '#000005',
    })
  })
})
