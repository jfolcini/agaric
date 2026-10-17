/**
 * Tests for the token-driven Mermaid theme (#5638).
 *
 * happy-dom has no 2D canvas, so a fake context stands in: it paints a `#rrggbb`
 * fill as that colour and anything else it cannot parse as nothing, the way a
 * real engine ignores an unparseable `fillStyle`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  mermaidThemeCss,
  mermaidThemeVariables,
  readDiagramColors,
} from '@/components/rendering/mermaid-theme'

const TOKENS = {
  '--background': '#fafafa',
  '--muted': '#eeeeee',
  '--foreground': '#111111',
  '--muted-foreground': '#666666',
  '--border': '#e0e0e0',
  '--status-pending': '#fff8d0',
  '--status-pending-foreground': '#806000',
  '--status-active': '#e0ecff',
  '--status-active-foreground': '#203070',
  '--status-done': '#e0f8e8',
  '--status-done-foreground': '#205030',
  '--alert-error': '#ffe8e8',
  '--alert-error-foreground': '#902020',
}

function fakeContext(): CanvasRenderingContext2D {
  let fill = 'transparent'
  const pixels = new Uint8ClampedArray(4 * 16)
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
      grid: '#e0e0e0',
      note: '#fff8d0',
      noteLine: '#806000',
      active: '#e0ecff',
      activeLine: '#203070',
      done: '#e0f8e8',
      doneLine: '#205030',
      crit: '#ffe8e8',
      critLine: '#902020',
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
    grid: '#000005',
    note: '#000006',
    noteLine: '#000007',
    active: '#000008',
    activeLine: '#000009',
    done: '#00000a',
    doneLine: '#00000b',
    crit: '#00000c',
    critLine: '#00000d',
  }

  it('paints text in the text token on the fill token, and strokes and edges in the line token', () => {
    const v = mermaidThemeVariables(colors, true, 'Inter')
    expect(v).toMatchObject({
      darkMode: true,
      fontFamily: 'Inter',
      primaryColor: '#000002',
      primaryTextColor: '#000003',
      primaryBorderColor: '#000004',
      lineColor: '#000004',
    })
  })

  it('leaves edge labels and clusters on the canvas, so neither paints a box', () => {
    const v = mermaidThemeVariables(colors, false, 'Inter')
    // Mermaid derives `clusterBkg` from `tertiaryColor`.
    expect(v).toMatchObject({ edgeLabelBackground: '#000001', tertiaryColor: '#000001' })
  })

  it('gives every filled shape a border of its own stroke token', () => {
    expect(mermaidThemeVariables(colors, false, 'Inter')).toMatchObject({
      primaryBorderColor: '#000004',
      noteBkgColor: '#000006',
      noteBorderColor: '#000007',
      taskBkgColor: '#000002',
      taskBorderColor: '#000004',
      activeTaskBkgColor: '#000008',
      activeTaskBorderColor: '#000009',
      doneTaskBkgColor: '#00000a',
      doneTaskBorderColor: '#00000b',
      critBkgColor: '#00000c',
      critBorderColor: '#00000d',
    })
  })

  it('keeps gantt section bands and ER rows on the canvas and fill tokens, never white', () => {
    expect(mermaidThemeVariables(colors, true, 'Inter')).toMatchObject({
      sectionBkgColor: '#000002',
      altSectionBkgColor: '#000001',
      rowOdd: '#000001',
      rowEven: '#000002',
      taskTextColor: '#000003',
      taskTextLightColor: '#000003',
    })
  })
})

describe('mermaidThemeCss', () => {
  const css = mermaidThemeCss({
    background: '#000001',
    fill: '#000002',
    text: '#000003',
    line: '#000004',
    grid: '#000005',
    note: '#000006',
    noteLine: '#000007',
    active: '#000008',
    activeLine: '#000009',
    done: '#00000a',
    doneLine: '#00000b',
    crit: '#00000c',
    critLine: '#00000d',
  })

  it('puts class-diagram edge labels on the canvas, not the node fill', () => {
    expect(css).toContain('.labelBkg, .edgeLabel .label span { background-color: #000001; }')
    expect(css).toContain('.edgeLabel .label rect { fill: #000001; }')
  })

  it('fills ER zero markers with the canvas, not white', () => {
    expect(css).toContain('.marker.er circle { fill: #000001; }')
  })
})
