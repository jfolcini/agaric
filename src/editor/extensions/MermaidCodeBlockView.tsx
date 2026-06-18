/**
 * MermaidCodeBlockView — React node view for the editor's code blocks (#1438).
 *
 * The editor models a Mermaid diagram as a regular `codeBlock` whose
 * `language` attr is `'mermaid'` (so it parses from / serializes to a
 * ` ```mermaid ` fence with zero changes to the markdown serializer — the
 * round-trip is the existing code-block round-trip). This node view only
 * changes the EDITING presentation:
 *
 *  - language !== 'mermaid' → the standard editable code block (a
 *    `<pre><code>` whose content is ProseMirror-managed via NodeViewContent),
 *    so no other language's behaviour changes.
 *  - language === 'mermaid' → a rendered diagram (reusing the existing
 *    `MermaidDiagram` component) with a "raw source" toggle. The editable
 *    source (`NodeViewContent`) is always present in the DOM so the text stays
 *    ProseMirror-managed and serializes losslessly; it is merely visually
 *    hidden while the diagram is shown.
 *
 * Error handling: invalid Mermaid never crashes the editor — `MermaidDiagram`
 * already renders an inline error + the raw source on a render failure, and the
 * raw-source toggle is always available to fix the diagram.
 */

import { type NodeViewProps, NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Lazy-load MermaidDiagram so mermaid.js stays out of the editor/index chunk
// (#750 bundle budget) — it loads only when a mermaid diagram is shown. Mirrors
// the read-only RichContentRenderer mermaid path.
const MermaidDiagram = lazy(() =>
  import('@/components/rendering/MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
)

// `NodeViewContent`'s `as` prop is `NoInfer<T>` (default `'div'`), so passing
// `as="code"` directly fails to widen the element type. Bind the generic to
// `'code'` once so the editable content host renders as a `<code>` element with
// the correct prop types (className etc.).
const CodeNodeViewContent = NodeViewContent<'code'>

export function MermaidCodeBlockView(props: NodeViewProps): React.ReactElement {
  const { node } = props
  const { t } = useTranslation()
  const language = (node.attrs['language'] as string | null) ?? null
  // Default to the rendered diagram; the user toggles to raw source to edit.
  const [showSource, setShowSource] = useState(false)

  // Non-mermaid code blocks: render the standard editable code block. The
  // `language-<x>` class mirrors CodeBlockLowlight's default DOM so highlight
  // CSS and existing code-block styling continue to apply.
  if (language !== 'mermaid') {
    return (
      <NodeViewWrapper>
        <pre>
          <CodeNodeViewContent
            as="code"
            className={language ? `language-${language}` : undefined}
          />
        </pre>
      </NodeViewWrapper>
    )
  }

  // The raw source is the node's text content. `MermaidDiagram` reads it to
  // render the SVG; on invalid syntax it shows an inline error + the source.
  const source = node.textContent

  return (
    <NodeViewWrapper className="mermaid-code-block" data-testid="mermaid-node-view">
      <div className="mb-1 flex items-center justify-end">
        <button
          type="button"
          // contentEditable=false so the toggle button itself is never part of
          // the editable surface / selection.
          contentEditable={false}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          data-testid="mermaid-toggle-source"
          aria-pressed={showSource}
          // preventDefault on mousedown so clicking the toggle does NOT blur the
          // ProseMirror editor (a blur flushes the block and unmounts the node
          // view mid-toggle). Mirrors the toolbar buttons' focus-retention.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? t('mermaid.showDiagram') : t('mermaid.editSource')}
        </button>
      </div>

      {/* Rendered diagram (reuses MermaidDiagram). Hidden — not unmounted —
          while editing source, and given contentEditable=false so clicks in
          the SVG don't try to place a caret inside non-PM DOM. */}
      <div hidden={showSource} contentEditable={false} data-testid="mermaid-rendered">
        {/* Keying on the source remounts the diagram when the text changes so
            edits in raw mode re-render on toggle back. */}
        {source.trim().length > 0 ? (
          <Suspense fallback={null}>
            <MermaidDiagram key={source} code={source} />
          </Suspense>
        ) : (
          <p className="rounded-md bg-muted px-3 py-4 text-sm text-muted-foreground">
            {t('mermaid.empty')}
          </p>
        )}
      </div>

      {/* Editable raw source — always present so ProseMirror manages the text
          and it serializes back to ```mermaid losslessly; only visually hidden
          when the diagram is shown. */}
      <pre hidden={!showSource} className="mermaid-source">
        <CodeNodeViewContent as="code" className="language-mermaid" />
      </pre>
    </NodeViewWrapper>
  )
}
