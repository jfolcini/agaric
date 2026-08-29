/**
 * The `ignoreMutation` policy shared by every React node view (#4315, #4353).
 *
 * ## The hazard
 *
 * `@tiptap/core`'s default `NodeView.ignoreMutation` carries a mobile-only
 * branch (`@tiptap/core@3.30.2`, its own upstream NodeView.ts — not a path
 * in this repo; the shipped copy we actually run is the bundled dist):
 *
 * ```js
 * if (this.dom.contains(mutation.target) && mutation.type === 'childList'
 *     && (isiOS() || isAndroid()) && this.editor.isFocused) {
 *   const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
 *   if (changedNodes.every((node) => node.isContentEditable)) return false  // do NOT ignore
 * }
 * ```
 *
 * On an iOS/Android user agent, **with the editor focused**, a `childList`
 * mutation anywhere inside the node view's `dom` — not merely inside
 * `contentDOM` — is read back as a user edit. A React node view rewrites its own
 * subtree on every render, so React's writes feed prosemirror-view's
 * `DOMObserver`, which flushes, which dispatches, which re-renders the node
 * view. The cycle never terminates: that is the freeze #4312/#4315 chased.
 * Desktop never reaches the branch and ignores everything outside `contentDOM`,
 * which is exactly why the bug was user-agent-gated and invisible locally.
 *
 * ## The fix
 *
 * Supplying an `ignoreMutation` option short-circuits **before** that branch
 * (tiptap consults `this.options.ignoreMutation` first), restoring the desktop
 * rule on every user agent: mutations inside `contentDOM` are real content edits
 * and must be read; everything else is the React component's own chrome and is
 * ignored.
 *
 * What that gives up is tiptap's mobile-IME workaround for text typed *outside*
 * `contentDOM`. No node view here has editable text outside its content hole, so
 * nothing is lost.
 *
 * ## Which node views need it — two short-circuits above the branch
 *
 * Not every React node view is exposed, and the reason is easy to miss because
 * it lives in the vendored file rather than here. tiptap's default opens with:
 *
 * ```js
 * ignoreMutation(mutation) {
 *   if (!this.dom || !this.contentDOM) return true                       // (1)
 *   if (typeof this.options.ignoreMutation === 'function') return this.options.ignoreMutation({ mutation })
 *   if (this.node.isLeaf || this.node.isAtom) return true                // (2)
 *   if (mutation.type === 'selection') return false
 *   // …the mobile branch…
 * ```
 *
 * (1) `ReactNodeView.contentDOM` returns `null` when `node.isLeaf`
 * (`@tiptap/react` only builds a `contentDOMElement` for a non-leaf node), so a
 * **leaf** node view is answered `true` — ignore everything — on the very first
 * line. (2) catches the remaining case, an **atom** that does declare content.
 * Either way the mobile branch is unreachable.
 *
 * `image`, `math_inline` and `math_block` are all leaf atoms (their payload is
 * an attribute, edited through a plain `<input>`), so all three are protected
 * twice over and none of them can freeze. `codeBlock` — neither leaf nor atom,
 * because React owns a real ProseMirror text hole — is the only React node view
 * in the app that reaches the branch, and the only one that needs this helper.
 *
 * Note that (1) sits ABOVE the `options.ignoreMutation` consultation: a leaf
 * node view never reads the option at all. Passing this helper to one would be
 * dead code, not defence in depth, which is why it is deliberately applied to
 * the exposed node view only.
 *
 * `node-view-mobile-freeze.test.ts` pins every link in that chain — the
 * leaf/atom classification of each call site, and the vendored short-circuits
 * they rely on, so a `@tiptap/core` bump that drops one reddens the suite
 * instead of silently re-arming the freeze.
 */

import type { ViewMutationRecord } from '@tiptap/pm/view'

/**
 * tiptap marks a React node view's content host with `data-node-view-content-react`
 * (`ReactNodeView`'s `contentDOMElement`). Matching on that attribute is the only
 * way to recognise the content hole from inside an `ignoreMutation` callback —
 * tiptap passes the callback `{ mutation }` and nothing else, so the node view's
 * own `contentDOM` reference is not in scope.
 */
const REACT_CONTENT_HOST_SELECTOR = '[data-node-view-content-react]'

/**
 * `ignoreMutation` for a React node view: read mutations inside the ProseMirror
 * content hole, ignore React's own chrome around it.
 *
 * @returns `true` when the mutation can safely be ignored, `false` when
 * prosemirror-view must re-read the selection / re-parse the range — matching
 * the sense of ProseMirror's `NodeView.ignoreMutation`.
 *
 * Nesting caveat: the content host is located with `closest()`, so for a node
 * view whose content can itself contain another React node view, the nearest
 * host may belong to the inner view. That is harmless — prosemirror-view routes
 * a mutation to the innermost node-view desc that contains it, so the inner
 * view's own `ignoreMutation` is the one consulted for its subtree — but it does
 * mean this helper answers "is the target inside *a* React content hole", not
 * "…inside *mine*".
 */
export function ignoreReactNodeViewChrome({ mutation }: { mutation: ViewMutationRecord }): boolean {
  // A selection change is never React's doing; hand it back so prosemirror
  // re-reads the selection (tiptap's default says the same).
  if (mutation.type === 'selection') return false

  const target = mutation.target
  const element = target instanceof Element ? target : target.parentElement
  const contentHost = element?.closest(REACT_CONTENT_HOST_SELECTOR) ?? null

  // Outside every content hole ⇒ React's own chrome (a toggle, a rendered
  // preview). Ignore it — this is the line the mobile branch got wrong.
  if (contentHost === null) return true

  // An attribute write on the host itself is React re-rendering the wrapper,
  // not a content edit (tiptap's default says the same).
  if (target === contentHost && mutation.type === 'attributes') return true

  // Inside the content hole ⇒ a real content edit; prosemirror must read it.
  return false
}
