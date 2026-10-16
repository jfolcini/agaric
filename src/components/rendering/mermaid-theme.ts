/**
 * Mermaid `themeVariables` built from the app's design tokens (#5638), so a
 * diagram follows every shipped theme instead of only light or dark.
 *
 * Contrast comes from the token pairs the app already relies on: foreground
 * text on the muted node fill, and muted-foreground strokes and edges on the
 * page background.
 */

/** The design tokens a diagram is painted with. */
const DIAGRAM_TOKENS = {
  background: '--background',
  fill: '--muted',
  text: '--foreground',
  line: '--muted-foreground',
  note: '--accent',
} as const

export type DiagramColors = Record<keyof typeof DIAGRAM_TOKENS, string>

const toHex = (channels: ArrayLike<number>, from: number): string =>
  `#${Array.from({ length: 3 }, (_, i) => (channels[from + i] ?? 0).toString(16).padStart(2, '0')).join('')}`

/**
 * Resolve the diagram tokens to `#rrggbb`. Mermaid's colour library cannot
 * parse `oklch()`, and WebKitGTK hands `oklch()` back from both a canvas
 * `fillStyle` and a computed style, so each token is painted onto a pixel and
 * read back. Returns `null` when a token cannot be painted (no 2D canvas, or
 * a value the engine does not parse).
 */
export function readDiagramColors(): DiagramColors | null {
  const canvas = document.createElement('canvas')
  canvas.width = Object.keys(DIAGRAM_TOKENS).length
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const styles = getComputedStyle(document.documentElement)
  const entries = Object.entries(DIAGRAM_TOKENS)
  entries.forEach(([, token], x) => {
    // Reset first: an unparseable value leaves `fillStyle` unchanged, and a
    // transparent pixel is how that failure shows up below.
    ctx.fillStyle = 'transparent'
    ctx.fillStyle = styles.getPropertyValue(token).trim()
    ctx.fillRect(x, 0, 1, 1)
  })
  const pixels = ctx.getImageData(0, 0, entries.length, 1).data
  const colors: Partial<DiagramColors> = {}
  for (const [x, [key]] of entries.entries()) {
    if (pixels[x * 4 + 3] !== 255) return null
    colors[key as keyof DiagramColors] = toHex(pixels, x * 4)
  }
  return colors as DiagramColors
}

/** Map the resolved colours onto every Mermaid variable a shipped diagram type paints with. */
export function mermaidThemeVariables(
  c: DiagramColors,
  darkMode: boolean,
  fontFamily: string,
): Record<string, string | boolean> {
  return {
    darkMode,
    fontFamily,
    background: c.background,
    // Node, actor and activation fills.
    primaryColor: c.fill,
    secondaryColor: c.fill,
    mainBkg: c.fill,
    nodeBkg: c.fill,
    actorBkg: c.fill,
    labelBoxBkgColor: c.fill,
    activationBkgColor: c.fill,
    // Clusters and edge labels sit on the page itself.
    tertiaryColor: c.background,
    clusterBkg: c.background,
    edgeLabelBackground: c.background,
    noteBkgColor: c.note,
    // Text.
    primaryTextColor: c.text,
    secondaryTextColor: c.text,
    tertiaryTextColor: c.text,
    textColor: c.text,
    nodeTextColor: c.text,
    titleColor: c.text,
    actorTextColor: c.text,
    labelTextColor: c.text,
    loopTextColor: c.text,
    noteTextColor: c.text,
    signalColor: c.text,
    signalTextColor: c.text,
    // Strokes and edges.
    primaryBorderColor: c.line,
    secondaryBorderColor: c.line,
    tertiaryBorderColor: c.line,
    nodeBorder: c.line,
    clusterBorder: c.line,
    lineColor: c.line,
    defaultLinkColor: c.line,
    arrowheadColor: c.line,
    actorBorder: c.line,
    actorLineColor: c.line,
    labelBoxBorderColor: c.line,
    noteBorderColor: c.line,
    activationBorderColor: c.line,
  }
}
