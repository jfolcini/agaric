import type React from 'react'
import { Fragment } from 'react'
import type { CodeBlockNode } from '../../../editor/types'
import { curatedLowlight } from '../../../lib/lowlight-curated'
import { ScrollArea } from '../../ui/scroll-area'
import { renderMermaidBlock } from './mermaid'

// `curatedLowlight` is the shared instance (see `src/lib/lowlight-curated.ts`).
// Aliased locally so the existing `lowlight.highlight(...)` call-sites below
// keep their concise form and we avoid touching unrelated lines.
const lowlight = curatedLowlight

// ============================================================================
// Hast → React (for syntax-highlighted code blocks, avoids innerHTML)
// ============================================================================

interface HastTextNode {
  readonly type: 'text'
  readonly value: string
}
interface HastElementNode {
  readonly type: 'element'
  readonly tagName: string
  readonly properties?: Readonly<Record<string, unknown>>
  readonly children: readonly HastChildNode[]
}
interface HastRootNode {
  readonly type: 'root'
  readonly children: readonly HastChildNode[]
}
type HastChildNode = HastTextNode | HastElementNode

function hastClassName(
  properties: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const cls = properties?.['className']
  if (Array.isArray(cls)) {
    return cls.filter((c): c is string => typeof c === 'string').join(' ')
  }
  if (typeof cls === 'string') return cls
  return undefined
}

function hastChildrenToReact(
  children: readonly HastChildNode[],
  keyPrefix: string,
): React.ReactNode[] {
  return children.map((child, i) => {
    const childKey = `${keyPrefix}-${i}`
    if (child.type === 'text') {
      return <Fragment key={childKey}>{child.value}</Fragment>
    }
    return (
      <span key={childKey} className={hastClassName(child.properties)}>
        {hastChildrenToReact(child.children, childKey)}
      </span>
    )
  })
}

function renderHighlightedCode(code: string, language: string, key: string): React.ReactNode {
  try {
    const tree = (language
      ? lowlight.highlight(language, code)
      : lowlight.highlightAuto(code)) as unknown as HastRootNode
    return hastChildrenToReact(tree.children, key)
  } catch {
    return code
  }
}

export function renderCodeBlock(block: CodeBlockNode, key: string): React.ReactElement {
  const code = block.content?.[0]?.text ?? ''
  const language = block.attrs?.language ?? ''
  if (language === 'mermaid') return renderMermaidBlock(code, key)
  return (
    <ScrollArea key={key} className="bg-muted rounded-md text-sm font-mono">
      <pre className="px-3 py-2">
        <code className={language ? `language-${language} hljs` : 'hljs'}>
          {renderHighlightedCode(code, language, `${key}-code`)}
        </code>
      </pre>
    </ScrollArea>
  )
}
