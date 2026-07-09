/**
 * React node views for inline + block math (#1437).
 *
 * The editor models math as two atomic nodes whose LaTeX source lives in an
 * `attrs.latex` string:
 *   - `math_inline` → a `$…$` span, rendered inline via KaTeX.
 *   - `math_block`  → a `$$…$$` fenced block, rendered in KaTeX display mode.
 *
 * Both are ATOM nodes (no ProseMirror-managed inner text), so KaTeX renders the
 * raw `attrs.latex`. The source is edited via the node view's raw-source toggle
 * (a small contentEditable=false textarea/input) — clicking the rendered math
 * reveals the editable source, mirroring the Mermaid node view's affordance.
 *
 * Error handling: invalid LaTeX never crashes the editor — `KatexMath` renders
 * with `throwOnError:false` (the source shows in KaTeX's error colour), and the
 * raw-source toggle is always available to fix it.
 *
 * KaTeX is lazy-loaded (React.lazy + Suspense) so the ~250 kB library stays out
 * of the editor/index chunk (#750), exactly like the Mermaid node view.
 */

import { type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Lazy-load KatexMath so KaTeX (+ its CSS) loads only when a math node renders.
const KatexMath = lazy(() =>
  import('@/components/rendering/KatexMath').then((m) => ({ default: m.KatexMath })),
)

interface MathNodeViewBodyProps {
  props: NodeViewProps
  display: boolean
}

function MathNodeViewBody({ props, display }: MathNodeViewBodyProps): React.ReactElement {
  const { node, updateAttributes, editor } = props
  const { t } = useTranslation()
  const latex = (node.attrs['latex'] as string | undefined) ?? ''
  const [showSource, setShowSource] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // #2453 — mirror the latest LaTeX into a ref so the close handler (invoked
  // from the document-level capture listener and from onBlur, both of which
  // close over a render that may predate the user's edits) always reads the
  // current value.
  const latexRef = useRef(latex)
  latexRef.current = latex
  const deletedRef = useRef(false)

  // Close the source editor. #2453 — a whitespace-only atom has no canonical
  // serialized form: the serializer already drops it on emit (#2451), so an
  // atom wedged between two delimiter-wrapped runs makes serialize → parse →
  // serialize non-idempotent. Drop the invisible atom when the user finishes
  // editing its source rather than leaving it in the document. This runs on
  // CLOSE (blur / Enter / Escape), NOT on every `updateAttributes` keystroke,
  // so clearing the field to retype does not delete the node mid-edit.
  const closeSource = () => {
    if (latexRef.current.trim() === '') {
      // Guard the once-only delete against a concurrent block save/unmount
      // (the blur that triggers this can also tear the editor down); acting on
      // a destroyed editor throws (cf. the #1064 destroyed-editor guards).
      if (!deletedRef.current && !editor.isDestroyed) {
        deletedRef.current = true
        props.deleteNode()
      }
      return
    }
    setShowSource(false)
  }
  const closeSourceRef = useRef(closeSource)
  closeSourceRef.current = closeSource

  // Finding 44 — while the LaTeX source field is shown:
  //  - focus it (revealing it via the rendered-math button preventDefaults the
  //    mousedown, so nothing else moves focus into the field), and
  //  - contain its keydowns. `use-block-keyboard` attaches a CAPTURE-phase
  //    keydown listener on the editor container (an ancestor of this node
  //    view), so Enter/Backspace/arrows typed here would flush/merge/navigate
  //    blocks based on the stale ProseMirror selection before the input ever
  //    sees them. A capture listener on `document` runs before that container
  //    listener — it is the only place the node view can intercept its own
  //    keys. Enter/Escape close the source editor and hand focus back to the
  //    contenteditable; everything else stays a plain input keystroke.
  useEffect(() => {
    if (!showSource) return undefined
    inputRef.current?.focus()
    const containKeys = (e: KeyboardEvent) => {
      if (e.target !== inputRef.current) return
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        // #2453 — closing may drop an empty atom instead of just hiding the
        // source field; either way return focus to the contenteditable.
        closeSourceRef.current()
        editor.commands.focus()
      }
      e.stopPropagation()
    }
    document.addEventListener('keydown', containKeys, true)
    return () => document.removeEventListener('keydown', containKeys, true)
  }, [showSource, editor])

  const wrapperClass = display ? 'math-block-node-view' : 'math-inline-node-view'
  const testId = display ? 'math-block-node-view' : 'math-inline-node-view'

  return (
    <NodeViewWrapper
      as={display ? 'div' : 'span'}
      className={wrapperClass}
      data-testid={testId}
      // contentEditable=false — the LaTeX is an atom edited only via the source
      // field below, never as inline ProseMirror text.
      contentEditable={false}
    >
      {showSource ? (
        <span
          className="math-source-editor inline-flex items-center gap-1"
          // Finding 44 — the roving editor's blur guard (useEditorBlur Step 4a)
          // keeps the block mounted when focus moves into a `data-editor-portal`
          // element. Without it, focusing the input blurs the contenteditable,
          // which saves + unmounts the block and destroys this input under the
          // pointer before a single character can be typed.
          data-editor-portal=""
        >
          <input
            ref={inputRef}
            type="text"
            className="rounded border border-input bg-background px-1 font-mono text-sm"
            data-testid="math-source-input"
            aria-label={t('math.editSource')}
            value={latex}
            // stopPropagation so ProseMirror's own mousedown handling ignores
            // clicks in the field; the browser default still focuses the input
            // (the data-editor-portal tag above keeps the editor mounted).
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => updateAttributes({ latex: e.target.value })}
            onBlur={() => closeSourceRef.current()}
            // Enter/Escape live in the document-level capture listener above —
            // a React onKeyDown here would never fire (propagation is stopped
            // before React's root listener sees the event).
          />
        </span>
      ) : (
        <button
          type="button"
          className="math-rendered cursor-pointer"
          data-testid="math-rendered"
          aria-label={t('math.editSource')}
          // preventDefault on mousedown so clicking the math does not blur the
          // editor (a blur flushes the block + unmounts this node view).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowSource(true)}
        >
          {latex.trim().length > 0 ? (
            <Suspense fallback={<span className="text-muted-foreground">{latex}</span>}>
              <KatexMath latex={latex} display={display} />
            </Suspense>
          ) : (
            <span className="text-muted-foreground">{t('math.empty')}</span>
          )}
        </button>
      )}
    </NodeViewWrapper>
  )
}

export function MathInlineNodeView(props: NodeViewProps): React.ReactElement {
  return <MathNodeViewBody props={props} display={false} />
}

export function MathBlockNodeView(props: NodeViewProps): React.ReactElement {
  return <MathNodeViewBody props={props} display />
}
