/**
 * Tokeniser for the inline search filter syntax.
 *
 * Walks the input one character at a time and emits raw lexical
 * tokens. The classifier (`classify.ts`) is responsible for mapping
 * each raw token to a `FilterToken` (or to free-text).
 *
 * Quoting / boolean operator behaviour started as a port of
 * `src-tauri/agaric-store/src/fts/search.rs::tokenize_query` (so the parser doesn't
 * Accidentally pre-process FTS5 syntax), but deliberately diverges
 * on the closing-quote rule: this tokeniser is boundary-aware (a quote
 * only closes at a token boundary) because it drives chip projection +
 * caret autocomplete, whereas the Rust `tokenize_query` closes on the
 * first `"` (it only builds the FTS5 query string). The two roles differ,
 * so the divergence is intentional — do not "re-sync" them.
 */

/** A raw lexical token. */
export type RawToken =
  | { kind: 'word'; text: string; span: [number, number] }
  | { kind: 'quoted'; text: string; span: [number, number] }

/**
 * Split `input` into whitespace-delimited words and `"…"`-quoted
 * phrases. Whitespace is dropped; everything else is preserved.
 *
 * - A `"` at a token boundary opens a quoted phrase that extends until
 *   the next `"` (verbatim, including any internal whitespace). If no
 *   closing quote is found, the open quote is treated as part of the
 *   word that follows.
 * - A `"` mid-word (e.g. `prop:key="value with spaces"`) opens a
 *   phrase that extends across whitespace until a matching `"` at a
 *   token boundary — that lets prefix-glued quoted values survive as a
 *   single word for the classifier to parse (#152). If no matching
 *   close exists, the `"` is kept as a literal and the word ends at
 *   the next whitespace (e.g. `say"hello` still tokenises as one word).
 *
 * Spans are `[startCol, endCol)` over the original input in UTF-16
 * code units (compatible with `string.length`). The quote characters
 * are INCLUDED in the span of a `quoted` token so chip projection can
 * faithfully re-insert them on serialise.
 */
export function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  const n = input.length

  // Dev-only forward-progress guards (#3786): nothing else asserts that the
  // cursor strictly advances on every iteration of either `while` loop
  // below. In production code today it always does, but a future
  // regression (e.g. a flipped sign on a `close + 1`) would otherwise spin
  // forever in one of these synchronous loops — a hang that vitest's
  // `--testTimeout` cannot interrupt (a tight synchronous loop never
  // yields to the event loop), rather than a fast, legible red test.
  // `assertAdvanced` converts that hang into an immediate throw at the
  // exact point of the regression.
  //
  // Chosen over a bounded-iterations cap: it states the actual invariant
  // (the cursor must strictly increase) instead of an arbitrary bound, so
  // it fires immediately rather than after N wasted iterations, and it is
  // self-documenting at the call site. Kept dev-only, matching the
  // existing `import.meta.env.DEV` invariants elsewhere in this codebase
  // (e.g. `ConfirmDialog.tsx`, `popover-menu-item.tsx`) — false in
  // production builds, where `define` folds the condition to `false` and the
  // minifier drops the whole thing.
  //
  // MEASURED, not assumed: a real `vite build` of this repo (which minifies
  // with `oxc`, not esbuild — see `vite.config.ts`'s Track B note) contains
  // ZERO occurrences of `assertAdvanced`, `tokenize/outer`, `tokenize/word`
  // or `scan cursor failed` anywhere in the bundle. The per-iteration calls,
  // their string arguments AND the `prevOuter` / `prevInner` bookkeeping are
  // all eliminated — the production hot loop pays literally nothing.
  //
  // (An earlier revision of this comment claimed the call survived and cost
  // "a function call plus two integer comparisons per iteration". That was
  // inferred rather than checked, and it is false. If you change the
  // minifier or the shape of this guard, re-measure by grepping the built
  // bundle for those strings rather than reasoning about it.)
  //
  // This is a pure safety net either way: every branch below already
  // advances `i` for all valid input, so the guard never fires on correct
  // code.
  //
  // Say the residual risk out loud rather than leaving it inferable: being
  // dev-only means a regression that ships STILL FREEZES THE USER'S APP
  // forever — the guard protects the test runner and the dev build, not
  // production. That is the deliberate scope (#3786 is about a hang that
  // silently eats a CI run, because a synchronous `while` never yields so
  // vitest's `--testTimeout` cannot fire). If a hang is ever observed in a
  // shipped build, the fix is to drop the `DEV` condition, not to add a
  // cap: the check is two integer comparisons per iteration against a loop
  // that is already doing per-character string work, so making it
  // unconditional would not be measurable.
  let prevOuter = -1

  while (i < n) {
    assertAdvanced('tokenize/outer', prevOuter, i)
    prevOuter = i
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    const start = i
    if (ch === '"') {
      // Find a *closing* `"` that sits at a token boundary
      // (followed by whitespace or end-of-input). A `"` glued to more
      // text (e.g. `"a"b`) is not a clean phrase close, so we keep
      // scanning; if none qualifies, fall through to word-handling so
      // the stray quote degrades to a word instead of fragmenting the
      // rest of the query into a phantom phrase.
      const close = findCloseAtBoundary(input, i)
      if (close !== -1) {
        tokens.push({
          kind: 'quoted',
          text: input.slice(i, close + 1),
          span: [start, close + 1],
        })
        i = close + 1
        continue
      }
      // Unmatched quote — degrade to word.
    }
    // Word: consume until whitespace. A mid-word `"` (#152) opens an
    // embedded phrase that extends through whitespace until a matching
    // `"` at a token boundary, so `prop:key="v with spaces"` survives
    // as a single word.
    let prevInner = -1
    while (i < n) {
      assertAdvanced('tokenize/word', prevInner, i)
      prevInner = i
      const c = input[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break
      if (c === '"' && i > start) {
        const close = findCloseAtBoundary(input, i)
        if (close !== -1) {
          i = close + 1
          continue
        }
      }
      i++
    }
    tokens.push({ kind: 'word', text: input.slice(start, i), span: [start, i] })
  }
  return tokens
}

