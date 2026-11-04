/**
 * The style a callout type renders in: one of the five `CALLOUT_CONFIG`
 * defines (`RichContentRenderer/context.ts`). Obsidian's types and aliases and
 * GitHub's and GitLab's alerts each take the nearest one; any other type, a
 * custom `[!my-type]` among them, renders as a note. Only the look maps: the
 * stored and written type stays as typed.
 */

type CalloutStyle = 'info' | 'warning' | 'tip' | 'error' | 'note'

const STYLE_OF_TYPE: Readonly<Record<string, CalloutStyle>> = {
  note: 'note',
  quote: 'note',
  cite: 'note',
  info: 'info',
  todo: 'info',
  abstract: 'info',
  summary: 'info',
  tldr: 'info',
  example: 'info',
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  question: 'warning',
  help: 'warning',
  faq: 'warning',
  error: 'error',
  danger: 'error',
  failure: 'error',
  fail: 'error',
  missing: 'error',
  bug: 'error',
}

export function calloutStyle(type: string): CalloutStyle {
  const key = type.toLowerCase()
  // `hasOwn`, so a type named like an `Object.prototype` member is a note too.
  return Object.hasOwn(STYLE_OF_TYPE, key) ? (STYLE_OF_TYPE[key] as CalloutStyle) : 'note'
}
