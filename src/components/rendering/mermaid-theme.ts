/**
 * Mermaid `themeVariables` built from the app's design tokens (#5638), so a
 * diagram follows every shipped theme instead of only light or dark.
 *
 * Contrast comes from the token pairs the app already relies on: foreground
 * text on the muted node fill and on the status tints, and muted-foreground or
 * status-foreground strokes on the page background. Notes and gantt task states
 * take the status tints, so they read apart from ordinary nodes in every theme.
 */

/** The design tokens a diagram is painted with. */
const DIAGRAM_TOKENS = {
  background: '--background',
  fill: '--muted',
  text: '--foreground',
  line: '--muted-foreground',
  grid: '--border',
  note: '--status-pending',
  noteLine: '--status-pending-foreground',
  active: '--status-active',
  activeLine: '--status-active-foreground',
  done: '--status-done',
  doneLine: '--status-done-foreground',
  crit: '--alert-error',
  critLine: '--alert-error-foreground',
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

/**
 * Map the resolved colours onto Mermaid's base-theme inputs. Only variables the
 * base theme would otherwise compute differently are set; the rest (node,
 * actor, cluster and link colours) it derives from these in `updateColors`.
 */
export function mermaidThemeVariables(
  c: DiagramColors,
  darkMode: boolean,
  fontFamily: string,
): Record<string, string | boolean> {
  return {
    darkMode,
    fontFamily,
    background: c.background,
    // Fills: node, actor and activation colours derive from these.
    primaryColor: c.fill,
    secondaryColor: c.fill,
    // Clusters and edge labels sit on the page itself.
    tertiaryColor: c.background,
    edgeLabelBackground: c.background,
    noteBkgColor: c.note,
    // Text: every other text colour derives from the primary one.
    primaryTextColor: c.text,
    secondaryTextColor: c.text,
    tertiaryTextColor: c.text,
    noteTextColor: c.text,
    // Strokes and edges: node, cluster, actor and link colours derive from these.
    primaryBorderColor: c.line,
    secondaryBorderColor: c.line,
    tertiaryBorderColor: c.line,
    lineColor: c.line,
    arrowheadColor: c.line,
    noteBorderColor: c.noteLine,
    activationBorderColor: c.line,
    // ER attribute rows: the base theme lightens them to plain white.
    rowOdd: c.background,
    rowEven: c.fill,
    ...ganttVariables(c),
  }
}

/** Gantt hard-codes greys, white and red the base theme never derives from the inputs. */
function ganttVariables(c: DiagramColors): Record<string, string> {
  return {
    // Section bands are drawn at 20% opacity, so these stay a faint stripe.
    sectionBkgColor: c.fill,
    sectionBkgColor2: c.fill,
    altSectionBkgColor: c.background,
    excludeBkgColor: c.fill,
    gridColor: c.grid,
    todayLineColor: c.critLine,
    taskBkgColor: c.fill,
    taskBorderColor: c.line,
    activeTaskBkgColor: c.active,
    activeTaskBorderColor: c.activeLine,
    doneTaskBkgColor: c.done,
    doneTaskBorderColor: c.doneLine,
    critBkgColor: c.crit,
    critBorderColor: c.critLine,
    taskTextColor: c.text,
    taskTextDarkColor: c.text,
    taskTextLightColor: c.text,
    taskTextOutsideColor: c.text,
    taskTextClickableColor: c.text,
  }
}

/**
 * Rules for what no theme variable reaches. Class diagrams paint edge labels
 * on the node fill, and ER draws its zero markers with a literal white fill.
 */
export function mermaidThemeCss(c: DiagramColors): string {
  return [
    `.labelBkg, .edgeLabel .label span { background-color: ${c.background}; }`,
    `.edgeLabel .label rect { fill: ${c.background}; }`,
    `.marker.er circle { fill: ${c.background}; }`,
  ].join('\n')
}