/**
 * Dev-only forward-progress assertion (#3786). Throws when `cur` fails to
 * strictly exceed `prev`, converting a would-be infinite synchronous loop
 * into an immediate, legible failure. Outside dev/test builds `define` folds
 * the condition to `false` and the minifier removes the call sites entirely
 * (verified against a real build — see the comment at the top of
 * {@link tokenize}), so this costs nothing in production. That comment also
 * covers why this is dev-only and why an invariant check was chosen over a
 * bounded-iterations cap.
 */
// Exported for tests ONLY. The guard fires only against code that is
// already broken, so no input to `tokenize` can reach it — which left the
// body a mutation survivor (deleting it failed no test). Testing it
// directly is what makes the guard itself covered rather than merely
// present.
export function assertAdvanced(where: string, prev: number, cur: number): void {
  // Deliberately unguarded (`import.meta.env.DEV`, not `import.meta.env?.DEV`),
  // unlike `src/lib/observability/config.ts`, which guards because THAT
  // module is written to tolerate being loaded outside Vite. This module
  // is not: `tokenize()` (and therefore this per-iteration call) is only
  // ever reached through the app bundle or the vitest/Stryker test
  // runners, both of which are Vite-plugin-driven and always populate
  // `import.meta.env`. That matches the unguarded precedent in
  // `src/lib/logger.ts`. If `tokenize.ts` is ever imported from a plain
  // Node context (no Vite/vitest in the loader chain), guard this the
  // same way `config.ts` does — don't assume it can't happen.
  if (import.meta.env.DEV && cur <= prev) {
    throw new Error(
      `tokenize(): scan cursor failed to advance at ${where} (was ${prev}, now ${cur}) — this would otherwise hang forever`,
    )
  }
}

/**
 * Given an opening `"` at index `open`, find the index of a matching
 * close `"` that sits at a token boundary (followed by whitespace or
 * end-of-input). Returns `-1` if no qualifying close exists.
 */
function findCloseAtBoundary(input: string, open: number): number {
  let close = input.indexOf('"', open + 1)
  while (close !== -1) {
    const after = input[close + 1]
    if (
      after === undefined ||
      after === ' ' ||
      after === '\t' ||
      after === '\n' ||
      after === '\r'
    ) {
      return close
    }
    close = input.indexOf('"', close + 1)
  }
  return -1
}
