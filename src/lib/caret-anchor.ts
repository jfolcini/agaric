/**
 * PEND-60 Phase 1 — Pure caret-anchor utility.
 *
 * Given a single-line `<input>` and a character offset, return a
 * viewport-relative `DOMRect` whose `(x, y)` is the pixel position of
 * the caret. Used by the autocomplete popover to anchor itself next
 * to the cursor.
 *
 * The text-measurement step is injectable so callers (mostly tests)
 * can supply a deterministic measurer when the canvas 2D context is
 * unavailable (jsdom / happy-dom both return `null` from
 * `canvas.getContext('2d')`).
 */

export type MeasureTextFn = (text: string, font: string) => number

let cachedCanvas: HTMLCanvasElement | null = null
let cachedCtx: CanvasRenderingContext2D | null = null
let canvasInitialised = false

export const defaultMeasureText: MeasureTextFn = (text, font) => {
  if (!canvasInitialised) {
    canvasInitialised = true
    cachedCanvas = document.createElement('canvas')
    cachedCtx = cachedCanvas.getContext('2d')
  }
  if (cachedCtx === null) return 0
  cachedCtx.font = font
  const width = cachedCtx.measureText(text).width
  // Defensive: jsdom-like environments may return NaN/undefined.
  return Number.isFinite(width) ? width : 0
}

/**
 * Return a viewport-relative `DOMRect` for the pixel position of the
 * caret at `caretIndex` within the single-line `<input>` element.
 * Width is always 0 (caret has no width); height matches the input's
 * effective line height.
 *
 * `caretIndex` is clamped to `[0, input.value.length]`.
 */
export function getCaretRect(
  input: HTMLInputElement,
  caretIndex: number,
  measureText: MeasureTextFn = defaultMeasureText,
): DOMRect {
  const value = input.value
  const clamped = Math.max(0, Math.min(caretIndex, value.length))

  const style = getComputedStyle(input)
  const font = composeFont(style)

  const inputRect = input.getBoundingClientRect()
  const borderLeft = parseFloat(style.borderLeftWidth) || 0
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const paddingLeft = parseFloat(style.paddingLeft) || 0
  const paddingTop = parseFloat(style.paddingTop) || 0

  const textBefore = value.slice(0, clamped)
  const width = measureText(textBefore, font)

  const x = inputRect.left + borderLeft + paddingLeft + width - input.scrollLeft
  const y = inputRect.top + borderTop + paddingTop

  // `line-height: normal` parses to NaN; fall back to fontSize × 1.2.
  const lineHeight = parseFloat(style.lineHeight)
  const fontSize = parseFloat(style.fontSize) || 0
  const height = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2

  return new DOMRect(x, y, 0, height)
}

function composeFont(style: CSSStyleDeclaration): string {
  const fontStyle = style.fontStyle || 'normal'
  const fontVariant = style.fontVariant || 'normal'
  const fontWeight = style.fontWeight || 'normal'
  const fontSize = style.fontSize || '16px'
  const fontFamily = style.fontFamily || 'sans-serif'
  return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`
}
