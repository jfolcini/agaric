# Session 1203 — Deduplicate KaTeX (single copy for app + mermaid)

**Date:** 2026-07-23
**Branch:** `perf/katex-dedupe`
**Closes:** #2940

## Summary

`package.json` pinned `"katex": "0.17.0"` (exact) while mermaid requires `katex@^0.16.45`,
resolving its own nested `katex@0.16.47` (also pulled by `micromark-extension-math`). Since
`0.17.0` is outside `^0.16.45`, npm could not dedupe — it shipped **two** full KaTeX copies
(~258 kB duplicated) in the bundle, so rendering a math chip and a mermaid diagram downloaded
and parsed KaTeX twice.

## The fix (`package.json` + `package-lock.json` only)

Pin-align (not `overrides`): app pin `0.17.0 → 0.16.47` — the exact version mermaid already
resolves — so it satisfies mermaid's `^0.16.45` with zero forcing and npm hoists a single copy.

**Downgrade safety:** the app's only KaTeX API usage is `katex.renderToString(latex,
{ displayMode, throwOnError: false, errorColor })` in `src/components/rendering/KatexMath.tsx`
(lazily imported by the math mark + MathNodeView) — three long-standing public options, none
0.17-only. No `katex/contrib/*` plugins, no `defineFunction`/`__defineFunction`. The KaTeX
0.17.0 CHANGELOG lists exactly ONE change — an internal `defineFunction` typing/destructuring
tweak (the sole breaking change) — which the app never touches. So `KatexMath.tsx` is untouched
and the downgrade is behaviorally inert for this codebase.

## Verification

`npm ls katex` after: single `katex@0.16.47`, with mermaid + micromark-extension-math both
`deduped`. `npm run build`: exactly one KaTeX chunk (`katex-*.js`, 258,881 B) — confirmed via a
`KaTeX parse error` string search matching only that one chunk; mermaid's chunk dynamically
imports the shared katex chunk rather than embedding its own. `vitest src/components/rendering`
= 129 pass; mermaid tests (MermaidDiagram/error-leak/CodeBlockView) = 22 pass; `tsc -b --noEmit`
clean. Bundle-budget guard unaffected (no katex-specific tracked chunk). Adversarial review
independently confirmed the single-copy dedup, the CHANGELOG safety, and all green tests.
